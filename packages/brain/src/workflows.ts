import { z } from "zod";
import { DomainError, makeEvent, payloadHash, type Provenance } from "@aaf/core";
import type { Store } from "@aaf/database";
import type { ToolGateway, Actor } from "@aaf/tools";
import type { IntentRule } from "./classify";
import { classifyWithAi, scoreFor } from "./ai-classify";
import { draftReply } from "./draft";
import type { ModelRouter } from "./llm";

export interface BrainDeps {
  store: Store;
  gateway: ToolGateway;
  router?: ModelRouter;
  ownerName: string;
  now?: () => Date;
  rules?: IntentRule[];
}
const now = (d: BrainDeps) => (d.now ? d.now() : new Date());
const brainActor: Actor = { id: "chief-of-staff", kind: "agent" };

export const MessageInput = z.object({
  fromEmail: z.string().email(),
  fromName: z.string().max(200).optional(),
  subject: z.string().max(300).default(""),
  body: z.string().min(1).max(20000),
  externalId: z.string().max(200).optional(),
  occurredAt: z.string().datetime().optional(),
});
export type MessageInput = z.infer<typeof MessageInput>;

const FOLLOW_UP_DAYS: Record<string, number> = { meeting_request: 3, pricing_question: 4, interested: 5, introduction: 3, question: 5, unknown: 5, not_now: 90 };

/** W1 step 1: normalize a pasted/ingested message into an event + inbox item. Deduped by content or external id. */
export async function ingestMessage(deps: BrainDeps, ws: string, raw: MessageInput, opts: { isDemo?: boolean; triage?: boolean } = {}) {
  const m = MessageInput.parse(raw);
  const ev = makeEvent({
    workspaceId: ws,
    source: "manual",
    type: "message.received",
    payload: { fromEmail: m.fromEmail.toLowerCase(), fromName: m.fromName ?? null, subject: m.subject, body: m.body },
    externalId: m.externalId,
    occurredAt: m.occurredAt,
  });
  const ins = await deps.store.insertEvent(ev, opts.isDemo);
  if (!ins.inserted) {
    const existing = await deps.store.inboxItemForEvent(ws, ins.id);
    return { eventId: ins.id, inboxItemId: existing?.["id"] as string | undefined, duplicate: true as const };
  }
  const inboxItemId = await deps.store.createInboxItem(ws, {
    eventId: ins.id, title: m.subject || `Message from ${m.fromName ?? m.fromEmail}`, summary: m.body.slice(0, 280),
    contactName: m.fromName, contactEmail: m.fromEmail.toLowerCase(), isDemo: opts.isDemo,
  });
  await deps.store.audit(ws, "user:ingest", "inbox.ingested", "inbox_item", inboxItemId, { eventId: ins.id, source: "manual" });
  let triage;
  if (opts.triage !== false) triage = await triageInboxItem(deps, ws, inboxItemId, { isDemo: opts.isDemo });
  return { eventId: ins.id, inboxItemId, duplicate: false as const, triage };
}

