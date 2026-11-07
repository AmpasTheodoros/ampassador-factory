import { newId } from "@aaf/core";
import type { Queryable } from "@aaf/database";

export type JobStatus = "queued" | "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled" | "dead";

export interface Job {
  id: string;
  workspaceId: string;
  type: string;
  status: JobStatus;
  idempotencyKey: string;
  correlationId: string;
  input: Record<string, unknown>;
  output: unknown;
  progress: number;
  progressNote: string | null;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  leaseUntil: string | null;
  lockedBy: string | null;
  approvalId: string | null;
  resumeState: { approvalId: string; approvalStatus: string } | null;
  error: string | null;
  cancelRequested: boolean;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EnqueueInput {
  type: string;
  input?: Record<string, unknown>;
  /** Same key => same job (no duplicate work), even across retries of the caller. */
  idempotencyKey: string;
  correlationId?: string;
  maxAttempts?: number;
  runAt?: Date;
  createdBy: string;
}

const iso = (d: Date) => d.toISOString();
const COLS = `id, workspace_id, type, status, idempotency_key, correlation_id, input, output, progress, progress_note, attempts, max_attempts, run_at, lease_until, locked_by, approval_id, resume_state, error, cancel_requested, created_by, created_at, started_at, finished_at`;

export async function logEvent(q: Queryable, ws: string, jobId: string, kind: string, detail: Record<string, unknown> = {}) {
  await q.query(`insert into job_events(job_id, workspace_id, kind, detail) values ($1,$2,$3,$4)`, [jobId, ws, kind, JSON.stringify(detail)]);
}

export async function enqueue(q: Queryable, ws: string, e: EnqueueInput): Promise<{ jobId: string; created: boolean }> {
  const id = newId();
  const r = await q.query<{ id: string }>(
    `insert into jobs(id, workspace_id, type, idempotency_key, correlation_id, input, max_attempts, run_at, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (workspace_id, idempotency_key) do nothing returning id`,
    [id, ws, e.type, e.idempotencyKey, e.correlationId ?? newId(), JSON.stringify(e.input ?? {}), e.maxAttempts ?? 3, iso(e.runAt ?? new Date()), e.createdBy],
  );
  if (r[0]) {
    await logEvent(q, ws, id, "enqueued", { type: e.type, by: e.createdBy });
    return { jobId: id, created: true };
  }
  const ex = await q.query<{ id: string }>(`select id from jobs where workspace_id=$1 and idempotency_key=$2`, [ws, e.idempotencyKey]);
  return { jobId: ex[0]!.id, created: false };
}

export async function getJob(q: Queryable, ws: string, id: string): Promise<Job | undefined> {
  return (await q.query<Job>(`select ${COLS} from jobs where workspace_id=$1 and id=$2`, [ws, id]))[0];
}
export async function listJobs(q: Queryable, ws: string, status?: JobStatus, limit = 100): Promise<Job[]> {
  return q.query<Job>(`select ${COLS} from jobs where workspace_id=$1 and ($2::text is null or status=$2) order by created_at desc limit $3`, [ws, status ?? null, limit]);
}
export async function jobEvents(q: Queryable, ws: string, jobId: string) {
  return q.query(`select id, kind, detail, created_at from job_events where workspace_id=$1 and job_id=$2 order by id`, [ws, jobId]);
}
export async function counts(q: Queryable, ws: string): Promise<Record<string, number>> {
  const r = await q.query<{ status: string; n: number }>(`select status, count(*)::int as n from jobs where workspace_id=$1 group by status`, [ws]);
  return Object.fromEntries(r.map((x) => [x.status, x.n]));
}

/**
 * Housekeeping before claiming:
 *  - queued jobs with a cancel request become cancelled
 *  - running jobs whose lease expired AND that are out of attempts become dead (no infinite crash loops)
 *  - waiting jobs whose approval reached a terminal state are re-queued with that outcome as resume state
 */
export async function sweep(q: Queryable, ws: string, now: Date): Promise<{ cancelled: number; dead: number; resumed: number }> {
  const t = iso(now);
  const cancelled = await q.query<{ id: string }>(`update jobs set status='cancelled', finished_at=$2::timestamptz, updated_at=$2::timestamptz where workspace_id=$1 and status in ('queued','waiting_approval') and cancel_requested returning id`, [ws, t]);
  for (const c of cancelled) await logEvent(q, ws, c.id, "cancelled", { while: "not running" });
  const dead = await q.query<{ id: string }>(`update jobs set status='dead', error=coalesce(error,'lease expired after final attempt'), finished_at=$2::timestamptz, updated_at=$2::timestamptz where workspace_id=$1 and status='running' and lease_until < $2::timestamptz and attempts >= max_attempts returning id`, [ws, t]);
  for (const d of dead) await logEvent(q, ws, d.id, "dead", { reason: "lease expired after final attempt" });
  const resumed = await q.query<{ id: string; status: string; approvalId: string }>(
    `update jobs j set status='queued', run_at=$2::timestamptz, updated_at=$2::timestamptz,
       resume_state = jsonb_build_object('approvalId', a.id, 'approvalStatus', a.status)
     from approvals a
     where j.workspace_id=$1 and j.status='waiting_approval' and j.approval_id = a.id and a.workspace_id = j.workspace_id
       and a.status in ('succeeded','failed','rejected','expired')
     returning j.id, a.status, a.id as approval_id`, [ws, t]);
  for (const r of resumed) await logEvent(q, ws, r.id, "resumed", { approvalStatus: r.status, approvalId: r.approvalId });
  return { cancelled: cancelled.length, dead: dead.length, resumed: resumed.length };
}

/** Leased claim. `for update skip locked` makes concurrent workers pick different jobs. */
export async function claimNext(q: Queryable, ws: string, workerId: string, leaseMs: number, now: Date): Promise<Job | undefined> {
  const t = iso(now);
  const lease = iso(new Date(now.getTime() + leaseMs));
  const r = await q.query<Job>(
    `update jobs set status='running', attempts=attempts+1, locked_by=$2, lease_until=$4::timestamptz,
        started_at=coalesce(started_at,$3::timestamptz), updated_at=$3::timestamptz, error=null
     where id = (
       select id from jobs where workspace_id=$1 and not cancel_requested
         and ((status='queued' and run_at <= $3::timestamptz) or (status='running' and lease_until < $3::timestamptz and attempts < max_attempts))
       order by run_at, created_at limit 1 for update skip locked)
     returning ${COLS}`, [ws, workerId, t, lease]);
  const job = r[0];
  if (job) await logEvent(q, ws, job.id, "started", { attempt: job.attempts, worker: workerId });
  return job;
}

export async function setProgress(q: Queryable, ws: string, id: string, pct: number, note?: string) {
  await q.query(`update jobs set progress=$3, progress_note=coalesce($4,progress_note), updated_at=now() where workspace_id=$1 and id=$2 and status='running'`, [ws, id, Math.max(0, Math.min(100, Math.round(pct))), note ?? null]);
}
export async function isCancelRequested(q: Queryable, ws: string, id: string): Promise<boolean> {
  return (await q.query<{ c: boolean }>(`select cancel_requested as c from jobs where workspace_id=$1 and id=$2`, [ws, id]))[0]?.c ?? false;
}
export async function succeed(q: Queryable, ws: string, id: string, output: unknown, now: Date) {
  await q.query(`update jobs set status='succeeded', output=$3, progress=100, lease_until=null, finished_at=$4::timestamptz, updated_at=$4::timestamptz, resume_state=null where workspace_id=$1 and id=$2`, [ws, id, JSON.stringify(output ?? null), iso(now)]);
  await logEvent(q, ws, id, "succeeded");
}
export async function waitForApproval(q: Queryable, ws: string, id: string, approvalId: string, now: Date) {
  await q.query(`update jobs set status='waiting_approval', approval_id=$3, lease_until=null, locked_by=null, updated_at=$4::timestamptz where workspace_id=$1 and id=$2`, [ws, id, approvalId, iso(now)]);
  await logEvent(q, ws, id, "waiting_approval", { approvalId });
}
export async function markCancelled(q: Queryable, ws: string, id: string, now: Date) {
  await q.query(`update jobs set status='cancelled', lease_until=null, finished_at=$3::timestamptz, updated_at=$3::timestamptz where workspace_id=$1 and id=$2`, [ws, id, iso(now)]);
  await logEvent(q, ws, id, "cancelled", { while: "running" });
}
/** Retry with exponential backoff, or dead-letter when attempts are exhausted / the error is permanent. */
export async function failAttempt(q: Queryable, ws: string, job: Pick<Job, "id" | "attempts" | "maxAttempts">, error: string, permanent: boolean, backoffBaseMs: number, now: Date): Promise<"retry" | "dead"> {
  const exhausted = permanent || job.attempts >= job.maxAttempts;
  if (exhausted) {
    await q.query(`update jobs set status='dead', error=$3, lease_until=null, finished_at=$4::timestamptz, updated_at=$4::timestamptz where workspace_id=$1 and id=$2`, [ws, job.id, error.slice(0, 500), iso(now)]);
    await logEvent(q, ws, job.id, "dead", { error: error.slice(0, 200), permanent });
    return "dead";
  }
  const delay = backoffBaseMs * 2 ** (job.attempts - 1);
  await q.query(`update jobs set status='queued', error=$3, lease_until=null, locked_by=null, run_at=$4::timestamptz, updated_at=$5::timestamptz where workspace_id=$1 and id=$2`, [ws, job.id, error.slice(0, 500), iso(new Date(now.getTime() + delay)), iso(now)]);
  await logEvent(q, ws, job.id, "retry_scheduled", { attempt: job.attempts, delayMs: delay, error: error.slice(0, 200) });
  return "retry";
}

/** User-facing: request cancellation. Queued jobs stop immediately at the next sweep; running jobs stop at their next check. */
export async function requestCancel(q: Queryable, ws: string, id: string, by: string): Promise<boolean> {
  const r = await q.query(`update jobs set cancel_requested=true, updated_at=now() where workspace_id=$1 and id=$2 and status in ('queued','running','waiting_approval') returning id`, [ws, id]);
  if (r.length) await logEvent(q, ws, id, "cancel_requested", { by });
  return r.length === 1;
}
/** Operator replay of a dead/failed/cancelled job: fresh attempts, same idempotency key and correlation id. */
export async function replay(q: Queryable, ws: string, id: string, by: string, now: Date): Promise<boolean> {
  const r = await q.query(`update jobs set status='queued', attempts=0, error=null, cancel_requested=false, resume_state=null, run_at=$3::timestamptz, finished_at=null, updated_at=$3::timestamptz where workspace_id=$1 and id=$2 and status in ('dead','failed','cancelled') returning id`, [ws, id, iso(now)]);
  if (r.length) await logEvent(q, ws, id, "replayed", { by });
  return r.length === 1;
}
