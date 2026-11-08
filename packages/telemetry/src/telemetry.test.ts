import { describe, it, expect } from "vitest";
import {
  sanitize,
  maskString,
  FanoutTelemetry,
  noopTelemetry,
  createTelemetry,
  langfuseSink,
  sentrySink,
  posthogSink,
  pseudonym,
  type Sink,
} from "./index";

describe("sanitize", () => {
  it("drops sensitive keys and masks identifiers in remaining strings", () => {
    const out = sanitize({
      tool: "gmail.send",
      workspace: "w1",
      password: "hunter2",
      apiKey: "k",
      Authorization: "Bearer abc",
      body: "dear jane",
      subject: "s",
      note: "contact jane@corp.com or +30 690 123 4567",
      nested: { token: "t", ok: 1, list: ["a@b.co", 5] },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      tool: "gmail.send",
      workspace: "w1",
      note: "contact [email] or [phone]",
      nested: { ok: 1, list: ["[email]", 5] },
    });
  });
  it("masks well-known secret shapes even in innocuous keys", () => {
    expect(maskString("value sk_live_abcdefghijklmnopqrstuv end")).toContain("[secret]");
    expect(maskString("x".repeat(1000)).length).toBe(300);
  });
  it("bounds depth and array size", () => {
    const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
    expect(JSON.stringify(sanitize(deep))).toContain("[truncated]");
    expect((sanitize(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(20);
  });
});

describe("fan-out", () => {
  it("a failing sink never throws into the app and does not block the others", async () => {
    const seen: string[] = [];
    const bad: Sink = {
      name: "bad",
      modelCall: () => {
        throw new Error("boom");
      },
      error: () => {
        throw new Error("boom");
      },
      event: () => {
        throw new Error("boom");
      },
      flush: async () => {
        throw new Error("boom");
      },
    };
    const good: Sink = {
      name: "good",
      event: (n) => void seen.push(n),
      error: () => void seen.push("err"),
      modelCall: () => void seen.push("mc"),
    };
    const t = new FanoutTelemetry([bad, good]);
    t.event("x");
    t.error(new Error("e"));
    t.modelCall({
      task: "t",
      providerId: "p",
      model: "m",
      location: "cloud",
      ok: true,
      durationMs: 1,
      tokensIn: 1,
      tokensOut: 1,
      costEur: 0,
      redacted: false,
      workspaceId: "w",
    });
    await expect(t.flush()).resolves.toBeUndefined();
    expect(seen).toEqual(["x", "err", "mc"]);
  });
  it("never forwards raw workspace ids, message text or addresses", () => {
    const got: unknown[] = [];
    const t = new FanoutTelemetry([
      { name: "s", modelCall: (e) => got.push(e), error: (e, c) => got.push([e, c]), event: (n, p) => got.push([n, p]) },
    ]);
    t.modelCall({
      task: "classify",
      providerId: "p",
      model: "m",
      location: "cloud",
      ok: false,
      durationMs: 5,
      tokensIn: 1,
      tokensOut: 0,
      costEur: 0,
      redacted: true,
      workspaceId: "11111111-2222-4333-8444-555555555555",
      error: "failed for jane@corp.com",
    });
    t.error(new Error("smtp to jane@corp.com failed"), { prompt: "SECRET PROMPT", approvalId: "a1" });
    t.event("approval_decided", { decision: "approve", body: "private text", to: "x@y.co" });
    const s = JSON.stringify(got);
    expect(s).not.toContain("11111111-2222");
    expect(s).not.toContain("jane@corp.com");
    expect(s).not.toContain("SECRET PROMPT");
    expect(s).not.toContain("private text");
    expect(s).toContain(pseudonym("11111111-2222-4333-8444-555555555555"));
    expect(s).toContain("approvalId");
  });
});

describe("adapters (structural fakes, no network)", () => {
  it("langfuse receives usage/cost/latency metadata only, no prompt or completion", () => {
    const gens: Record<string, unknown>[] = [];
    const traces: unknown[] = [];
    const fake = {
      trace: (b: unknown) => {
        traces.push(b);
        return { generation: (g: Record<string, unknown>) => void gens.push(g) };
      },
      flushAsync: async () => {},
    };
    const t = new FanoutTelemetry([langfuseSink(fake)]);
    t.modelCall({
      task: "draft",
      providerId: "p",
      model: "m1",
      location: "local",
      ok: true,
      durationMs: 120,
      tokensIn: 10,
      tokensOut: 5,
      costEur: 0.01,
      redacted: false,
      workspaceId: "w",
    });
    expect(gens[0]).toMatchObject({ model: "m1", usage: { input: 10, output: 5, totalCost: 0.01 } });
    expect(Object.keys(gens[0]!)).not.toContain("input");
    expect(Object.keys(gens[0]!)).not.toContain("output");
  });
  it("sentry gets sanitised extras; posthog gets sanitised events", () => {
    const cap: unknown[] = [];
    const t = new FanoutTelemetry([
      sentrySink({ captureException: (e, h) => void cap.push([e, h]), flush: async () => true }),
      posthogSink({ capture: (p) => void cap.push(p) }),
    ]);
    t.error(new Error("fail jane@corp.com"), { token: "abc", jobId: "j1" });
    t.event("job_failed", { jobId: "j1", cookie: "c" });
    const s = JSON.stringify(cap);
    expect(s).not.toContain("jane@corp.com");
    expect(s).not.toContain('"abc"');
    expect(s).not.toContain('"c"');
    expect(s).toContain("j1");
  });
});

describe("factory", () => {
  it("with no credentials it is a no-op and constructs nothing", async () => {
    const t = await createTelemetry({});
    expect(t).toBe(noopTelemetry);
    expect(t.sinks).toEqual([]);
  });
  it("only credentialled sinks are built (no network is touched at construction)", async () => {
    const t = await createTelemetry({
      NEXT_PUBLIC_POSTHOG_KEY: "phc_test_key_for_construction_only",
      NEXT_PUBLIC_POSTHOG_HOST: "http://127.0.0.1:9",
    });
    expect(t.sinks).toEqual(["posthog"]);
  });
});

import { createLogger, maskString as mask, sentryInitOptions, scrubSentryEvent } from "./index";

describe("secret and PII masking in free text", () => {
  it("masks bearer tokens, JWTs, connection strings, prefixed keys and secret query params", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv";
    const s = mask(
      `auth Bearer abcdefghijklmnop1234567 jwt ${jwt} db postgres://aaf_app:S3cretPw@db.example.com:6543/postgres?sslmode=require key nrro_${"A".repeat(43)} url https://x.test/cb?token=abc123xyz&ok=1 mail jane@corp.com`,
    );
    for (const leak of ["abcdefghijklmnop1234567", jwt, "S3cretPw", "aaf_app", "nrro_AAAA", "abc123xyz", "jane@corp.com"])
      expect(s, leak).not.toContain(leak);
    expect(s).toContain("Bearer [secret]");
    expect(s).toContain("postgres://[redacted]");
    expect(s).toContain("ok=1");
  });
});

describe("logger", () => {
  it("emits one JSON line per event with sanitised fields; sensitive keys are dropped; it never throws", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l), { app: "aaf" });
    log.error("job failed for jane@corp.com", {
      error: new Error("connect postgres://u:pw@h/db failed"),
      authorization: "Bearer zzzzzzzzzzzzzzzz",
      body: "private text",
      jobId: "j1",
    });
    const o = JSON.parse(lines[0]!);
    expect(o).toMatchObject({ level: "error", app: "aaf", jobId: "j1" });
    expect(lines[0]).not.toMatch(/jane@corp|u:pw|zzzzzzzz|private text/);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      createLogger(() => {
        throw new Error("sink down");
      }).info("x", circular),
    ).not.toThrow();
  });
});

