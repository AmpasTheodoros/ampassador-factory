import { describe, it, expect } from "vitest";
import { sanitize, maskString, FanoutTelemetry, noopTelemetry, createTelemetry, langfuseSink, sentrySink, posthogSink, pseudonym, type Sink } from "./index";

describe("sanitize", () => {
  it("drops sensitive keys and masks identifiers in remaining strings", () => {
    const out = sanitize({
      tool: "gmail.send", workspace: "w1", password: "hunter2", apiKey: "k", Authorization: "Bearer abc", body: "dear jane", subject: "s",
      note: "contact jane@corp.com or +30 690 123 4567", nested: { token: "t", ok: 1, list: ["a@b.co", 5] },
    }) as Record<string, unknown>;
    expect(out).toEqual({ tool: "gmail.send", workspace: "w1", note: "contact [email] or [phone]", nested: { ok: 1, list: ["[email]", 5] } });
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
    const bad: Sink = { name: "bad", modelCall: () => { throw new Error("boom"); }, error: () => { throw new Error("boom"); }, event: () => { throw new Error("boom"); }, flush: async () => { throw new Error("boom"); } };
    const good: Sink = { name: "good", event: (n) => void seen.push(n), error: () => void seen.push("err"), modelCall: () => void seen.push("mc") };
    const t = new FanoutTelemetry([bad, good]);
    t.event("x"); t.error(new Error("e")); t.modelCall({ task: "t", providerId: "p", model: "m", location: "cloud", ok: true, durationMs: 1, tokensIn: 1, tokensOut: 1, costEur: 0, redacted: false, workspaceId: "w" });
    await expect(t.flush()).resolves.toBeUndefined();
    expect(seen).toEqual(["x", "err", "mc"]);
  });
  it("never forwards raw workspace ids, message text or addresses", () => {
    const got: unknown[] = [];
    const t = new FanoutTelemetry([{ name: "s", modelCall: (e) => got.push(e), error: (e, c) => got.push([e, c]), event: (n, p) => got.push([n, p]) }]);
    t.modelCall({ task: "classify", providerId: "p", model: "m", location: "cloud", ok: false, durationMs: 5, tokensIn: 1, tokensOut: 0, costEur: 0, redacted: true, workspaceId: "11111111-2222-4333-8444-555555555555", error: "failed for jane@corp.com" });
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
    const fake = { trace: (b: unknown) => { traces.push(b); return { generation: (g: Record<string, unknown>) => void gens.push(g) }; }, flushAsync: async () => {} };
    const t = new FanoutTelemetry([langfuseSink(fake)]);
    t.modelCall({ task: "draft", providerId: "p", model: "m1", location: "local", ok: true, durationMs: 120, tokensIn: 10, tokensOut: 5, costEur: 0.01, redacted: false, workspaceId: "w" });
    expect(gens[0]).toMatchObject({ model: "m1", usage: { input: 10, output: 5, totalCost: 0.01 } });
    expect(Object.keys(gens[0]!)).not.toContain("input");
    expect(Object.keys(gens[0]!)).not.toContain("output");
  });
  it("sentry gets sanitised extras; posthog gets sanitised events", () => {
    const cap: unknown[] = [];
    const t = new FanoutTelemetry([sentrySink({ captureException: (e, h) => void cap.push([e, h]), flush: async () => true }), posthogSink({ capture: (p) => void cap.push(p) })]);
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
    const t = await createTelemetry({ NEXT_PUBLIC_POSTHOG_KEY: "phc_test_key_for_construction_only", NEXT_PUBLIC_POSTHOG_HOST: "http://127.0.0.1:9" });
    expect(t.sinks).toEqual(["posthog"]);
  });
});
