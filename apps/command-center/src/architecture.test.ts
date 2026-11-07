import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

/**
 * Executable architecture rules for the security model. They scan source text, so they fail the build when someone
 * adds a new way to obtain database identity, a privileged handle, or a raw environment read.
 * Changing an allowlist here is a deliberate, reviewable act.
 */
const ROOT = resolve(__dirname, "../../..");
const ROOTS = ["apps/command-center/src", "apps/command-center/trigger", "packages"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", ".data", "dist", "test-results"].includes(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const all = ROOTS.flatMap((r) => walk(join(ROOT, r)));
const runtime = all.filter((f) => !/\.test\.tsx?$/.test(f) && !rel(f).includes("/scripts/") && !rel(f).includes("/e2e/"));
const filesMatching = (re: RegExp, files = runtime) =>
  files
    .filter((f) => re.test(readFileSync(f, "utf8")))
    .map(rel)
    .sort();

describe("database identity is obtained in a small, fixed set of places", () => {
  it("only the request wrapper builds an END-USER database context, and its user id comes from the verified session", () => {
    expect(filesMatching(/kind:\s*"user",\s*userId/)).toEqual(["apps/command-center/src/lib/runtime.ts"]);
    const src = readFileSync(join(ROOT, "apps/command-center/src/lib/runtime.ts"), "utf8");
    expect(src).toMatch(/const user = await currentUser\(\)/); // verified by the auth provider
    expect(src).toMatch(/kind:\s*"user",\s*userId:\s*user\.id/); // never from a header, cookie value or form field
  });
  it("service (internal, workspace-pinned) contexts are built only by these modules", () => {
    expect(filesMatching(/kind:\s*"service",\s*workspaceId/)).toEqual([
      "apps/command-center/src/lib/actions.ts", // operator replay of a job (owner/admin checked first)
      "apps/command-center/src/lib/runtime.ts", // cost flush after a request
      "packages/brain/src/budget.ts", // budget ledger transactions
      "packages/jobs/src/runner.ts", // job execution
      "packages/jobs/src/runtime.ts", // approval write-ahead recorder, cost flush
    ]);
  });
  it("anonymous contexts exist only for pre-login work (rate limiting, schema probe, the dev identity store)", () => {
    expect(filesMatching(/kind:\s*"anon"/)).toEqual([
      "apps/command-center/src/app/api/ready/route.ts",
      "apps/command-center/src/lib/actions.ts",
      "apps/command-center/src/lib/auth/local.ts",
      "packages/database/src/driver.ts", // defines the context type
    ]);
  });
});

describe("no privileged credential or handle in runtime code", () => {
  it("the admin database URL and any service-role key are never referenced", () => {
    expect(filesMatching(/DATABASE_ADMIN_URL|SERVICE_ROLE|service_role/i)).toEqual([]);
  });
  it("the privileged owner handle (Db / .admin) is not used by the app's request code", () => {
    const appSrc = runtime.filter((f) => rel(f).startsWith("apps/command-center/src"));
    expect(filesMatching(/\.admin\b/, appSrc)).toEqual([]);
    // Db (embedded owner handle) is allowed ONLY in the module that opens the dev database and runs dev-only DDL/seed
    expect(filesMatching(/import\s*\{[^}]*\bDb\b[^}]*\}\s*from\s*"@aaf\/database"/, appSrc)).toEqual(["apps/command-center/src/lib/db.ts"]);
  });
  it("environment variables are read only by the config/boot modules", () => {
    expect(filesMatching(/process\.env/)).toEqual([
      "apps/command-center/src/instrumentation.ts",
      "apps/command-center/src/lib/config.ts",
      "apps/command-center/src/proxy.ts", // runs before config can be loaded in the edge runtime
      "apps/command-center/trigger/run-workspace.ts", // worker boot
      "packages/database/src/db.ts", // migrations dir override
      "packages/database/src/live.ts", // test harness
      "packages/database/src/testing.ts", // test harness
    ]);
  });
  it("no source file prints secrets by logging whole env or whole request objects", () => {
    expect(filesMatching(/console\.\w+\(\s*process\.env\s*\)|JSON\.stringify\(\s*process\.env\s*\)/, all)).toEqual([]);
  });
});

describe("every database-bound request goes through withApp", () => {
  it("pages and route handlers do not open database contexts themselves", () => {
    const entry = runtime.filter((f) => /apps\/command-center\/src\/app\//.test(rel(f)));
    expect(filesMatching(/database\.run\(|getDb\(/, entry)).toEqual([
      "apps/command-center/src/app/(app)/operations/page.tsx", // read-only health() + kind, no data access
      "apps/command-center/src/app/(app)/settings/page.tsx", // database.kind label
      "apps/command-center/src/app/api/jobs/tick/route.ts", // secret-authenticated scheduler hook (embedded dev DB only)
      "apps/command-center/src/app/api/ready/route.ts", // health + schema probe as anon
    ]);
  });
});