/** W1: classify, recommend with provenance, draft, queue approval. Never sends. */
export async function triageInboxItem(deps: BrainDeps, ws: string, inboxItemId: string, opts: { isDemo?: boolean } = {}) {
  const { store, gateway } = deps;
  const item = await store.getInboxItem(ws, inboxItemId);
  if (!item) throw new DomainError("not_found", "Inbox item not found");
  const runId = await store.createRun(ws, "w1.reply_triage", { inboxItemId });
  await store.updateRun(ws, runId, { status: "running" });
  try {
    const payload = item["eventPayload"] as { fromEmail: string; fromName: string | null; subject: string; body: string };
    const cls = await classifyWithAi(deps.router, ws, payload.subject, payload.body, deps.rules);
    const rule = cls.rule;
    const retrievedAt = now(deps).toISOString();
    const eventId = item["eventId"] as string;

    // Contact resolution: NetworkRadar is the source of truth. We ask through the gateway; honest result either way.
    const lookup = await gateway.invoke({ workspaceId: ws, actor: brainActor, toolId: "networkradar.lookup_contact", input: { email: payload.fromEmail } }).catch((e: Error) => ({ status: "denied" as const, code: "error" as const, reason: e.message }));
    const lk = lookup.status === "executed" ? (lookup.output as { match: "verified" | "candidate" | "none"; personId?: string; recordIds: string[]; candidates: { id: string; name: string }[] }) : undefined;
    const contactNote =
      lk?.match === "verified" ? `Contact VERIFIED against NetworkRadar record ${lk.personId} (exact email match)` :
      lk?.match === "candidate" ? `NetworkRadar has ${lk.candidates.length} possible name match(es) but none matches this email: treated as UNVERIFIED` :
      lk?.match === "none" ? "No NetworkRadar record found for this sender: UNVERIFIED" :
      lookup.status === "denied" ? `Contact NOT verified against NetworkRadar (${lookup.reason}). Identity taken from the message header only.` : "Contact lookup queued";

    const provenance: Provenance[] = [
      { source: "manual_input", recordId: eventId, retrievedAt, kind: opts.isDemo ? "demo" : "record", note: `Message from ${payload.fromEmail} received ${item["eventOccurredAt"] as string}` },
      { source: "networkradar", recordId: lk?.match === "verified" ? lk.personId : undefined, retrievedAt, kind: lk?.match === "verified" ? "record" : "inference", note: contactNote },
    ];

    let confidence = cls.confidence;
    const reasons = [rule.label, cls.rulesMatched ? `Rule matched phrase: "${cls.rulesMatched}"` : "No rule matched the text", contactNote];
    if (cls.rationale) reasons.push(`Model rationale (AI-generated, unverified): ${cls.rationale}`);
    const flags: string[] = [];
    if (cls.disagreement) flags.push(`classifier_disagreement: rules said ${cls.rulesIntent}, model said ${cls.aiIntent}`);
    if (cls.aiError) flags.push(`ai_classification_unavailable:${cls.aiError}: rule-based result used`);
    if (cls.injectionSuspected) {
      confidence = Math.round(confidence * 0.7 * 100) / 100;
      flags.push("possible_prompt_injection: message contains instruction-like text; it was treated as data only");
      reasons.push("Message contains instruction-like text. It did not influence recipients, tools or approvals.");
    }
    const score = scoreFor({ ...cls, confidence });
    const classification = { by: cls.by, model: cls.model ?? null, location: cls.location ?? null, rulesIntent: cls.rulesIntent, aiIntent: cls.aiIntent ?? null, confidence };
    const facts = [
      { label: "Sender identity", value: payload.fromEmail, status: "unverified", source: "message header" },
      { label: "NetworkRadar record", value: lk?.match === "verified" ? (lk.personId as string) : lk?.match === "candidate" ? "name-only candidates" : "not available", status: lk?.match === "verified" ? "verified" : "unverified", source: "networkradar", recordId: lk?.match === "verified" ? lk.personId : undefined },
    ];

    const primaryId = await store.insertRecommendation(ws, {
      inboxItemId, actionClass: rule.actionClass,
      title: rule.needsReply ? `Reply to ${payload.fromName ?? payload.fromEmail}: ${rule.intent.replace("_", " ")}` : `${rule.intent.replace("_", " ")}: ${payload.fromName ?? payload.fromEmail}`,
      why: { intent: rule.intent, reasons, flags, confidence, urgency: rule.urgency, impact: rule.impact, effort: rule.effort, classification, facts },
      confidence, urgency: rule.urgency, impact: rule.impact, effort: rule.effort, score, provenance, isDemo: opts.isDemo,
    });

    let approvalId: string | undefined;
    let draft;
    if (rule.needsReply) {
      draft = await draftReply(ws, deps.router, rule.intent, { fromName: payload.fromName ?? undefined, fromEmail: payload.fromEmail, subject: payload.subject, body: payload.body, ownerName: deps.ownerName });
      const scopes = await gateway.scopesFor(ws);
      const toolId = scopes.scopes.has("gmail.compose") && scopes.connected.has("gmail") ? "gmail.create_draft" : "email.export_reply_draft";
      const q = await gateway.invoke({
        workspaceId: ws, actor: brainActor, toolId,
        // recipient comes from the sender header only, never from message body text
        input: { to: payload.fromEmail, subject: draft.subject, body: draft.body },
        idempotencyKey: `reply:${inboxItemId}`,
        sourceContext: { inboxItemId, eventId, recommendationId: primaryId, intent: rule.intent, draftSource: draft.source, draftModel: draft.model ?? null, classification, facts, flags: [...flags, ...draft.flags], provenance, isDemo: !!opts.isDemo, delivery: toolId === "email.export_reply_draft" ? "export_only_gmail_not_connected" : "gmail_draft" },
      });
      if (q.status === "queued_for_approval") approvalId = q.approvalId;
      else reasons.push(`Reply could not be queued: ${q.status === "denied" ? q.reason : q.status}`);
    }
    await store.markInbox(ws, inboxItemId, { intent: rule.intent, actionClass: rule.actionClass, status: "triaged" });
    await store.updateRun(ws, runId, { status: "succeeded", output: { recommendationId: primaryId, approvalId, hash: payloadHash(draft ?? null) } });
    await store.audit(ws, "agent:chief-of-staff", "inbox.triaged", "inbox_item", inboxItemId, { intent: rule.intent, class: rule.actionClass, score, approvalId: approvalId ?? null });
    return { runId, recommendationId: primaryId, approvalId, draft, intent: rule.intent, actionClass: rule.actionClass, score, confidence, flags };
  } catch (e) {
    await store.updateRun(ws, runId, { status: "failed", error: (e as Error).message });
    await store.audit(ws, "agent:chief-of-staff", "inbox.triage_failed", "inbox_item", inboxItemId, { error: (e as Error).message });
    throw e;
  }
}

