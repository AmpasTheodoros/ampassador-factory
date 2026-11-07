import { z, type ZodType } from "zod";
import { DomainError, newId, payloadHash, type RiskTier } from "@aaf/core";
import type { Store } from "@aaf/database";

export type ApprovalPolicy = "never" | "configurable" | "always" | "always_double";

export interface Actor {
  id: string;
  kind: "agent" | "user" | "system";
}
export interface ToolContext {
  workspaceId: string;
  store: Store;
  actor: Actor;
  /** Pass to the connector so a retried call cannot double-send. */
  idempotencyKey: string;
}

export interface ToolDef<I = any, O = any> {
  toolId: string;
  description: string;
  connector: string; // "internal" or a connector id
  requiredScopes: string[];
  riskTier: RiskTier;
  idempotency: "natural" | "key_required";
  rateLimitPerMin: number;
  approvalPolicy: ApprovalPolicy;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  timeoutMs: number;
  retry: { max: number; backoffMs: number };
  auditFields: string[]; // input fields copied to the audit log (everything else is hash-only)
  summarize(input: I): string;
  execute(ctx: ToolContext, input: I): Promise<O>;
}

export type InvokeResult =
  | { status: "executed"; output: unknown }
  | { status: "queued_for_approval"; approvalId: string; created: boolean }
  | { status: "denied"; reason: string; code: "unknown_tool" | "invalid_input" | "missing_scope" | "needs_connection" | "rate_limited" | "budget_exceeded" | "approval_required" };

export interface GatewayOptions {
  /** Approval validity window. */
  approvalTtlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const INTERNAL_SCOPES = ["tasks:write", "drafts:write", "exports:write", "inbox:read", "network:read_local"];

export class ToolGateway {
  private tools = new Map<string, ToolDef>();
  private hits = new Map<string, number[]>();
  constructor(private store: Store, tools: ToolDef[], private opts: GatewayOptions = {}) {
    for (const t of tools) {
      if (this.tools.has(t.toolId)) throw new Error(`duplicate tool ${t.toolId}`);
      this.tools.set(t.toolId, t);
    }
  }
  private now = () => (this.opts.now ?? Date.now)();
  private sleep = (ms: number) => (this.opts.sleep ?? ((m) => new Promise<void>((r) => setTimeout(r, m))))(ms);

  list(): ToolDef[] {
    return [...this.tools.values()];
  }
  get(id: string) {
    return this.tools.get(id);
  }

  /** Scopes = internal built-ins + scopes of connected connectors. */
  async scopesFor(ws: string): Promise<{ scopes: Set<string>; connected: Set<string> }> {
    const conns = await this.store.listConnections(ws);
    const scopes = new Set(INTERNAL_SCOPES);
    const connected = new Set<string>(["internal"]);
    for (const c of conns) {
      if (c["status"] === "connected") {
        connected.add(c["connector"] as string);
        for (const s of c["scopes"] as string[]) scopes.add(s);
      }
    }
    return { scopes, connected };
  }

  private async precheck(ws: string, tool: ToolDef): Promise<InvokeResult | null> {
    const { scopes, connected } = await this.scopesFor(ws);
    if (!connected.has(tool.connector))
      return { status: "denied", code: "needs_connection", reason: `Connector "${tool.connector}" is not connected` };
    const missing = tool.requiredScopes.filter((s) => !scopes.has(s));
    if (missing.length) return { status: "denied", code: "missing_scope", reason: `Missing scopes: ${missing.join(", ")}` };
    return null;
  }

  private rateOk(ws: string, tool: ToolDef): boolean {
    const k = `${ws}:${tool.toolId}`;
    const t = this.now();
    const arr = (this.hits.get(k) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= tool.rateLimitPerMin) {
      this.hits.set(k, arr);
      return false;
    }
    arr.push(t);
    this.hits.set(k, arr);
    return true;
  }

