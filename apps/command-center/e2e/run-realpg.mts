/**
 * Runs the SAME Playwright suite against the app wired to a REAL PostgreSQL as the least-privileged `aaf_app` login role.
 *
 *   pnpm --filter @aaf/database localpg start
 *   pnpm --filter @aaf/command-center build
 *   pnpm --filter @aaf/command-center e2e:realpg
 *
 * Provisioning mirrors production (admin migrates, creates aaf_app NOINHERIT; the app only ever connects as aaf_app).
 * Authentication is still the DEV provider (no Supabase here), so this proves the database path, not Supabase Auth.
 */
import { spawn } from "node:child_process";
import { openRealPgHarness } from "@aaf/database";
import { LOCAL_AUTH_SQL, hashPassword } from "../src/lib/auth/local";

const h = await openRealPgHarness({ poolMax: 2 });
let code = 1;
try {
  await h.admin.exec(LOCAL_AUTH_SQL);
  for (const [email, pw] of [
    ["owner@example.test", "owner-password-1"],
    ["other@example.test", "other-password-2"],
  ] as const)
    await h.admin.query(`insert into dev_users(email, password_hash) values ($1,$2)`, [email, hashPassword(pw)]);
  code = await new Promise<number>((resolve) => {
    const p = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.realpg.config.ts"], {
      stdio: "inherit",
      env: { ...process.env, AAF_E2E_DATABASE_URL: h.appUrl },
    });
    p.on("close", (c) => resolve(c ?? 1));
  });
} finally {
  await h.close();
}
process.exit(code);