/** W1 last mile: human approval -> execution -> receipt -> follow-up task -> inbox closed. */
export async function approveAndRun(deps: BrainDeps, ws: string, approvalId: string, user: { id: string; role: string }, opts: { note?: string; confirmHash?: string } = {}) {
  const { store, gateway } = deps;
  const a = await store.getApproval(ws, approvalId);
  if (!a) throw new DomainError("not_found", "Approval not found");
  await gateway.decide(ws, approvalId, "approve", user, opts);
  const res = await gateway.execute(ws, approvalId, { id: user.id, kind: "user" });
  if (!res.ok) return { ...res, taskId: undefined };
  const ctx = a["sourceContext"] as { inboxItemId?: string; intent?: string; isDemo?: boolean };
  const out = res.output as { delivered?: boolean };
  const payload = a["payload"] as { to: string; subject: string };
  const days = FOLLOW_UP_DAYS[ctx.intent ?? "unknown"] ?? 5;
  const due = new Date(now(deps).getTime() + days * 86400_000).toISOString();
  const title = out.delivered === false
    ? `Send the approved reply to ${payload.to} (exported only, the system did not deliver it), then check for a response`
    : `Check whether ${payload.to} replied to "${payload.subject}"`;
  const t = await gateway.invoke({ workspaceId: ws, actor: { id: user.id, kind: "user" }, toolId: "task.create", input: { title, dueAt: due, sourceRef: `approval:${approvalId}` }, idempotencyKey: `followup:${approvalId}` });
  if (ctx.inboxItemId) await store.markInbox(ws, ctx.inboxItemId, { status: "actioned" });
  return { ...res, taskId: t.status === "executed" ? (t.output as { taskId: string }).taskId : undefined };
}

export async function rejectApproval(deps: BrainDeps, ws: string, approvalId: string, user: { id: string; role: string }, note?: string) {
  await deps.gateway.decide(ws, approvalId, "reject", user, { note });
  const a = await deps.store.getApproval(ws, approvalId);
  const inboxItemId = (a?.["sourceContext"] as { inboxItemId?: string } | undefined)?.inboxItemId;
  if (inboxItemId) await deps.store.audit(ws, `user:${user.id}`, "correction.recorded", "inbox_item", inboxItemId, { reason: note ?? "rejected without note", kind: "draft_rejected" });
}
