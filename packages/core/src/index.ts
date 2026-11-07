import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

/** Deterministic JSON: sorted keys, so equal payloads hash equally. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const payloadHash = (v: unknown): string => sha256(stableStringify(v));

export const RiskTier = z.enum(["read", "draft", "write_low", "external_communication", "financial_or_irreversible"]);
export type RiskTier = z.infer<typeof RiskTier>;

export const ApprovalStatus = z.enum([
  "proposed",
  "awaiting_approval",
  "approved",
  "rejected",
  "expired",
  "executing",
  "succeeded",
  "failed",
  "unknown_outcome",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Role = z.enum(["owner", "admin", "member", "viewer"]);
export type Role = z.infer<typeof Role>;

export const ActionClass = z.enum(["act_now", "schedule", "follow_up", "monitor", "save_idea", "ignore"]);
export type ActionClass = z.infer<typeof ActionClass>;

export const DataPolicy = z.enum(["cloud_allowed", "redact_then_cloud", "local_only"]);
export type DataPolicy = z.infer<typeof DataPolicy>;

/** Typed event envelope (spec section 4). */
export const EventEnvelope = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  source: z.string().min(1),
  externalId: z.string().optional(),
  type: z.string().min(1),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  correlationId: z.string(),
  payloadVersion: z.number().int().positive(),
  payload: z.record(z.string(), z.unknown()),
  dedupeKey: z.string().min(1),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

export function makeEvent(
  i: Pick<EventEnvelope, "workspaceId" | "source" | "type" | "payload"> &
    Partial<Pick<EventEnvelope, "externalId" | "occurredAt" | "correlationId" | "payloadVersion">>,
): EventEnvelope {
  const now = new Date().toISOString();
  const dedupeKey = i.externalId ? `${i.source}:${i.externalId}` : `${i.source}:${i.type}:${payloadHash(i.payload)}`;
  return EventEnvelope.parse({
    id: newId(),
    workspaceId: i.workspaceId,
    source: i.source,
    externalId: i.externalId,
    type: i.type,
    occurredAt: i.occurredAt ?? now,
    receivedAt: now,
    correlationId: i.correlationId ?? newId(),
    payloadVersion: i.payloadVersion ?? 1,
    payload: i.payload,
    dedupeKey,
  });
}

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Provenance attached to anything the Brain recommends. */
export const Provenance = z.object({
  source: z.string(), // system of record, e.g. "manual", "networkradar"
  recordId: z.string().optional(),
  retrievedAt: z.string().datetime(),
  note: z.string().optional(),
  kind: z.enum(["record", "inference", "demo"]).default("record"),
});
export type Provenance = z.infer<typeof Provenance>;

export const Connector = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["connected", "not_connected", "demo"]),
  detail: z.string(),
});
export type Connector = z.infer<typeof Connector>;
