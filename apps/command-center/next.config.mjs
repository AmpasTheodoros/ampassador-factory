const prod = process.env.NODE_ENV === "production";
/** @type {import('next').NextConfig} */
export default {
  transpilePackages: [
    "@aaf/core",
    "@aaf/database",
    "@aaf/tools",
    "@aaf/brain",
    "@aaf/registry",
    "@aaf/jobs",
    "@aaf/telemetry",
    "@aaf/integrations",
  ],
  serverExternalPackages: [
    "@electric-sql/pglite",
    "pg",
    "langfuse",
    "posthog-node",
    "@sentry/node",
    "@modelcontextprotocol/sdk",
    "@trigger.dev/sdk",
  ],
  outputFileTracingIncludes: { "/**": ["../../supabase/migrations/**"] },
  poweredByHeader: false,
  experimental: { serverActions: { allowedOrigins: process.env.AAF_APP_ORIGIN ? [new URL(process.env.AAF_APP_ORIGIN).host] : undefined } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(prod ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
};