  async invoke(req: { workspaceId: string; actor: Actor; toolId: string; input: unknown; sourceContext?: Record<string, unknown>; idempotencyKey?: string }): Promise<InvokeResult> {
    const ws = req.workspaceId;
    const tool = this.tools.get(req.toolId);
    const inHash = payloadHash(req.input ?? null);
    const log = async (outcome: "executed" | "queued_for_approval" | "denied" | "failed", detail?: string, ms?: number) =>
      this.store.insertToolCall(ws, { toolId: req.toolId, riskTier: tool?.riskTier ?? "read", actor: `${req.actor.kind}:${req.actor.id}`, outcome, inputHash: inHash, detail, durationMs: ms });
    const deny = async (code: Extract<InvokeResult, { status: "denied" }>["code"], reason: string): Promise<InvokeResult> => {
      await log("denied", `${code}: ${reason}`);
      return { status: "denied", code, reason };
    };
    if (!tool) return deny("unknown_tool", `Unknown tool ${req.toolId}`);
    const parsed = tool.inputSchema.safeParse(req.input);
    if (!parsed.success) return deny("invalid_input", z.prettifyError(parsed.error));
    const pre = await this.precheck(ws, tool);
    if (pre && pre.status === "denied") return deny(pre.code, pre.reason);
    if (!this.rateOk(ws, tool)) return deny("rate_limited", `Rate limit ${tool.rateLimitPerMin}/min exceeded`);

    const needsApproval = tool.riskTier === "external_communication" || tool.riskTier === "financial_or_irreversible" || tool.approvalPolicy === "always" || tool.approvalPolicy === "always_double";
    if (needsApproval) {
      const key = req.idempotencyKey ?? `${tool.toolId}:${inHash}`;
      const id = newId();
      const ttl = this.opts.approvalTtlMs ?? 24 * 3600_000;
      const r = await this.store.insertApproval({
        id, workspaceId: ws, toolId: tool.toolId, riskTier: tool.riskTier, payload: parsed.data, payloadHash: payloadHash(parsed.data),
        status: "awaiting_approval", summary: tool.summarize(parsed.data), sourceContext: req.sourceContext ?? {},
        requestedBy: `${req.actor.kind}:${req.actor.id}`, expiresAt: new Date(this.now() + ttl).toISOString(), idempotencyKey: key,
      });
      if (r.created) await this.store.audit(ws, `${req.actor.kind}:${req.actor.id}`, "approval.requested", "approval", r.id, { toolId: tool.toolId, hash: payloadHash(parsed.data) });
      await log("queued_for_approval", `approval ${r.id}`);
      return { status: "queued_for_approval", approvalId: r.id, created: r.created };
    }

    const started = this.now();
    try {
      const out = await this.runWithTimeout(tool, { workspaceId: ws, store: this.store, actor: req.actor, idempotencyKey: req.idempotencyKey ?? newId() }, parsed.data);
      await log("executed", undefined, this.now() - started);
      await this.store.audit(ws, `${req.actor.kind}:${req.actor.id}`, "tool.executed", "tool", tool.toolId, pick(parsed.data, tool.auditFields));
      return { status: "executed", output: out };
    } catch (e) {
      await log("failed", errMsg(e), this.now() - started);
      throw e;
    }
  }

