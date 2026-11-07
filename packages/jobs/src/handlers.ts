import { DomainError } from "@aaf/core";
import { triageInboxItem, type BrainDeps } from "@aaf/brain";
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

  /** Execute an already-approved action in the background (durable across crashes). Failure dead-letters both job and approval. */
  "approval.execute": async (ctx) => {
    const approvalId = String(ctx.job.input["approvalId"] ?? "");
    if (!approvalId) throw new DomainError("permanent_bad_input", "approval.execute needs approvalId");
    const res = await ctx.services.deps.gateway.execute(ctx.workspaceId, approvalId, { id: ctx.job.id, kind: "system" });
    if (!res.ok) throw new DomainError("permanent_execution_failed", res.error);
    return { kind: "done", output: { approvalId, delivered: (res.output as { delivered?: boolean })?.delivered ?? null } };
  },
};
