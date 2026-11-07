import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { OWNER_USER_ID } from "./runtime";
import { makeToken, verifyToken, passwordMatches, TTL_MS } from "./token";

const COOKIE = "aaf_session";

export type AuthMode = "password" | "dev_open" | "unconfigured";

/** password: AAF_ADMIN_PASSWORD set. dev_open: nothing set AND not production (clearly bannered). unconfigured: production without password => nobody can log in. */
export function authMode(): AuthMode {
  if (process.env.AAF_ADMIN_PASSWORD) return "password";
  return process.env.NODE_ENV === "production" ? "unconfigured" : "dev_open";
}
export const checkPassword = (p: string) => passwordMatches(p, process.env.AAF_ADMIN_PASSWORD);

export interface Session { userId: string; role: "owner"; mode: AuthMode }

export async function getSession(): Promise<Session | null> {
  const mode = authMode();
  if (mode === "dev_open") return { userId: OWNER_USER_ID, role: "owner", mode };
  if (mode === "unconfigured") return null;
  const c = (await cookies()).get(COOKIE)?.value;
  const v = verifyToken(c);
  return v ? { userId: OWNER_USER_ID, role: "owner", mode } : null;
}
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}
export async function setSessionCookie() {
  (await cookies()).set(COOKIE, makeToken(OWNER_USER_ID), { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: TTL_MS / 1000 });
}
export async function clearSessionCookie() {
  (await cookies()).delete(COOKIE);
}
