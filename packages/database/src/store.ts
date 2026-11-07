import { newId, type EventEnvelope, type ApprovalStatus } from "@aaf/core";
import type { Queryable, Row } from "./db";

/** Every method takes workspaceId and scopes by it: app-level isolation on top of RLS. */
export class Store {
  constructor(public readonly db: Queryable) {}

  async ensureWorkspace(id: string, name: string, ownerUserId: string, kind: "personal" | "client" = "personal") {
    await this.db.query(`insert into workspaces(id,name,kind) values ($1,$2,$3) on conflict do nothing`, [id, name, kind]);
    await this.db.query(`insert into memberships(workspace_id,user_id,role) values ($1,$2,'owner') on conflict do nothing`, [
      id,
      ownerUserId,
    ]);
  }

  async getWorkspace(id: string) {
    return (
      await this.db.query(`select id,name,kind,data_policy,monthly_budget_eur::float8 as monthly_budget_eur from workspaces where id=$1`, [
        id,
      ])
    )[0];
  }

  // ---- events / inbox
  async insertEvent(ev: EventEnvelope, isDemo = false): Promise<{ inserted: boolean; id: string }> {
    const r = await this.db.query<{ id: string }>(
      `insert into source_events(id,workspace_id,source,external_id,type,occurred_at,received_at,correlation_id,payload_version,payload,dedupe_key,is_demo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (workspace_id,dedupe_key) do nothing returning id`,
      [
        ev.id,
        ev.workspaceId,
        ev.source,
        ev.externalId ?? null,
        ev.type,
        ev.occurredAt,
        ev.receivedAt,
        ev.correlationId,
        ev.payloadVersion,
        JSON.stringify(ev.payload),
        ev.dedupeKey,
        isDemo,
      ],
    );
    if (r[0]) return { inserted: true, id: r[0].id };
    const ex = await this.db.query<{ id: string }>(`select id from source_events where workspace_id=$1 and dedupe_key=$2`, [
      ev.workspaceId,
      ev.dedupeKey,
    ]);
    return { inserted: false, id: ex[0]!.id };
  }
  async getEvent(ws: string, id: string) {
    return (await this.db.query(`select * from source_events where workspace_id=$1 and id=$2`, [ws, id]))[0];
  }

