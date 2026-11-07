import "server-only";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { Store, type Queryable } from "@aaf/database";
import { DomainError } from "@aaf/core";
import { buildBrainDeps, networkRadarFromEnv } from "@aaf/jobs";
import type { BrainDeps, ModelRouter } from "@aaf/brain";
import type { ToolGateway } from "@aaf/tools";
import { getEnv } from "./config";
import { getDb } from "./db";
import { getAuth } from "./auth";
import type { AuthUser } from "./auth/types";
import { getTelemetry, runtimeEnv } from "./services";

export type Role = "owner" | "admin" | "member" | "viewer";

export interface App {
  user: AuthUser;
  workspaceId: string;
  role: Role;
  store: Store;
  gateway: ToolGateway;
  deps: BrainDeps;
  router: ModelRouter;
}

const DEFAULT_CONNECTORS: [string, string][] = [
  ["gmail", "Adapter not built. Paste messages into the Inbox; approved replies are exported, not sent."],
  ["google_calendar", "Adapter not built. Meetings are not shown."],
  ["networkradar", "Not checked yet."],
  ["github", "Not connected."],
  ["posthog", "Not connected."],
];

/** Origin check beyond Next's own: mutating requests must come from the configured origin (or the request host in dev). */
export async function assertSameOrigin() {
  const env = getEnv();
  const h = await headers();
  const origin = h.get("origin");
  if (!origin) throw new DomainError("csrf", "Missing Origin header");
  const expected = env.AAF_APP_ORIGIN ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  if (origin !== new URL(expected).origin) throw new DomainError("csrf", "Cross-origin request refused");
}

export async function currentUser(): Promise<AuthUser | null> {
  const auth = await getAuth();
  return auth ? auth.getUser() : null;
}

export interface WithAppOptions {
  mutating?: boolean;
  noRedirect?: boolean;
}

/**
 * One request = one transaction as the verified end user, so RLS is enforced for everything inside `fn`.
 * Redirects must be issued OUTSIDE `fn` (a throw inside rolls the transaction back).
 * Model spend is deferred and written in its own transaction afterwards, so it is never lost to a rollback.
 */
export async function withApp<T>(fn: (app: App) => Promise<T>, opts: WithAppOptions & { noRedirect: true }): Promise<T | null>;
export async function withApp<T>(fn: (app: App) => Promise<T>, opts?: WithAppOptions): Promise<T>;
export async function withApp<T>(fn: (app: App) => Promise<T>, opts: WithAppOptions = {}): Promise<T | null> {
  if (opts.mutating) await assertSameOrigin();
  const user = await currentUser();
  if (!user) {
    if (opts.noRedirect) return null;
    redirect("/login");
  }
  const env = getEnv();
  const tel = await getTelemetry();
  const { database, ledger: ledgerDb } = await getDb();
  let flush: (() => Promise<void>) | undefined;
  try {
    return await database.run({ kind: "user", userId: user.id }, async (q: Queryable) => {
      const store = new Store(q);
      if (!(await store.rateHit(`req:${user.id}`, opts.mutating ? 60 : 240, 60))) throw new DomainError("rate_limited", "Too many requests; slow down");
      let m = await store.firstWorkspaceFor(user.id);
      if (!m) {
        const id = await store.provisionWorkspace(env.AAF_OWNER_NAME);
        for (const [c, d] of DEFAULT_CONNECTORS) await store.ensureConnection(id, c, "not_connected", d);
        m = { id, role: "owner" };
      }
      const ws = m.id;
      const { deps, router } = buildBrainDeps(store, runtimeEnv(), networkRadarFromEnv(runtimeEnv()), (e) => tel.modelCall({ ...e, model: e.modelLabel }), { database, ledger: ledgerDb });
      flush = async () => {
        if (router.pendingCosts().length === 0) return;
        await database.run({ kind: "service", workspaceId: ws, reason: "cost-flush" }, (sq) => router.flushCosts(new Store(sq)).then(() => undefined));
      };
      return fn({ user, workspaceId: ws, role: m.role as Role, store, gateway: deps.gateway, deps, router });
    });
  } catch (e) {
    if (!(e as { digest?: string })?.digest?.startsWith?.("NEXT_")) tel.error(e, { where: "withApp" });
    throw e;
  } finally {
    if (flush) await flush().catch((e) => tel.error(e, { where: "cost-flush" }));
  }
}
