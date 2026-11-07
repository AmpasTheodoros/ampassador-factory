import { describe, it, expect } from "vitest";
import { makeToken, verifyToken, passwordMatches, TTL_MS } from "./token";

describe("session token", () => {
  it("round-trips", () => expect(verifyToken(makeToken("u1"))).toEqual({ userId: "u1" }));
  it("rejects tampering of user or expiry", () => {
    const t = makeToken("u1");
    expect(verifyToken(t.replace("u1", "u2"))).toBeNull();
    const parts = t.split(".");
    parts[1] = String(Number(parts[1]) + 999999);
    expect(verifyToken(parts.join("."))).toBeNull();
  });
  it("rejects expired, garbage and empty", () => {
    expect(verifyToken(makeToken("u1", 0), TTL_MS + 1)).toBeNull();
    expect(verifyToken("garbage")).toBeNull();
    expect(verifyToken(undefined)).toBeNull();
  });
  it("password compare fails closed when unset", () => {
    expect(passwordMatches("x", undefined)).toBe(false);
    expect(passwordMatches("x", "")).toBe(false);
    expect(passwordMatches("secret", "secret")).toBe(true);
    expect(passwordMatches("secreT", "secret")).toBe(false);
  });
});
