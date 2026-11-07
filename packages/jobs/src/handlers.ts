import { DomainError } from "@aaf/core";
import { triageInboxItem, ensureFollowUpTask, type BrainDeps } from "@aaf/brain";
import type { Handlers } from "./runner";

export interface BrainServices {
  deps: BrainDeps;
}

/**
 * Real job handlers. Both are safe to re-run: triage dedupes on the inbox item (idempotency key `reply:<item>`),
 * and approval execution only proceeds from the `approved` state via compare-and-set.
 */
export const brainHandlers: Handlers<BrainServices> = {
  /** W1: classify + draft + queue approval. Parks on the approval, resumes when a human decides. */
  "w1.triage": async (ctx) => {
    const inboxItemId = String(ctx.job.input["inboxItemId"] ?? "");
    if (!inboxItemId) throw new DomainError("permanent_bad_input", "w1.triage needs inboxItemId");
    if (ctx.resume) {
      // resumed after the approval reached a terminal state: record the outcome, nothing is re-sent
      return { kind: "done", output: { approvalId: ctx.resume.approvalId, approvalStatus: ctx.resume.approvalStatus } };
    }
    await ctx.progress(10, "classifying");
    const t = await triageInboxItem(ctx.services.deps, ctx.workspaceId, inboxItemId);
    await ctx.checkCancelled();
    await ctx.progress(80, "triaged");
    if (t.approvalId) return { kind: "wait_approval", approvalId: t.approvalId };
    return { kind: "done", output: { intent: t.intent, actionClass: t.actionClass, approvalId: null } };
  },

  /**
   * Execute an already-approved action, durably. The gateway records its claim and outcome in their own committed
   * transactions (write-ahead), so this handler RETURNS the outcome instead of throwing once the gateway has run:
   * throwing would roll back the job transaction, and an external effect cannot be rolled back.
   *   succeeded        -> follow-up task (idempotent) and done
   *   unknown_outcome  -> done, flagged; the approval waits for human reconciliation and is NEVER re-sent
   *   failed           -> done, flagged; the approval is dead-lettered for operator replay
   */
  "approval.execute": async (ctx) => {
    const approvalId = String(ctx.job.input["approvalId"] ?? "");
    if (!approvalId) throw new DomainError("permanent_bad_input", "approval.execute needs approvalId");
    const deps = ctx.services.deps;
    const a = await ctx.store.getApproval(ctx.workspaceId, approvalId);
    if (!a) throw new DomainError("permanent_not_found", "approval not found");
    const status = String(a["status"]);
    if (status === "succeeded") {
      await ensureFollowUpTask(deps, ctx.workspaceId, approvalId, { id: ctx.job.id });
      return { kind: "done", output: { approvalId, approvalStatus: "succeeded", executedHere: false } };
    }
    if (status !== "approved") return { kind: "done", output: { approvalId, approvalStatus: status, executedHere: false, note: "not executable: needs a human (reconcile/replay) or was decided otherwise" } };
    await ctx.progress(20, "executing");
    let res;
    try {
      res = await deps.gateway.execute(ctx.workspaceId, approvalId, { id: ctx.job.id, kind: "system" });
    } catch (e) {
      if (e instanceof DomainError && ["not_approved", "bad_state", "not_found"].includes(e.code)) throw new DomainError("permanent_not_executable", e.message);
      throw e;
    }
    if (res.ok) {
      await ensureFollowUpTask(deps, ctx.workspaceId, approvalId, { id: ctx.job.id });
      return { kind: "done", output: { approvalId, approvalStatus: "succeeded", executedHere: true, delivered: (res.output as { delivered?: boolean })?.delivered ?? null } };
    }
    return { kind: "done", output: { approvalId, approvalStatus: res.unknown ? "unknown_outcome" : "failed", executedHere: true, error: res.error, needsHuman: true } };
  },
};
