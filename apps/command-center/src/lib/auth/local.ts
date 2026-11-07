import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Database } from "@aaf/database";
import type { AuthProvider, AuthUser, SignInResult } from "./types";

/** Development-only identity store. Applied only to the embedded database; the production config rejects this provider. */
export const LOCAL_AUTH_SQL = `
create table if not exists dev_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists dev_sessions (
  token_hash text primary key,
  user_id uuid not null references dev_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
grant select, insert, update on dev_users, dev_sessions to anon;
`;

export const SESSION_TTL_MS = 12 * 3600_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function hashPassword(pw: string, salt = randomBytes(16)): string {
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 32).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, hashHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const got = scryptSync(pw, Buffer.from(saltHex, "hex"), 32);
  const want = Buffer.from(hashHex, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface CookieJar {
  get(): string | undefined;
  set(value: string, maxAgeSeconds: number): void;
  clear(): void;
}

export function createLocalAuth(database: Database, jar: CookieJar, now: () => number = Date.now): AuthProvider {
  const anon = <T>(fn: (q: import("@aaf/database").Queryable) => Promise<T>) => database.run({ kind: "anon" }, fn);
  return {
    name: "local",
    async getUser(): Promise<AuthUser | null> {
      const tok = jar.get();
      if (!tok) return null;
      const rows = await anon((q) =>
        q.query<{ id: string; email: string }>(
          `select u.id, u.email from dev_sessions s join dev_users u on u.id = s.user_id
           where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2::timestamptz`,
          [sha(tok), new Date(now()).toISOString()],
        ),
      );
      return rows[0] ? { id: rows[0].id, email: rows[0].email } : null;
    },
    async signIn(email, password): Promise<SignInResult> {
      const rows = await anon((q) =>
        q.query<{ id: string; passwordHash: string }>(`select id, password_hash from dev_users where email = $1`, [email.toLowerCase()]),
      );
      const u = rows[0];
      // constant-ish work whether or not the account exists
      const ok = verifyPassword(password, u?.passwordHash ?? hashPassword("x", Buffer.alloc(16)));
      if (!u || !ok) return { ok: false, reason: "invalid" };
      const token = randomBytes(32).toString("base64url");
      await anon((q) =>
        q.query(`insert into dev_sessions(token_hash, user_id, expires_at) values ($1,$2,$3)`, [
          sha(token),
          u.id,
          new Date(now() + SESSION_TTL_MS).toISOString(),
        ]),
      );
      jar.set(token, SESSION_TTL_MS / 1000);
      return { ok: true };
    },
    async signOut() {
      const tok = jar.get();
      if (tok)
        await anon((q) => q.query(`update dev_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null`, [sha(tok)]));
      jar.clear();
    },
  };
}

export async function seedDevUser(database: Database, email: string, password: string) {
  await database.run({ kind: "anon" }, (q) =>
    q.query(`insert into dev_users(email, password_hash) values ($1,$2) on conflict (email) do nothing`, [
      email.toLowerCase(),
      hashPassword(password),
    ]),
  );
}
