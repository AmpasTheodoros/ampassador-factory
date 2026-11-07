import { z } from "zod";
import { DomainError } from "@aaf/core";
import type { ToolDef } from "./gateway";

const EmailPayload = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(300),
  body: z.string().min(1).max(20000),
  inReplyToThread: z.string().optional(),
});
export type EmailPayload = z.infer<typeof EmailPayload>;

const notImplemented = (c: string) => async (): Promise<never> => {
  throw new DomainError("permanent_connector_not_implemented", `Connector ${c} adapter is not implemented in R1`);
};

/** Builds an RFC 5322 style message text. Nothing is transmitted. */
export function toEml(p: EmailPayload): string {
  return [`To: ${p.to}`, `Subject: ${p.subject}`, "Content-Type: text/plain; charset=utf-8", "", p.body].join("\r\n");
}

export const exportReplyDraft: ToolDef = {
  toolId: "email.export_reply_draft",
  description: "Approved reply is exported as text/.eml for the human to send. NOT delivered by the system.",
  connector: "internal",
  requiredScopes: ["exports:write"],
  riskTier: "external_communication",
  idempotency: "natural",
  rateLimitPerMin: 30,
  approvalPolicy: "always",
  inputSchema: EmailPayload,
  outputSchema: z.object({ delivered: z.literal(false), format: z.literal("eml"), to: z.string(), subject: z.string(), body: z.string(), eml: z.string() }),
  timeoutMs: 5_000,
  retry: { max: 1, backoffMs: 1 },
  auditFields: ["to", "subject"],
  summarize: (i: EmailPayload) => `Export reply to ${i.to}: "${i.subject}" (not sent by the system)`,
  async execute(_ctx, i: EmailPayload) {
    return { delivered: false as const, format: "eml" as const, to: i.to, subject: i.subject, body: i.body, eml: toEml(i) };
  },
};

export const gmailCreateDraft: ToolDef = {
  toolId: "gmail.create_draft",
  description: "Create a Gmail draft (no send). Adapter not built in R1: tool is gated by connector status.",
  connector: "gmail",
  requiredScopes: ["gmail.compose"],
  riskTier: "write_low",
  idempotency: "key_required",
  rateLimitPerMin: 20,
  approvalPolicy: "always",
  inputSchema: EmailPayload,
  outputSchema: z.object({ draftId: z.string() }),
  timeoutMs: 15_000,
  retry: { max: 3, backoffMs: 500 },
  auditFields: ["to", "subject"],
  summarize: (i: EmailPayload) => `Create Gmail draft to ${i.to}: "${i.subject}"`,
  execute: notImplemented("gmail"),
};

export const gmailSend: ToolDef = {
  toolId: "gmail.send",
  description: "Send an approved email through Gmail. Adapter not built in R1: gated by connector status.",
  connector: "gmail",
  requiredScopes: ["gmail.send"],
  riskTier: "external_communication",
  idempotency: "key_required",
  rateLimitPerMin: 10,
  approvalPolicy: "always",
  inputSchema: EmailPayload,
  outputSchema: z.object({ messageId: z.string() }),
  timeoutMs: 15_000,
  retry: { max: 3, backoffMs: 500 },
  auditFields: ["to", "subject"],
  summarize: (i: EmailPayload) => `SEND email to ${i.to}: "${i.subject}"`,
  execute: notImplemented("gmail"),
};

export const networkRadarLookup: ToolDef = {
  toolId: "networkradar.lookup_contact",
  description: "Read-only lookup in NetworkRadar (system of record). VERIFIED only on an exact email match of the canonical record.",
  connector: "networkradar",
  requiredScopes: ["networkradar.read"],
  riskTier: "read",
  idempotency: "natural",
  rateLimitPerMin: 60,
  approvalPolicy: "never",
  inputSchema: z.object({ email: z.string().email().optional(), name: z.string().optional() }),
  outputSchema: z.object({ found: z.boolean(), match: z.enum(["verified", "candidate", "none"]), personId: z.string().optional(), recordIds: z.array(z.string()), candidates: z.array(z.object({ id: z.string(), name: z.string() })) }),
  timeoutMs: 15_000,
  retry: { max: 2, backoffMs: 300 },
  auditFields: [],
  summarize: () => "Look up contact in NetworkRadar",
  async execute(ctx, i: { email?: string; name?: string }) {
    const nr = ctx.services.networkradar;
    if (!nr) throw new DomainError("permanent_connector_unavailable", "NetworkRadar client is not configured in this runtime");
    const r = await nr.lookupContact(i);
    return { found: r.match === "verified", match: r.match, personId: r.personId, recordIds: r.recordIds, candidates: r.candidates };
  },
};

export const taskCreate: ToolDef = {
  toolId: "task.create",
  description: "Create a follow-up task in the Command Center (reversible, internal).",
  connector: "internal",
  requiredScopes: ["tasks:write"],
  riskTier: "write_low",
  idempotency: "natural",
  rateLimitPerMin: 60,
  approvalPolicy: "never",
  inputSchema: z.object({ title: z.string().min(1).max(300), dueAt: z.string().datetime().optional(), sourceRef: z.string().optional() }),
  outputSchema: z.object({ taskId: z.string() }),
  timeoutMs: 5_000,
  retry: { max: 1, backoffMs: 1 },
  auditFields: ["title", "sourceRef"],
  summarize: (i: { title: string }) => `Create task "${i.title}"`,
  async execute(ctx, i: { title: string; dueAt?: string; sourceRef?: string }) {
    return { taskId: await ctx.store.createTask(ctx.workspaceId, i) };
  },
};

export const BUILTIN_TOOLS: ToolDef[] = [exportReplyDraft, gmailCreateDraft, gmailSend, networkRadarLookup, taskCreate];
