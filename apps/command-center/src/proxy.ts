import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Per-request Content-Security-Policy with a fresh nonce (the pattern from Next's CSP guide), plus Supabase session
 * refresh. Scripts need the nonce ('strict-dynamic' lets Next's own scripts load their chunks); there is NO
 * 'unsafe-inline' for scripts or styles, and no inline style attributes anywhere in the UI.
 * Authorization is never decided here: it is decided server-side by withApp() against the database.
 */
export function buildCsp(nonce: string, dev: boolean, supabaseUrl?: string): string {
  const connect = ["'self'", ...(supabaseUrl ? [new URL(supabaseUrl).origin] : [])].join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const dev = process.env.NODE_ENV === "development";
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const csp = buildCsp(nonce, dev, supabaseUrl);

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  let response = NextResponse.next({ request: { headers } });

  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (supabaseUrl && key && process.env.AAF_AUTH_PROVIDER !== "local") {
    const supabase = createServerClient(supabaseUrl, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const c of list) request.cookies.set(c.name, c.value);
          response = NextResponse.next({ request: { headers } });
          for (const c of list) response.cookies.set(c.name, c.value, c.options);
        },
      },
    });
    await supabase.auth.getUser(); // validates with the Auth server and refreshes if needed
  }
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api/health|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
