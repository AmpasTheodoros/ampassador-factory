import { defineConfig } from "@playwright/test";

const PORT = 3109;
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npx next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { AAF_RUNTIME_MODE: "e2e", NODE_ENV: "production", DATABASE_URL: process.env.AAF_E2E_DATABASE_URL ?? "" },
  },
});
