import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts"], exclude: ["e2e/**", "node_modules/**"], testTimeout: 60000, hookTimeout: 60000 } });
