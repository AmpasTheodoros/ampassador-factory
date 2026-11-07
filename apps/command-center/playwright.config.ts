import { defineConfig } from "@playwright/test";

const PORT = 3107;
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
    env: { AAF_DATA_DIR: ":memory:", AAF_ADMIN_PASSWORD: "e2e-password", AAF_SESSION_SECRET: "e2e-secret", NODE_ENV: "production" },
  },
});
