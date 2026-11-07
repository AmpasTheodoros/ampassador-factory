import { createHash } from "node:crypto";
import type { NodeOptions } from "@sentry/node";

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

const SENSITIVE_KEY =
  /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential|bearer|prompt|body|content|text|message|subject|email|phone|draft|payload/i;
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;
const LONG_SECRET = /\b(?:sk|pk|rk|eyJ|ghp|xox[bap]|AKIA)[\w-]{16,}\b/g;
const PREFIXED_KEY = /\b(?:nrro|sk|pk|rk|sbp|sb_secret|sb_publishable|phc|phx|lf|pk-lf|sk-lf|tr_dev|tr_prod|tr_stg)_[A-Za-z0-9_-]{16,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const CONN_STRING = /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s'"<>]+/gi;
const SECRET_PARAM =
  /([?&;\s](?:password|passwd|pwd|token|access_token|refresh_token|api_?key|apikey|secret|key|authorization)=)[^&\s;'"]+/gi;

/** Masks secrets and personal identifiers inside free text. Order matters: structured secrets first, then identifiers. */
export function maskString(s: string): string {
  return s
    .replace(CONN_STRING, "$1://[redacted]")
    .replace(BEARER, "Bearer [secret]")
    .replace(JWT, "[jwt]")
    .replace(PREFIXED_KEY, "[secret]")
    .replace(LONG_SECRET, "[secret]")
    .replace(SECRET_PARAM, "$1[redacted]")
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .slice(0, 300);
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
  constructor(
    private all: Sink[],
    private salt = "aaf",
  ) {}
  get sinks() {
    return this.all.map((s) => s.name);
  }
  modelCall(e: Omit<ModelCallEvent, "workspaceRef"> & { workspaceId: string }) {
    const { workspaceId, ...rest } = e;
    const ev: ModelCallEvent = {
      ...rest,
      error: e.error ? maskString(e.error) : undefined,
      workspaceRef: pseudonym(workspaceId, this.salt),
    };
    for (const s of this.all) safe(() => s.modelCall?.(ev));
  }
  error(err: unknown, ctx: Record<string, unknown> = {}) {
    const c = sanitize(ctx) as Record<string, unknown>;
    for (const s of this.all)
      safe(() =>
        s.error?.(
          err instanceof Error
            ? Object.assign(new Error(maskString(err.message)), { name: err.name, stack: err.stack })
            : new Error(maskString(String(err))),
          c,
        ),
      );
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
      client
        .trace({ name: `ai.${e.task}`, metadata: { workspace: e.workspaceRef, location: e.location, redacted: e.redacted } })
        .generation({
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
    sinks.push(
      langfuseSink(new Langfuse({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY, baseUrl: env.LANGFUSE_BASEURL })),
    );
  }
  if (env.SENTRY_DSN) {
    const Sentry = await import("@sentry/node");
    Sentry.init(sentryInitOptions(env.SENTRY_DSN));
    sinks.push(sentrySink(Sentry));
  }
  if (env.NEXT_PUBLIC_POSTHOG_KEY) {
    const { PostHog } = await import("posthog-node");
    sinks.push(posthogSink(new PostHog(env.NEXT_PUBLIC_POSTHOG_KEY, { host: env.NEXT_PUBLIC_POSTHOG_HOST })));
  }
  return sinks.length ? new FanoutTelemetry(sinks, salt) : noopTelemetry;
}

// ------------------------------------------------------------------ safe logging

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured JSON logger. Every field passes through the same sanitiser as telemetry, so a careless
 * `log.error("failed", { error, request })` cannot put a token, a connection string or a message body in the logs.
 * Application code uses this instead of console.* (enforced by lint).
 */
export function createLogger(write: (line: string, level: LogLevel) => void = defaultWrite, base: Record<string, unknown> = {}): Logger {
  const emit =
    (level: LogLevel) =>
    (event: string, fields: Record<string, unknown> = {}) => {
      try {
        write(
          JSON.stringify({
            level,
            event: maskString(event),
            ts: new Date().toISOString(),
            ...(sanitize(base) as object),
            ...(sanitize(fields) as object),
          }),
          level,
        );
      } catch {
        /* logging must never throw */
      }
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
function defaultWrite(line: string, level: LogLevel) {
  // eslint-disable-next-line no-console -- the one sanctioned sink
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}
export const log: Logger = createLogger();

// ------------------------------------------------------------------ Sentry configuration (audited)

/**
 * Sentry v11 collects, BY DEFAULT: request bodies, cookies, all headers, query params, local variable values in stack
 * frames, DB query data and AI inputs/outputs. For an app that handles other people's emails that is unacceptable, so
 * every collector is switched off explicitly. (Defaults read from @sentry/core 11.11.0 types/datacollection.d.ts.)
 */
export function sentryInitOptions(dsn: string): NodeOptions {
  return {
    dsn,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSend: (event) => scrubSentryEvent(event as unknown as Record<string, unknown>) as unknown as typeof event,
  };
}

/** Last line of defence: even if a future SDK default changes, nothing identifying leaves in the event. */
export function scrubSentryEvent<T extends Record<string, unknown>>(event: T): T {
  const e = event as Record<string, unknown> & {
    message?: string;
    request?: Record<string, unknown>;
    user?: unknown;
    extra?: unknown;
    contexts?: unknown;
    breadcrumbs?: unknown;
    exception?: { values?: { value?: string; stacktrace?: { frames?: { vars?: unknown }[] } }[] };
  };
  if (typeof e.message === "string") e.message = maskString(e.message);
  if (e.exception?.values)
    for (const v of e.exception.values) {
      if (typeof v.value === "string") v.value = maskString(v.value);
      for (const f of v.stacktrace?.frames ?? []) delete f.vars;
    }
  if (e.request) {
    const url = typeof e.request["url"] === "string" ? (e.request["url"] as string).split("?")[0] : undefined;
    e.request = url ? { url: maskString(url), method: e.request["method"] } : {};
  }
  delete e.user;
  delete e.breadcrumbs;
  if (e.extra) e.extra = sanitize(e.extra);
  if (e.contexts) e.contexts = sanitize(e.contexts);
  return event;
}
