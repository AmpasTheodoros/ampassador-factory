import { defineConfig } from "@playwright/test";

// Live Supabase Auth checks against STAGING_BASE_URL. No web server is started: point it at a deployed preview or at a
// local server you started with the staging environment. See docs/staging-validation.md.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /supabase-staging\.spec\.ts/,
  timeout: 90_000,
  workers: 1,
  retries: 0,
});
