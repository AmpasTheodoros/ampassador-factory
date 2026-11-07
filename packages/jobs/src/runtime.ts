import type { Database, Store } from "@aaf/database";
import { Store as StoreImpl } from "@aaf/database";
import { ToolGateway, BUILTIN_TOOLS, type Services, type Autonomous } from "@aaf/tools";
import { ModelRouter, providersFromEnv, AutonomousBudgetLedger, TxBudgetLedger, type BrainDeps, type ModelEnv, type CallEvent, type BudgetLedger } from "@aaf/brain";
import { NetworkRadarAdapter, missingConfig, type Health } from "@aaf/integrations";
import type { Job } from "./queue";
import type { BrainServices } from "./handlers";

export interface RuntimeEnv extends ModelEnv {
  AAF_OWNER_NAME?: string;
  NETWORKRADAR_MCP_URL?: string;
  NETWORKRADAR_MCP_API_KEY?: string;
}

export function networkRadarFromEnv(env: RuntimeEnv): NetworkRadarAdapter | undefined {
  if (missingConfig(env).length) return undefined;
  try {
    return new NetworkRadarAdapter({ url: env.NETWORKRADAR_MCP_URL!, apiKey: env.NETWORKRADAR_MCP_API_KEY! });
  } catch {
    return undefined; // invalid URL / insecure scheme: stays disconnected, reported by the health check
  }
}

export function gatewayServices(nr: NetworkRadarAdapter | undefined): Services {
  if (!nr) return {};
  return {
    networkradar: {
      async lookupContact(q) {
        const r = await nr.lookupContact(q);
        return { match: r.match, personId: r.personId, recordIds: r.source?.recordIds ?? [], candidates: r.candidates };
      },
    },
  };
}

/** Builds the brain dependencies for ONE transaction. Costs are deferred so they survive rollbacks. */
/**
 * Budget: with a pooled Postgres each reserve/settle is its own transaction (visible to concurrent requests at once, and
 * it survives a rollback of the request). On the single-connection embedded dev database that is impossible, so the
 * ledger runs inside the caller's transaction (still atomic, but lost if that transaction rolls back: dev only).
 */
export interface Dbs { database: Database; /** separate small pool for autonomous ledger transactions (never shared with request transactions: sharing deadlocks the pool) */ ledger?: Database }
export function ledgerFor(dbs: Dbs | undefined, store: Store): BudgetLedger | undefined {
  if (!dbs) return undefined;
  if (dbs.ledger) return new AutonomousBudgetLedger(dbs.ledger);
  if (dbs.database.kind === "pg") throw new Error("A pooled Postgres database needs a dedicated ledger pool (Dbs.ledger)");
  return new TxBudgetLedger(store.db);
}

/** Write-ahead recorder for approval execution: its own committed transaction on the dedicated pool, pinned to the workspace. */
export function autonomousFor(dbs: Dbs | undefined): Autonomous | undefined {
  const d = dbs?.ledger;
  if (!d) return undefined;
  return (ws, fn) => d.run({ kind: "service", workspaceId: ws, reason: "approval-execution" }, (q) => fn(new StoreImpl(q)));
}

export function buildBrainDeps(store: Store, env: RuntimeEnv, nr: NetworkRadarAdapter | undefined, onCall?: (e: CallEvent) => void, dbs?: Dbs) {
  const ledger = ledgerFor(dbs, store);
  const router = new ModelRouter(store, providersFromEnv(env), ledger ? { ledger, onCall } : { deferCosts: true, onCall });
  const deps: BrainDeps = {
    store,
    gateway: new ToolGateway(store, BUILTIN_TOOLS, { services: gatewayServices(nr), autonomous: autonomousFor(dbs) }),
    router,
    ownerName: env.AAF_OWNER_NAME ?? "Theodoros",
  };
  return { deps, router };
}

/** Service-role builder for jobs: after the job transaction ends, deferred model spend is flushed in its own transaction. */
export function makeBuildServices(database: Database, env: RuntimeEnv, opts: { nr?: NetworkRadarAdapter; onCall?: (e: CallEvent) => void; ledger?: Database } = {}) {
  const nr = opts.nr ?? networkRadarFromEnv(env);
  return (store: Store, job: Job): { services: BrainServices; after: () => Promise<void> } => {
    const { deps, router } = buildBrainDeps(store, env, nr, opts.onCall, { database, ledger: opts.ledger });
    return {
      services: { deps },
      after: async () => {
        if (router.pendingCosts().length === 0) return;
        await database.run({ kind: "service", workspaceId: job.workspaceId, reason: "cost-flush" }, (q) => router.flushCosts(new StoreImpl(q)).then(() => undefined));
      },
    };
  };
}

/**
 * Keeps the `networkradar` connection row truthful: "connected" only after a real health check proved the
 * read-only contract; otherwise "not_connected" with the exact blocker. Cached to avoid a network call per request.
 */
const cache = new Map<string, { at: number; health: Health }>();
export async function refreshNetworkRadarConnection(store: Store, ws: string, env: RuntimeEnv, opts: { ttlMs?: number; nr?: NetworkRadarAdapter } = {}): Promise<Health> {
  const missing = missingConfig(env);
  let h: Health;
  if (missing.length) {
    h = { status: "not_configured", missing };
  } else {
    const key = `${ws}:${env.NETWORKRADAR_MCP_URL}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (opts.ttlMs ?? 5 * 60_000)) return hit.health;
    let nr = opts.nr;
    let reason = "NETWORKRADAR_MCP_URL is invalid";
    if (!nr) {
      try {
        nr = new NetworkRadarAdapter({ url: env.NETWORKRADAR_MCP_URL!, apiKey: env.NETWORKRADAR_MCP_API_KEY! });
      } catch (e) {
        reason = (e as Error).message; // e.g. "must be a READ-ONLY key", "must be https"
      }
    }
    h = nr ? await nr.health() : { status: "blocked", code: "not_configured", reason };
    cache.set(key, { at: Date.now(), health: h });
  }
  if (h.status === "connected") await store.upsertConnection(ws, "networkradar", "connected", "Read-only: search_people, get_person, get_relationship_brief, list_actions, get_network_summary", ["networkradar.read"]);
  else if (h.status === "blocked") await store.upsertConnection(ws, "networkradar", "not_connected", `Blocked (${h.code}): ${h.reason}`);
  else await store.upsertConnection(ws, "networkradar", "not_connected", `Not configured: set ${h.missing.join(", ")}. See docs/networkradar-connectivity.md`);
  return h;
}
export function _resetNetworkRadarCache() {
  cache.clear();
}
