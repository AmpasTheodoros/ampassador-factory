const prod = process.env.NODE_ENV === "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${prod ? "" : " 'unsafe-eval'"}`, // Next injects inline bootstrap scripts; tighten with nonces in R2
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' https://*.supabase.co",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@aaf/core", "@aaf/database", "@aaf/tools", "@aaf/brain", "@aaf/registry", "@aaf/jobs", "@aaf/telemetry", "@aaf/integrations"],
  serverExternalPackages: ["@electric-sql/pglite", "pg", "langfuse", "posthog-node", "@sentry/node", "@modelcontextprotocol/sdk", "@trigger.dev/sdk"],
  outputFileTracingIncludes: { "/**": ["../../supabase/migrations/**"] },
  poweredByHeader: false,
  experimental: { serverActions: { allowedOrigins: process.env.AAF_APP_ORIGIN ? [new URL(process.env.AAF_APP_ORIGIN).host] : undefined } },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ...(prod ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
      ],
    }];
  },
};
