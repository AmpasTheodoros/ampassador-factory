import { DomainError } from "@aaf/core";
import { Store, type Database } from "@aaf/database";
import * as Q from "./queue";
import type { Job } from "./queue";

export class JobCancelled extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelled";
  }
}

export interface JobContext<S = unknown> {
  job: Job;
  workspaceId: string;
  correlationId: string;
  store: Store;
  /** Present when the job was parked on an approval and that approval has now reached a terminal state. */
  resume?: { approvalId: string; approvalStatus: string };
  progress(pct: number, note?: string): Promise<void>;
  /** Cooperative cancellation: handlers call this between steps. */
  checkCancelled(): Promise<void>;
  services: S;
}
export type Outcome = { kind: "done"; output?: unknown } | { kind: "wait_approval"; approvalId: string };
export type JobHandler<S = unknown> = (ctx: JobContext<S>) => Promise<Outcome>;
export type Handlers<S = unknown> = Record<string, JobHandler<S>>;

export interface RunOptions<S> {
  workerId: string;
  leaseMs?: number;
  backoffBaseMs?: number;
  now?: () => Date;
  maxJobs?: number;
  /** Builds per-job services (gateway, model router...) bound to the job's store. May expose an async `after` hook that runs OUTSIDE the job transaction (e.g. cost flush). */
  buildServices?: (store: Store, job: Job) => { services: S; after?: () => Promise<void> };
}

export interface RunSummary {
  ran: number;
  succeeded: number;
  waiting: number;
  retried: number;
  dead: number;
  cancelled: number;
  swept: { cancelled: number; dead: number; resumed: number };
  /** Earliest time something needs attention again (a retry backoff, an expiring lease). The scheduler wakes the workspace then. */
  nextDueAt: string | null;
}

/**
 * Executes due jobs of ONE workspace. Every transaction runs as the `aaf_service` role pinned to that workspace,
 * so a bug here cannot read or write another tenant's rows.
 *
 * Atomicity: claim (tx 1) -> handler + result (tx 2, rolled back as a unit if the handler throws) -> failure
 * bookkeeping (tx 3). A crash between tx 1 and tx 2 leaves a leased 'running' job that is reclaimed when the lease expires.
 * Handlers must be idempotent with respect to external effects (use the job id / approval id as the idempotency key).
 */
export async function runWorkspace<S = unknown>(database: Database, ws: string, handlers: Handlers<S>, opts: RunOptions<S>): Promise<RunSummary> {
  const now = opts.now ?? (() => new Date());
  const lease = opts.leaseMs ?? 60_000;
  const base = opts.backoffBaseMs ?? 2_000;
  const sum: RunSummary = { ran: 0, succeeded: 0, waiting: 0, retried: 0, dead: 0, cancelled: 0, swept: { cancelled: 0, dead: 0, resumed: 0 }, nextDueAt: null };
  const svc = <T>(fn: (store: Store) => Promise<T>) => database.run({ kind: "service", workspaceId: ws, reason: `jobs:${opts.workerId}` }, (q) => fn(new Store(q)));

  for (let i = 0; i < (opts.maxJobs ?? 25); i++) {
    const claimed = await svc(async (store) => {
      const sw = await Q.sweep(store.db, ws, now());
      sum.swept.cancelled += sw.cancelled; sum.swept.dead += sw.dead; sum.swept.resumed += sw.resumed;
      return Q.claimNext(store.db, ws, opts.workerId, lease, now());
    });
    if (!claimed) break;
    sum.ran++;
    const job = claimed;
    const handler = handlers[job.type];
    let after: (() => Promise<void>) | undefined;
    try {
      if (!handler) throw new DomainError("permanent_no_handler", `No handler registered for job type ${job.type}`);
      const outcome = await svc(async (store) => {
        const built = opts.buildServices?.(store, job);
        after = built?.after;
        const ctx: JobContext<S> = {
          job, workspaceId: ws, correlationId: job.correlationId, store, resume: job.resumeState ?? undefined,
          services: (built?.services ?? ({} as S)),
          progress: (pct, note) => Q.setProgress(store.db, ws, job.id, pct, note),
          checkCancelled: async () => { if (await Q.isCancelRequested(store.db, ws, job.id)) throw new JobCancelled(); },
        };
        await ctx.checkCancelled();
        const out = await handler(ctx);
        if (out.kind === "done") await Q.succeed(store.db, ws, job.id, out.output, now());
        else await Q.waitForApproval(store.db, ws, job.id, out.approvalId, now());
        await store.audit(ws, `job:${job.type}`, `job.${out.kind === "done" ? "succeeded" : "waiting_approval"}`, "job", job.id, { correlationId: job.correlationId });
        return out;
      });
      if (outcome.kind === "done") sum.succeeded++; else sum.waiting++;
    } catch (e) {
      if (e instanceof JobCancelled) {
        await svc((store) => Q.markCancelled(store.db, ws, job.id, now()));
        sum.cancelled++;
      } else {
        const permanent = e instanceof DomainError && e.code.startsWith("permanent");
        const msg = e instanceof Error ? e.message : String(e);
        const r = await svc(async (store) => {
          const res = await Q.failAttempt(store.db, ws, job, msg, permanent, base, now());
          await store.audit(ws, `job:${job.type}`, res === "dead" ? "job.dead" : "job.retry_scheduled", "job", job.id, { correlationId: job.correlationId, attempt: job.attempts });
          return res;
        });
        if (r === "dead") sum.dead++; else sum.retried++;
      }
    } finally {
      // runs after the job transaction has ended (committed OR rolled back), so e.g. model spend is never lost
      if (after) await after().catch(() => {});
    }
  }
  sum.nextDueAt = await svc(async (store) => {
    const r = await store.db.query<{ t: string | null }>(
      `select min(t)::text as t from (select run_at as t from jobs where workspace_id=$1 and status='queued' and run_at > $2::timestamptz union all select lease_until from jobs where workspace_id=$1 and status='running') x`, [ws, now().toISOString()]);
    return r[0]?.t ? new Date(r[0].t).toISOString() : null;
  });
  return sum;
}
