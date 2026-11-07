/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@aaf/core", "@aaf/database", "@aaf/tools", "@aaf/brain", "@aaf/registry"],
  serverExternalPackages: ["@electric-sql/pglite"],
  outputFileTracingIncludes: { "/**": ["../../supabase/migrations/**"] },
};
