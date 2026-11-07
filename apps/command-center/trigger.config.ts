import { defineConfig } from "@trigger.dev/sdk";

// SCAFFOLD, NOT VERIFIED (see trigger/run-workspace.ts). TRIGGER_PROJECT_REF comes from the Trigger.dev dashboard.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_unset",
  dirs: ["./trigger"],
  maxDuration: 300,
  retries: { enabledInDev: false, default: { maxAttempts: 2 } },
});
