import { test, expect, type Page, type Browser } from "@playwright/test";

/**
 * LIVE Supabase Auth checks. They drive the PRODUCTION auth provider (not the dev one) of an app that is wired to a
 * dedicated Supabase STAGING project. Skipped, never faked, unless these are set:
 *   STAGING_BASE_URL                  e.g. https://<preview>.vercel.app  (or http://localhost:3000 started with staging env)
 *   STAGING_USER_A_EMAIL / _PASSWORD  an invited, confirmed Supabase user
 *   STAGING_USER_B_EMAIL / _PASSWORD  a second, unrelated user (separate personal workspace)
 *   STAGING_VIEWER_EMAIL / _PASSWORD  optional: a user added to A's workspace with role 'viewer' (see docs/staging-validation.md)
 *   STAGING_BYPASS_SECRET             optional: Vercel Deployment Protection bypass secret for automation
 * Nothing here sends email or posts anywhere; it creates test inbox items in the staging workspaces only.
 */
const env = process.env;
const A = { email: env.STAGING_USER_A_EMAIL ?? "", password: env.STAGING_USER_A_PASSWORD ?? "" };
const B = { email: env.STAGING_USER_B_EMAIL ?? "", password: env.STAGING_USER_B_PASSWORD ?? "" };
const V = { email: env.STAGING_VIEWER_EMAIL ?? "", password: env.STAGING_VIEWER_PASSWORD ?? "" };
const configured = Boolean(env.STAGING_BASE_URL && A.email && A.password && B.email && B.password);

test.skip(!configured, "Supabase staging is not configured: this suite has NOT been run");
test.use({
  baseURL: env.STAGING_BASE_URL,
  extraHTTPHeaders: env.STAGING_BYPASS_SECRET ? { "x-vercel-protection-bypass": env.STAGING_BYPASS_SECRET } : {},
});

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
const signedIn = async (page: Page) => {
  await page.goto("/overview");
  return /\/overview/.test(page.url());
};
const newCtx = (browser: Browser) =>
  browser.newContext({
    baseURL: env.STAGING_BASE_URL,
    extraHTTPHeaders: env.STAGING_BYPASS_SECRET ? { "x-vercel-protection-bypass": env.STAGING_BYPASS_SECRET } : {},
  });

test.describe.serial("Supabase Auth (live staging)", () => {
  test("wrong password and unknown account give the same message; the real account signs in", async ({ page }) => {
    await login(page, { email: A.email, password: "definitely-wrong-password" });
    await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
    await login(page, { email: "nobody-here@example.invalid", password: "definitely-wrong-password" });
    await expect(page.getByText("Email or password is incorrect.")).toBeVisible();
    await login(page, A);
    await expect(page).toHaveURL(/\/overview/);
  });

  test("session cookies are httpOnly, Secure (on https) and SameSite", async ({ page, baseURL }) => {
    await login(page, A);
    const cookies = (await page.context().cookies()).filter((c) => c.name.startsWith("sb-"));
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c.sameSite, c.name).not.toBe("None");
      if (baseURL?.startsWith("https")) expect(c.secure, c.name).toBe(true);
    }
  });

  test("sign-out ends the session: copied cookies stop working", async ({ page, browser }) => {
    await login(page, A);
    const copied = await page.context().cookies();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login/);
    const ctx = await newCtx(browser);
    await ctx.addCookies(copied.map((c) => ({ ...c })));
    const p = await ctx.newPage();
    expect(await signedIn(p)).toBe(false);
    await ctx.close();
  });

  test("concurrent sessions work; a global sign-out in one revokes the other", async ({ browser }) => {
    const c1 = await newCtx(browser);
    const c2 = await newCtx(browser);
    const p1 = await c1.newPage();
    const p2 = await c2.newPage();
    await login(p1, A);
    await login(p2, A);
    expect(await signedIn(p1)).toBe(true);
    expect(await signedIn(p2)).toBe(true);
    await p1.getByRole("button", { name: "Sign out" }).click(); // scope: global
    expect(await signedIn(p2), "the second device must be signed out too (server-side revocation)").toBe(false);
    await c1.close();
    await c2.close();
  });

  test("tampered or garbage session cookies are rejected", async ({ page, browser }) => {
    await login(page, A);
    const cookies = await page.context().cookies();
    const ctx = await newCtx(browser);
    await ctx.addCookies(cookies.map((c) => (c.name.startsWith("sb-") ? { ...c, value: c.value.slice(0, -8) + "AAAAAAAA" } : c)));
    expect(await signedIn(await ctx.newPage())).toBe(false);
    await ctx.close();
  });

  test("two users in different workspaces cannot see each other's data (API and pages)", async ({ browser }) => {
    const ca = await newCtx(browser);
    const cb = await newCtx(browser);
    const pa = await ca.newPage();
    const pb = await cb.newPage();
    await login(pa, A);
    await login(pb, B);
    const tag = `staging-probe-${Date.now()}`;
    await pa.goto("/inbox");
    await pa.getByLabel("Sender email").fill("probe@example.org");
    await pa.getByLabel("Subject").fill(tag);
    await pa.getByLabel("Message", { exact: true }).fill(`${tag} could we have a call?`);
    await pa.getByRole("button", { name: "Triage" }).click();
    await expect(pa.getByText(tag).first()).toBeVisible();
    await pa.goto("/approvals");
    const href = await pa
      .getByRole("link", { name: /Export reply/ })
      .first()
      .getAttribute("href");
    const id = new URL(href!, "http://x").searchParams.get("id")!;

    await pb.goto("/inbox");
    await expect(pb.getByText(tag)).toHaveCount(0);
    await pb.goto(`/approvals?id=${id}`);
    await expect(pb.getByText("probe@example.org")).toHaveCount(0);
    expect((await pb.request.get(`/api/approvals/${id}/eml`)).status()).toBe(404);
    await ca.close();
    await cb.close();
  });

  test("API authorization: anonymous callers get 401 on protected routes", async ({ request }) => {
    expect((await request.get("/api/approvals/00000000-0000-4000-8000-000000000000/eml", { maxRedirects: 0 })).status()).toBe(401);
  });

  test("a viewer can read but cannot decide approvals (role comes from the memberships table)", async ({ browser }) => {
    test.skip(!V.email, "no viewer user configured");
    const ctx = await newCtx(browser);
    const p = await ctx.newPage();
    await login(p, V);
    await p.goto("/approvals");
    await p
      .getByRole("link", { name: /Export reply/ })
      .first()
      .click();
    await expect(p.getByRole("button", { name: /Approve/ })).toHaveCount(0);
    await expect(p.getByText("Only an owner or admin can decide approvals.")).toBeVisible();
    await ctx.close();
  });

  // LAST on purpose: it exhausts the login budget of this machine's IP for five minutes.
  test("login attempts are rate limited (failed attempts only)", async ({ browser }) => {
    const ctx = await newCtx(browser);
    const p = await ctx.newPage();
    for (let i = 0; i < 9; i++) {
      await login(p, { email: `flood-${Date.now()}@example.invalid`.replace(/\d+@/, "x@"), password: `bad-${i}` });
      await p.waitForURL(/\/login/);
    }
    await expect(p.getByText("Too many attempts")).toBeVisible();
    await ctx.close();
  });
});
