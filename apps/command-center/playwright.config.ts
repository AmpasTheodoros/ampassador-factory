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
    env: { AAF_DATA_DIR: ":memory:", AAF_RUNTIME_MODE: "e2e", NODE_ENV: "production", AAF_DEV_EMAIL: "owner@example.test", AAF_DEV_PASSWORD: "owner-password-1", AAF_DEV_EMAIL_2: "other@example.test", AAF_DEV_PASSWORD_2: "other-password-2" },
  },
});