describe("Sentry configuration (audited against @sentry/core 11.11.0 defaults)", () => {
  it("switches EVERY data collector off explicitly", () => {
    const o = sentryInitOptions("https://k@o0.ingest.sentry.io/1");
    expect(o.dataCollection).toEqual({
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
    });
    expect(o.tracesSampleRate).toBe(0);
    expect(o.maxBreadcrumbs).toBe(0);
  });
  it("scrubSentryEvent removes user, breadcrumbs, request headers/body/query and stack-frame variables; masks messages", () => {
    const ev = scrubSentryEvent({
      message: "failed for jane@corp.com",
      user: { email: "jane@corp.com", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "fetch https://x/?token=secret" }],
      request: {
        url: "https://app.example/inbox?item=1&token=abc",
        method: "POST",
        headers: { cookie: "aaf_sid=SECRET" },
        data: "message body",
      },
      exception: { values: [{ value: "Bearer abcdefghijklmnop1234567 rejected", stacktrace: { frames: [{ vars: { password: "x" } }] } }] },
      extra: { to: "jane@corp.com", jobId: "j1" },
    } as Record<string, unknown>);
    const s = JSON.stringify(ev);
    expect(s).not.toMatch(/jane@corp|SECRET|abcdefghijklmnop|message body|token=|"vars"|"password"|1\.2\.3\.4/);
    expect(s).toContain("j1");
  });
  it("END TO END with the real SDK and a fake transport: what would actually be sent contains no PII or secrets", async () => {
    const Sentry = await import("@sentry/node");
    const sent: string[] = [];
    Sentry.init({
      ...sentryInitOptions("https://public@o0.ingest.sentry.io/1"),
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      }),
    });
    Sentry.setUser({ email: "jane@corp.com", id: "u-1" });
    Sentry.addBreadcrumb({ message: "GET /x?token=abc" });
    const pw = "S3cretPw";
    void pw; // a local variable that must not be captured as a stack-frame variable
    Sentry.captureException(new Error("smtp failed for jane@corp.com using Bearer abcdefghijklmnop1234567 postgres://u:S3cretPw@h/db"), {
      extra: { body: "private text", jobId: "j9", to: "jane@corp.com" },
    });
    await Sentry.flush(2000);
    await Sentry.close(2000);
    const all = sent.join("\n");
    expect(all.length).toBeGreaterThan(0); // an event really was produced
    expect(all).not.toMatch(/jane@corp|abcdefghijklmnop|S3cretPw|private text|token=abc|u-1/);
    expect(all).toContain("j9");
    expect(all).not.toContain('"type":"session"'); // release-health sessions carry the user id and bypass beforeSend
  });
  it("the session integration is removed from the default integrations (deterministic, timing-independent)", () => {
    const o = sentryInitOptions("https://public@o0.ingest.sentry.io/1");
    const integrations = o.integrations as (d: { name: string }[]) => { name: string }[];
    const kept = integrations([{ name: "ProcessSession" }, { name: "Http" }]);
    expect(kept.map((i) => i.name)).toEqual(["Http"]);
  });
});
