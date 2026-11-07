#!/usr/bin/env node
/**
 * Post-deploy verification against a URL. READ-ONLY: GET requests only, no sign-in, nothing is created or sent.
 *
 *   node scripts/verify-deployment.mjs https://<preview>.vercel.app [--bypass <vercel-protection-bypass-secret>]
 *
 * Checks: liveness, readiness (config + database + schema), that anonymous visitors are bounced to /login, that protected
 * API routes answer 401, the security headers, a per-request CSP nonce, and that no test-only mode is active.
 * Exit 0 only if every check passes.
 */
const [, , base, flag, secret] = process.argv;
if (!base?.startsWith("http")) {
  process.stderr.write("usage: verify-deployment.mjs <url> [--bypass <secret>]\n");
  process.exit(2);
}
const headers = flag === "--bypass" && secret ? { "x-vercel-protection-bypass": secret } : {};
const get = (p, init = {}) => fetch(new URL(p, base), { redirect: "manual", headers, ...init });

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push([true, name, detail ?? ""]);
  } catch (e) {
    results.push([false, name, e.message]);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

await check("liveness /api/health", async () => {
  const r = await get("/api/health");
  assert(r.status === 200, `status ${r.status}`);
  assert((await r.json()).ok === true, "not ok");
});
await check("readiness /api/ready (config + database + schema)", async () => {
  const r = await get("/api/ready");
  const j = await r.json().catch(() => ({}));
  assert(r.status === 200 && j.ok === true, `status ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  assert(j.checks?.database?.kind === "pg", `database kind is ${j.checks?.database?.kind}, expected pg`);
  return `db latency ${j.checks.database.latencyMs}ms`;
});
await check("anonymous page request is redirected to /login", async () => {
  const r = await get("/overview");
  assert([302, 303, 307, 308].includes(r.status), `status ${r.status}`);
  assert((r.headers.get("location") ?? "").includes("/login"), `location ${r.headers.get("location")}`);
});
await check("protected API route refuses anonymous callers", async () => {
  const r = await get("/api/approvals/00000000-0000-4000-8000-000000000000/eml");
  assert(r.status === 401, `status ${r.status}`);
});
await check("security headers + per-request CSP nonce", async () => {
  const a = await get("/login");
  const b = await get("/login");
  const h = a.headers;
  assert(h.get("x-frame-options") === "DENY", "x-frame-options");
  assert(h.get("x-content-type-options") === "nosniff", "nosniff");
  assert((h.get("strict-transport-security") ?? "").includes("max-age"), "hsts");
  const csp = h.get("content-security-policy") ?? "";
  assert(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/.test(csp), "script-src nonce");
  assert(!/script-src[^;]*'unsafe-inline'/.test(csp) && !/style-src[^;]*'unsafe-inline'/.test(csp), "unsafe-inline present");
  assert(csp.includes("frame-ancestors 'none'"), "frame-ancestors");
  const n1 = /'nonce-([^']+)'/.exec(csp)?.[1];
  const n2 = /'nonce-([^']+)'/.exec(b.headers.get("content-security-policy") ?? "")?.[1];
  assert(n1 && n2 && n1 !== n2, "nonce is not fresh per request");
});
await check("no information leakage on the login page", async () => {
  const t = await (await get("/login")).text();
  assert(!/postgres(ql)?:\/\/|eyJ[A-Za-z0-9_-]{20,}\.|service_role|Bearer [A-Za-z0-9]/.test(t), "secret-shaped text in HTML");
});

let failed = 0;
for (const [ok, name, detail] of results) {
  if (!ok) failed++;
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}\n`);
}
process.stdout.write(failed ? `\n${failed} check(s) failed\n` : "\nall checks passed\n");
process.exit(failed ? 1 : 0);