  async createInboxItem(
    ws: string,
    i: { eventId: string; title: string; summary?: string; contactName?: string; contactEmail?: string; isDemo?: boolean },
  ) {
    const id = newId();
    await this.db.query(
      `insert into inbox_items(id,workspace_id,event_id,title,summary,contact_name,contact_email,is_demo) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, ws, i.eventId, i.title, i.summary ?? null, i.contactName ?? null, i.contactEmail ?? null, i.isDemo ?? false],
    );
    return id;
  }
  async inboxItemForEvent(ws: string, eventId: string) {
    return (await this.db.query(`select * from inbox_items where workspace_id=$1 and event_id=$2`, [ws, eventId]))[0];
  }
  async listInbox(ws: string) {
    return this.db.query(`select * from inbox_items where workspace_id=$1 order by created_at desc limit 200`, [ws]);
  }
  async getInboxItem(ws: string, id: string) {
    return (
      await this.db.query(
        `select i.*, e.payload as event_payload, e.source as event_source, e.occurred_at as event_occurred_at from inbox_items i join source_events e on e.id=i.event_id where i.workspace_id=$1 and i.id=$2`,
        [ws, id],
      )
    )[0];
  }
  async markInbox(ws: string, id: string, patch: { intent?: string; actionClass?: string; status?: string }) {
    await this.db.query(
      `update inbox_items set intent=coalesce($3,intent), action_class=coalesce($4,action_class), status=coalesce($5,status) where workspace_id=$1 and id=$2`,
      [ws, id, patch.intent ?? null, patch.actionClass ?? null, patch.status ?? null],
    );
  }

  // ---- recommendations
  async insertRecommendation(
    ws: string,
    r: {
      inboxItemId?: string;
      actionClass: string;
      title: string;
      why: unknown;
      confidence: number;
      urgency: number;
      impact: number;
      effort: number;
      score: number;
      provenance: unknown;
      isDemo?: boolean;
    },
  ) {
    const id = newId();
    await this.db.query(
      `insert into action_recommendations(id,workspace_id,inbox_item_id,action_class,title,why,confidence,urgency,impact,effort,score,provenance,is_demo)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        ws,
        r.inboxItemId ?? null,
        r.actionClass,
        r.title,
        JSON.stringify(r.why),
        r.confidence,
        r.urgency,
        r.impact,
        r.effort,
        r.score,
        JSON.stringify(r.provenance),
        r.isDemo ?? false,
      ],
    );
    return id;
  }
  async listRecommendations(ws: string, limit = 50) {
    return this.db.query(
      `select id,inbox_item_id,action_class,title,why,confidence::float8 as confidence,urgency,impact,effort,score::float8 as score,provenance,is_demo,created_at
       from action_recommendations where workspace_id=$1 order by score desc, created_at desc limit $2`,
      [ws, limit],
    );
  }
  async recommendationForInbox(ws: string, inboxItemId: string) {
    return (
      await this.db.query(
        `select * from action_recommendations where workspace_id=$1 and inbox_item_id=$2 order by created_at desc limit 1`,
        [ws, inboxItemId],
      )
    )[0];
  }

  // ---- tasks
  async createTask(ws: string, t: { title: string; dueAt?: string; sourceRef?: string; isDemo?: boolean }) {
    const id = newId();
    await this.db.query(`insert into tasks(id,workspace_id,title,due_at,source_ref,is_demo) values ($1,$2,$3,$4,$5,$6)`, [
      id,
      ws,
      t.title,
      t.dueAt ?? null,
      t.sourceRef ?? null,
      t.isDemo ?? false,
    ]);
    return id;
  }
  async listTasks(ws: string, status?: string) {
    return this.db.query(
      `select * from tasks where workspace_id=$1 and ($2::text is null or status=$2) order by due_at nulls last, created_at desc`,
      [ws, status ?? null],
    );
  }
  async setTaskStatus(ws: string, id: string, status: "open" | "done" | "cancelled") {
    await this.db.query(`update tasks set status=$3 where workspace_id=$1 and id=$2`, [ws, id, status]);
  }

  // ---- approvals
  async insertApproval(a: {
    id: string;
    workspaceId: string;
    toolId: string;
    riskTier: string;
    payload: unknown;
    payloadHash: string;
    status: ApprovalStatus;
    summary: string;
    sourceContext: unknown;
    requestedBy: string;
    expiresAt: string;
    idempotencyKey: string;
  }): Promise<{ id: string; created: boolean }> {
    const r = await this.db.query<{ id: string }>(
      `insert into approvals(id,workspace_id,tool_id,risk_tier,payload,payload_hash,status,summary,source_context,requested_by,expires_at,idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (workspace_id,idempotency_key) do nothing returning id`,
      [
        a.id,
        a.workspaceId,
        a.toolId,
        a.riskTier,
        JSON.stringify(a.payload),
        a.payloadHash,
        a.status,
        a.summary,
        JSON.stringify(a.sourceContext),
        a.requestedBy,
        a.expiresAt,
        a.idempotencyKey,
      ],
    );
    if (r[0]) return { id: a.id, created: true };
    const ex = await this.db.query<{ id: string }>(`select id from approvals where workspace_id=$1 and idempotency_key=$2`, [
      a.workspaceId,
      a.idempotencyKey,
    ]);
    return { id: ex[0]!.id, created: false };
  }
  async getApproval(ws: string, id: string) {
    return (await this.db.query(`select * from approvals where workspace_id=$1 and id=$2`, [ws, id]))[0];
  }
  async listApprovals(ws: string, status?: string) {
    return this.db.query(
      `select * from approvals where workspace_id=$1 and ($2::text is null or status=$2) order by created_at desc limit 200`,
      [ws, status ?? null],
    );
  }
  /** Compare-and-set status transition; returns false if the row was not in `from`. */
  async transitionApproval(
    ws: string,
    id: string,
    from: ApprovalStatus | ApprovalStatus[],
    to: ApprovalStatus,
    extra: { decidedBy?: string; note?: string } = {},
  ): Promise<boolean> {
    const froms = Array.isArray(from) ? from : [from];
    const r = await this.db.query(
      `update approvals set status=$4, executing_at=case when $4='executing' then now() else executing_at end, decided_by=coalesce($5,decided_by), decided_at=case when $5::text is null then decided_at else now() end, decision_note=coalesce($6,decision_note)
       where workspace_id=$1 and id=$2 and status = any($3::text[]) returning id`,
      [ws, id, froms, to, extra.decidedBy ?? null, extra.note ?? null],
    );
    return r.length === 1;
  }
  async insertReceipt(ws: string, approvalId: string, attempt: number, ok: boolean, result: unknown, error: string | null, by: string) {
    await this.db.query(
      `insert into action_execution_receipts(id,workspace_id,approval_id,attempt,ok,result,error,executed_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), ws, approvalId, attempt, ok, result === undefined ? null : JSON.stringify(result), error, by],
    );
  }
  async listReceipts(ws: string, approvalId: string) {
    return this.db.query(`select * from action_execution_receipts where workspace_id=$1 and approval_id=$2 order by attempt`, [
      ws,
      approvalId,
    ]);
  }

  // ---- tool calls / audit / cost / runs
  async insertToolCall(
    ws: string,
    c: { toolId: string; riskTier: string; actor: string; outcome: string; inputHash: string; detail?: string; durationMs?: number },
  ) {
    await this.db.query(
      `insert into tool_calls(id,workspace_id,tool_id,risk_tier,actor,outcome,input_hash,detail,duration_ms) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId(), ws, c.toolId, c.riskTier, c.actor, c.outcome, c.inputHash, c.detail ?? null, c.durationMs ?? null],
    );
  }
  async listToolCalls(ws: string, limit = 100) {
    return this.db.query(`select * from tool_calls where workspace_id=$1 order by created_at desc limit $2`, [ws, limit]);
  }
  async audit(ws: string, actor: string, action: string, entity: string, entityId?: string, detail: unknown = {}) {
    await this.db.query(`insert into audit_log(workspace_id,actor,action,entity,entity_id,detail) values ($1,$2,$3,$4,$5,$6)`, [
      ws,
      actor,
      action,
      entity,
      entityId ?? null,
      JSON.stringify(detail),
    ]);
  }
  async listAudit(ws: string, entity?: string, entityId?: string, limit = 200) {
    return this.db.query(
      `select * from audit_log where workspace_id=$1 and ($2::text is null or entity=$2) and ($3::text is null or entity_id=$3) order by id desc limit $4`,
      [ws, entity ?? null, entityId ?? null, limit],
    );
  }
  async addCost(
    ws: string,
    c: { provider: string; model?: string; tokensIn?: number; tokensOut?: number; costEur: number; runId?: string },
  ) {
    await this.db.query(
      `insert into cost_events(id,workspace_id,run_id,provider,model,tokens_in,tokens_out,cost_eur) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId(), ws, c.runId ?? null, c.provider, c.model ?? null, c.tokensIn ?? 0, c.tokensOut ?? 0, c.costEur],
    );
  }
  async monthSpendEur(ws: string): Promise<number> {
    const r = await this.db.query<{ s: number }>(
      `select coalesce(sum(cost_eur),0)::float8 as s from cost_events where workspace_id=$1 and created_at >= date_trunc('month', now())`,
      [ws],
    );
    return r[0]?.s ?? 0;
  }

  async costSummary(
    ws: string,
  ): Promise<{ provider: string; model: string | null; calls: number; tokensIn: number; tokensOut: number; costEur: number }[]> {
    return this.db.query(
      `select provider, model, count(*)::int as calls, coalesce(sum(tokens_in),0)::int as tokens_in, coalesce(sum(tokens_out),0)::int as tokens_out, coalesce(sum(cost_eur),0)::float8 as cost_eur
      from cost_events where workspace_id=$1 and created_at >= date_trunc('month', now()) group by provider, model order by cost_eur desc`,
      [ws],
    );
  }
  async toolCallCounts(ws: string): Promise<Record<string, number>> {
    const r = await this.db.query<{ outcome: string; n: number }>(
      `select outcome, count(*)::int as n from tool_calls where workspace_id=$1 group by outcome`,
      [ws],
    );
    return Object.fromEntries(r.map((x) => [x.outcome, x.n]));
  }
  async createRun(ws: string, workflow: string, input: unknown, correlationId?: string) {
    const id = newId();
    await this.db.query(
      `insert into workflow_runs(id,workspace_id,workflow,status,correlation_id,input) values ($1,$2,$3,'queued',$4,$5)`,
      [id, ws, workflow, correlationId ?? null, JSON.stringify(input ?? {})],
    );
    return id;
  }
  async updateRun(ws: string, id: string, patch: { status: string; output?: unknown; error?: string }) {
    await this.db.query(
      `update workflow_runs set status=$3, output=coalesce($4,output), error=coalesce($5,error), attempts=attempts + (case when $3='running' then 1 else 0 end),
       started_at=case when $3='running' then now() else started_at end, finished_at=case when $3 in ('succeeded','failed','cancelled') then now() else finished_at end
       where workspace_id=$1 and id=$2`,
      [ws, id, patch.status, patch.output === undefined ? null : JSON.stringify(patch.output), patch.error ?? null],
    );
  }
  async listRuns(ws: string, limit = 50) {
    return this.db.query(`select * from workflow_runs where workspace_id=$1 order by created_at desc limit $2`, [ws, limit]);
  }

  // ---- identity / tenancy (run as the verified user; roles always come from `memberships`, never from token metadata)
  async provisionWorkspace(name: string): Promise<string> {
    const r = await this.db.query<{ appProvisionWorkspace: string }>(`select app_provision_workspace($1)`, [name]);
    return r[0]!.appProvisionWorkspace;
  }
  async memberRole(ws: string, userId: string): Promise<"owner" | "admin" | "member" | "viewer" | null> {
    const r = await this.db.query<{ role: "owner" | "admin" | "member" | "viewer" }>(
      `select role from memberships where workspace_id=$1 and user_id=$2`,
      [ws, userId],
    );
    return r[0]?.role ?? null;
  }
  async firstWorkspaceFor(userId: string): Promise<{ id: string; role: string } | null> {
    const r = await this.db.query<{ workspaceId: string; role: string }>(
      `select workspace_id, role from memberships where user_id=$1 order by role, workspace_id limit 1`,
      [userId],
    );
    return r[0] ? { id: r[0].workspaceId, role: r[0].role } : null;
  }
  /** Distributed fixed-window limiter; true = allowed. */
  async rateHit(key: string, max: number, windowSeconds: number): Promise<boolean> {
    const r = await this.db.query<{ appRateHit: boolean }>(`select app_rate_hit($1,$2,$3)`, [key, max, windowSeconds]);
    return r[0]!.appRateHit;
  }

  /** Read-only limiter check (does not count). true = still under the limit. */
  async rateCheck(key: string, max: number, windowSeconds: number): Promise<boolean> {
    const r = await this.db.query<{ appRatePeek: boolean }>(`select app_rate_peek($1,$2,$3)`, [key, max, windowSeconds]);
    return r[0]!.appRatePeek;
  }

  async upsertConnection(ws: string, connector: string, status: string, detail: string, scopes: string[] = []) {
    await this.db.query(
      `insert into integration_connections(id,workspace_id,connector,status,scopes,detail) values ($1,$2,$3,$4,$5,$6)
       on conflict (workspace_id,connector) do update set status=excluded.status, detail=excluded.detail, scopes=excluded.scopes, updated_at=now()`,
      [newId(), ws, connector, status, scopes, detail],
    );
  }
  /** Insert only if absent; never overwrites a status established by a health check. */
  async ensureConnection(ws: string, connector: string, status: string, detail: string) {
    await this.db.query(
      `insert into integration_connections(id,workspace_id,connector,status,scopes,detail) values ($1,$2,$3,$4,'{}',$5) on conflict (workspace_id,connector) do nothing`,
      [newId(), ws, connector, status, detail],
    );
  }
  async listConnections(ws: string): Promise<Row[]> {
    return this.db.query(`select * from integration_connections where workspace_id=$1 order by connector`, [ws]);
  }
}
