import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { authProviderName, getEnv, isProd } from "../config";
import { getDb } from "../db";
import { createSupabaseAuth } from "./supabase";
import { createLocalAuth, SESSION_TTL_MS } from "./local";
import type { AuthProvider } from "./types";


/** Per-request provider (cookies are request-scoped). Returns null when no provider is usable, which closes the app. */
export async function getAuth(): Promise<AuthProvider | null> {
  const env = getEnv();
  const name = authProviderName(env);
  const jar = await cookies();
  if (name === "supabase") {
    return createSupabaseAuth(() =>
      createServerClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        cookies: {
          getAll: () => jar.getAll(),
          setAll: (list) => {
            try {
              for (const c of list) jar.set(c.name, c.value, c.options);
            } catch {
              /* called from a Server Component: the proxy refreshes the session instead */
            }
          },
        },
      }),
    );
  }
  if (name === "local") {
    const LOCAL_COOKIE = isProd(env) ? "__Host-aaf_sid" : "aaf_sid";
    const { database } = await getDb();
    return createLocalAuth(database, {
      get: () => jar.get(LOCAL_COOKIE)?.value,
      set: (v, maxAge) => jar.set(LOCAL_COOKIE, v, { httpOnly: true, sameSite: "lax", secure: isProd(env), path: "/", maxAge: Math.min(maxAge, SESSION_TTL_MS / 1000) }),
      clear: () => jar.delete(LOCAL_COOKIE),
    });
  }
  return null;
}