  private async runWithTimeout(tool: ToolDef, ctx: ToolContext, input: unknown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        tool.execute(ctx, input),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new DomainError("timeout", `${tool.toolId} timed out after ${tool.timeoutMs}ms`)), tool.timeoutMs);
        }),
      ]);
      return tool.outputSchema.parse(out);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ approvals

  async expireStale(ws: string): Promise<number> {
    const rows = await this.store.db.query<{ id: string }>(
      `update approvals set status='expired' where workspace_id=$1 and status in ('awaiting_approval','approved') and expires_at < $2::timestamptz returning id`,
      [ws, new Date(this.now()).toISOString()],
    );
    for (const r of rows) await this.store.audit(ws, "system", "approval.expired", "approval", r.id);
    return rows.length;
  }

  /** Human decision. Only owner/admin; financial tier needs the payload hash echoed back as second confirmation. */
  async decide(ws: string, approvalId: string, decision: "approve" | "reject", user: { id: string; role: string }, opts: { note?: string; confirmHash?: string } = {}) {
    if (!["owner", "admin"].includes(user.role)) throw new DomainError("forbidden", "Only owner/admin may decide approvals");
    await this.expireStale(ws);
    const a = await this.store.getApproval(ws, approvalId);
    if (!a) throw new DomainError("not_found", "Approval not found");
    if (a["status"] !== "awaiting_approval") throw new DomainError("bad_state", `Approval is ${a["status"]}, not awaiting_approval`);
    if (decision === "approve") {
      const tool = this.tools.get(a["toolId"] as string);
      if (tool?.approvalPolicy === "always_double" || a["riskTier"] === "financial_or_irreversible") {
        if (opts.confirmHash !== a["payloadHash"]) throw new DomainError("confirmation_required", "Second confirmation required: pass the payload hash");
      }
    }
    const ok = await this.store.transitionApproval(ws, approvalId, "awaiting_approval", decision === "approve" ? "approved" : "rejected", { decidedBy: user.id, note: opts.note });
    if (!ok) throw new DomainError("bad_state", "Approval changed concurrently");
    await this.store.audit(ws, `user:${user.id}`, `approval.${decision === "approve" ? "approved" : "rejected"}`, "approval", approvalId, { note: opts.note ?? null, hash: a["payloadHash"] });
  }

  /** Execute an approved action. Revalidates hash, expiry, scopes and input schema. Bounded retries with exponential backoff. */
  async execute(ws: string, approvalId: string, executor: Actor = { id: "executor", kind: "system" }) {
    await this.expireStale(ws);
    const a = await this.store.getApproval(ws, approvalId);
    if (!a) throw new DomainError("not_found", "Approval not found");
    const claimed = await this.store.transitionApproval(ws, approvalId, "approved", "executing");
    if (!claimed) throw new DomainError("not_approved", `Cannot execute: approval is ${a["status"]}`);
    const actorStr = `${executor.kind}:${executor.id}`;
    const fail = async (msg: string, attempt: number) => {
      await this.store.insertReceipt(ws, approvalId, attempt, false, undefined, msg, actorStr);
      await this.store.transitionApproval(ws, approvalId, "executing", "failed");
      await this.store.audit(ws, actorStr, "approval.failed", "approval", approvalId, { error: msg });
      return { ok: false as const, error: msg };
    };
    const prev = await this.store.listReceipts(ws, approvalId);
    let attempt = prev.length;

    const tool = this.tools.get(a["toolId"] as string);
    if (!tool) return fail(`Unknown tool ${a["toolId"]}`, ++attempt);
    // revalidation: payload must still hash to what the human approved
    if (payloadHash(a["payload"]) !== a["payloadHash"]) {
      await this.store.audit(ws, "system", "approval.tamper_detected", "approval", approvalId);
      return fail("Payload hash mismatch: payload changed after approval", ++attempt);
    }
    const parsed = tool.inputSchema.safeParse(a["payload"]);
    if (!parsed.success) return fail("Stored payload no longer valid for tool schema", ++attempt);
    const pre = await this.precheck(ws, tool);
    if (pre && pre.status === "denied") return fail(`Authorization revalidation failed: ${pre.reason}`, ++attempt);

    let lastErr = "";
    for (let i = 0; i < Math.max(1, tool.retry.max); i++) {
      attempt++;
      try {
        const out = await this.runWithTimeout(tool, { workspaceId: ws, store: this.store, actor: executor, idempotencyKey: approvalId }, parsed.data);
        await this.store.insertReceipt(ws, approvalId, attempt, true, out, null, actorStr);
        await this.store.transitionApproval(ws, approvalId, "executing", "succeeded");
        await this.store.audit(ws, actorStr, "approval.executed", "approval", approvalId, { toolId: tool.toolId, attempt, ...pick(parsed.data, tool.auditFields) });
        return { ok: true as const, output: out };
      } catch (e) {
        lastErr = errMsg(e);
        const permanent = e instanceof DomainError && e.code.startsWith("permanent");
        if (permanent || i === tool.retry.max - 1) break;
        await this.store.insertReceipt(ws, approvalId, attempt, false, undefined, lastErr, actorStr);
        await this.sleep(tool.retry.backoffMs * 2 ** i);
      }
    }
    return fail(lastErr, attempt);
  }

  /** Operator replay of a dead-lettered (failed) approval. Re-enters via "approved"; idempotencyKey stays the approval id. */
  async replay(ws: string, approvalId: string, user: { id: string; role: string }) {
    if (!["owner", "admin"].includes(user.role)) throw new DomainError("forbidden", "Only owner/admin may replay");
    const ok = await this.store.transitionApproval(ws, approvalId, "failed", "approved", { decidedBy: user.id, note: "replay" });
    if (!ok) throw new DomainError("bad_state", "Only failed approvals can be replayed");
    await this.store.audit(ws, `user:${user.id}`, "approval.replayed", "approval", approvalId);
    return this.execute(ws, approvalId, { id: user.id, kind: "user" });
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
function pick(o: unknown, keys: string[]) {
  const out: Record<string, unknown> = {};
  if (o && typeof o === "object") for (const k of keys) if (k in (o as object)) out[k] = (o as Record<string, unknown>)[k];
  return out;
}
