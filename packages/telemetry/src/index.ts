import { createHash } from "node:crypto";

export interface ModelCallEvent {
  task: string;
  providerId: string;
  model: string;
  location: "cloud" | "local";
  ok: boolean;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costEur: number;
  redacted: boolean;
  error?: string;
  /** Pseudonymous: never the raw workspace id. */
  workspaceRef: string;
}

export interface Sink {
  name: string;
  modelCall?(e: ModelCallEvent): void;
  error?(err: unknown, ctx: Record<string, unknown>): void;
  event?(name: string, props: Record<string, unknown>): void;
  flush?(): Promise<void>;
}

export interface Telemetry {
  readonly sinks: string[];
  modelCall(e: Omit<ModelCallEvent, "workspaceRef"> & { workspaceId: string }): void;
  error(err: unknown, ctx?: Record<string, unknown>): void;
  event(name: string, props?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

// ------------------------------------------------------------------ sanitising

const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential|bearer|prompt|body|content|text|message|subject|email|phone|draft|payload/i;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const LONG_SECRET = /\b(?:sk|pk|rk|eyJ|ghp|xox[bap]|AKIA)[\w-]{16,}\b/g;

export function maskString(s: string): string {
  return s.replace(LONG_SECRET, "[secret]").replace(EMAIL, "[email]").replace(PHONE, "[phone]").slice(0, 300);
}

/** Deep-copies a value for telemetry: sensitive keys are dropped, strings are masked and truncated, depth is bounded. */
export function sanitize(v: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return maskString(v);
  if (v instanceof Error) return { name: v.name, message: maskString(v.message) };
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitize(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k] = sanitize(val, depth + 1);
    }
    return out;
  }
  return String(v);
}

export function pseudonym(id: string, salt = "aaf"): string {
  return createHash("sha256").update(`${salt}:${id}`).digest("hex").slice(0, 12);
}

// ------------------------------------------------------------------ fan-out

const safe = (fn: () => void) => {
  try {
    fn();
  } catch {
    /* telemetry must never break the app */
  }
};

export class FanoutTelemetry implements Telemetry {
  constructor(private all: Sink[], private salt = "aaf") {}
  get sinks() {
    return this.all.map((s) => s.name);
  }
  modelCall(e: Omit<ModelCallEvent, "workspaceRef"> & { workspaceId: string }) {
    const { workspaceId, ...rest } = e;
    const ev: ModelCallEvent = { ...rest, error: e.error ? maskString(e.error) : undefined, workspaceRef: pseudonym(workspaceId, this.salt) };
    for (const s of this.all) safe(() => s.modelCall?.(ev));
  }
  error(err: unknown, ctx: Record<string, unknown> = {}) {
    const c = sanitize(ctx) as Record<string, unknown>;
    for (const s of this.all) safe(() => s.error?.(err instanceof Error ? Object.assign(new Error(maskString(err.message)), { name: err.name, stack: err.stack }) : new Error(maskString(String(err))), c));
  }
  event(name: string, props: Record<string, unknown> = {}) {
    const p = sanitize(props) as Record<string, unknown>;
    for (const s of this.all) safe(() => s.event?.(name, p));
  }
  async flush() {
    await Promise.allSettled(this.all.map((s) => s.flush?.() ?? Promise.resolve()));
  }
}

export const noopTelemetry: Telemetry = new FanoutTelemetry([]);

// ------------------------------------------------------------------ sinks (structural types so they are testable without network)

export interface LangfuseLike {
  trace(b: { name: string; metadata?: unknown }): { generation(b: Record<string, unknown>): unknown };
  flushAsync(): Promise<void>;
}
export function langfuseSink(client: LangfuseLike): Sink {
  return {
    name: "langfuse",
    // Only metadata is sent: model, tokens, cost, latency, outcome. Prompts and completions are NOT sent by default.
    modelCall(e) {
      const now = Date.now();
      client.trace({ name: `ai.${e.task}`, metadata: { workspace: e.workspaceRef, location: e.location, redacted: e.redacted } }).generation({
        name: e.task,
        model: e.model,
        startTime: new Date(now - e.durationMs),
        endTime: new Date(now),
        usage: { input: e.tokensIn, output: e.tokensOut, totalCost: e.costEur },
        level: e.ok ? "DEFAULT" : "ERROR",
        statusMessage: e.error,
      });
    },
    flush: () => client.flushAsync(),
  };
}

export interface PostHogLike {
  capture(p: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown?(): Promise<void>;
}
export function posthogSink(client: PostHogLike, distinctId = "aaf-server"): Sink {
  return {
    name: "posthog",
    event: (name, props) => client.capture({ distinctId, event: name, properties: props }),
    flush: async () => {
      /* posthog-node batches; shutdown happens on process exit */
    },
  };
}

export interface SentryLike {
  captureException(err: unknown, hint?: { extra?: Record<string, unknown> }): unknown;
  flush(ms?: number): Promise<unknown>;
}
export function sentrySink(api: SentryLike): Sink {
  return {
    name: "sentry",
    error: (err, ctx) => void api.captureException(err, { extra: ctx }),
    flush: async () => void (await api.flush(2000)),
  };
}

// ------------------------------------------------------------------ factory

export interface TelemetryEnv {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASEURL?: string;
  SENTRY_DSN?: string;
  NEXT_PUBLIC_POSTHOG_KEY?: string;
  NEXT_PUBLIC_POSTHOG_HOST?: string;
}

/** Builds only the sinks whose credentials are present. With none configured this is a no-op. */
export async function createTelemetry(env: TelemetryEnv, salt = "aaf"): Promise<Telemetry> {
  const sinks: Sink[] = [];
  if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) {
    const { Langfuse } = await import("langfuse");
    sinks.push(langfuseSink(new Langfuse({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASEURL })));
  }
  if (env.SENTRY_DSN) {
    const Sentry = await import("@sentry/node");
    Sentry.init({ dsn: env.SENTRY_DSN, tracesSampleRate: 0 }); // v11 PII defaults (dataCollection) not reviewed: see docs
    sinks.push(sentrySink(Sentry));
  }
  if (env.NEXT_PUBLIC_POSTHOG_KEY) {
    const { PostHog } = await import("posthog-node");
    sinks.push(posthogSink(new PostHog(env.NEXT_PUBLIC_POSTHOG_KEY, { host: env.NEXT_PUBLIC_POSTHOG_HOST })));
  }
  return sinks.length ? new FanoutTelemetry(sinks, salt) : noopTelemetry;
}
