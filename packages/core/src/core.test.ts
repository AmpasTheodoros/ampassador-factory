import { describe, it, expect } from "vitest";
import { payloadHash, makeEvent } from "./index";

describe("core", () => {
  it("hash is key-order independent", () => {
    expect(payloadHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(payloadHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
  it("hash changes when payload changes", () => {
    expect(payloadHash({ to: "a@x.com" })).not.toBe(payloadHash({ to: "b@x.com" }));
  });
  it("same externalId gives same dedupeKey", () => {
    const w = "00000000-0000-4000-8000-000000000001";
    const a = makeEvent({ workspaceId: w, source: "manual", type: "x", payload: { a: 1 }, externalId: "m1" });
    const b = makeEvent({ workspaceId: w, source: "manual", type: "x", payload: { a: 2 }, externalId: "m1" });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});
