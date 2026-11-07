import { createHmac, timingSafeEqual } from "node:crypto";

export const TTL_MS = 12 * 3600_000;

const secret = () => process.env.AAF_SESSION_SECRET || process.env.AAF_ADMIN_PASSWORD || "dev-only-secret";
const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("hex");

export function makeToken(userId: string, now = Date.now()): string {
  const body = `${userId}.${now + TTL_MS}`;
  return `${body}.${sign(body)}`;
}

export function verifyToken(t: string | undefined, now = Date.now()): { userId: string } | null {
  if (!t) return null;
  const i = t.lastIndexOf(".");
  if (i < 0) return null;
  const body = t.slice(0, i);
  const sig = t.slice(i + 1);
  const exp = sign(body);
  if (sig.length !== exp.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const [userId, until] = body.split(".");
  if (!userId || !(Number(until) >= now)) return null;
  return { userId };
}

export function passwordMatches(given: string, want: string | undefined): boolean {
  if (!want) return false;
  const a = createHmac("sha256", "cmp").update(given).digest();
  const b = createHmac("sha256", "cmp").update(want).digest();
  return timingSafeEqual(a, b);
}
