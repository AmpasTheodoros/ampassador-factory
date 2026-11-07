import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openTestHarness, type TestHarness } from "@aaf/database";
import { createLocalAuth, seedDevUser, hashPassword, verifyPassword, LOCAL_AUTH_SQL, SESSION_TTL_MS } from "./auth/local";
import { createSupabaseAuth } from "./auth/supabase";

describe("password hashing", () => {
  it("round-trips, salts, and rejects wrong or malformed hashes", () => {
    const h = hashPassword("correct horse");
    expect(verifyPassword("correct horse", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(hashPassword("correct horse")).not.toBe(h);
    expect(verifyPassword("x", "plaintext")).toBe(false);
    expect(h).not.toContain("correct horse");
  });
});

describe("local (development) auth provider: real sessions in the database", () => {
  let h: TestHarness;
  let cookie: string | undefined;
  let clock: number;
  const jar = {
    get: () => cookie,
    set: (v: string) => {
      cookie = v;
    },
    clear: () => {
      cookie = undefined;
    },
  };
  const make = () => createLocalAuth(h.database, jar, () => clock);
  beforeEach(async () => {
    h = await openTestHarness();
    await h.admin.exec(LOCAL_AUTH_SQL);
    await seedDevUser(h.database, "Dev@Example.com", "a-long-password");
    cookie = undefined;
    clock = Date.now();
  });
  afterEach(async () => h.close());

  it("sign-in sets an opaque token; the DB stores only its hash; getUser verifies server-side", async () => {
    const a = make();
    expect(await a.getUser()).toBeNull();
    expect(await a.signIn("dev@example.com", "a-long-password")).toEqual({ ok: true });
    expect(cookie!.length).toBeGreaterThan(30);
    const u = await a.getUser();
    expect(u?.email).toBe("dev@example.com");
    const stored = await h.admin.query(`select token_hash from dev_sessions`);
    expect(JSON.stringify(stored)).not.toContain(cookie!);
  });
  it("wrong password and unknown user fail identically; no session is created", async () => {
    const a = make();
    const r1 = await a.signIn("dev@example.com", "nope");
    const r2 = await a.signIn("ghost@example.com", "nope");
    expect(r1).toEqual(r2);
    expect(r1).toEqual({ ok: false, reason: "invalid" });
    expect((await h.admin.query(`select count(*)::int as n from dev_sessions`))[0]!["n"]).toBe(0);
    expect(cookie).toBeUndefined();
  });
  it("sessions expire", async () => {
    const a = make();
    await a.signIn("dev@example.com", "a-long-password");
    clock += SESSION_TTL_MS - 1000;
    expect(await a.getUser()).not.toBeNull();
    clock += 2000;
    expect(await a.getUser()).toBeNull();
  });
  it("sign-out revokes the session server-side: a stolen cookie stops working", async () => {
    const a = make();
    await a.signIn("dev@example.com", "a-long-password");
    const stolen = cookie!;
    await a.signOut();
    expect(cookie).toBeUndefined();
    cookie = stolen; // attacker replays the old token
    expect(await a.getUser()).toBeNull();
  });
  it("a forged token is not accepted", async () => {
    const a = make();
    cookie = "A".repeat(43);
    expect(await a.getUser()).toBeNull();
  });
  it("the anon role (pre-login) has no access to application data", async () => {
    await expect(h.database.run({ kind: "anon" }, (q) => q.query(`select * from workspaces`))).rejects.toThrow();
  });
});

describe("Supabase auth provider (fake client, not a live project)", () => {
  const client = (over: Record<string, unknown>) => ({ auth: { ...over } }) as never;
  it("returns id and email only; user_metadata and app_metadata claiming a role are ignored", async () => {
    const p = createSupabaseAuth(() =>
      client({
        getUser: async () => ({
          data: { user: { id: "u1", email: "a@b.co", user_metadata: { role: "owner", workspace: "w9" }, app_metadata: { role: "admin" } } },
          error: null,
        }),
      }),
    );
    expect(await p.getUser()).toEqual({ id: "u1", email: "a@b.co" });
  });
  it("an Auth-server rejection (expired or revoked JWT) means no user", async () => {
    const p = createSupabaseAuth(() => client({ getUser: async () => ({ data: { user: null }, error: { message: "JWT expired" } }) }));
    expect(await p.getUser()).toBeNull();
  });
  it("sign-in maps failures to invalid/error without leaking detail; sign-out is global", async () => {
    let scope: unknown;
    const bad = createSupabaseAuth(() =>
      client({ signInWithPassword: async () => ({ data: {}, error: { status: 400, message: "Invalid login credentials" } }) }),
    );
    expect(await bad.signIn("a@b.co", "x")).toEqual({ ok: false, reason: "invalid" });
    const down = createSupabaseAuth(() => client({ signInWithPassword: async () => ({ data: {}, error: { status: 503, message: "x" } }) }));
    expect(await down.signIn("a@b.co", "x")).toEqual({ ok: false, reason: "error" });
    const ok = createSupabaseAuth(() =>
      client({
        signInWithPassword: async () => ({ data: { session: { access_token: "t" } }, error: null }),
        signOut: async (o: unknown) => {
          scope = o;
          return {};
        },
      }),
    );
    expect(await ok.signIn("a@b.co", "x")).toEqual({ ok: true });
    await ok.signOut();
    expect(scope).toEqual({ scope: "global" });
  });
});
