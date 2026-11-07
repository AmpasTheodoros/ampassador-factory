import type { Database, Store } from "@aaf/database";
import { Store as StoreImpl } from "@aaf/database";
import { ToolGateway, BUILTIN_TOOLS, type Services } from "@aaf/tools";
import { ModelRouter, providersFromEnv, type BrainDeps, type ModelEnv, type CallEvent } from "@aaf/brain";
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
export function buildBrainDeps(store: Store, env: RuntimeEnv, nr: NetworkRadarAdapter | undefined, onCall?: (e: CallEvent) => void) {
  const router = new ModelRouter(store, providersFromEnv(env), { deferCosts: true, onCall });
  const deps: BrainDeps = {
    store,
    gateway: new ToolGateway(store, BUILTIN_TOOLS, { services: gatewayServices(nr) }),
    router,
    ownerName: env.AAF_OWNER_NAME ?? "Theodoros",
  };
  return { deps, router };
}

/** Service-role builder for jobs: after the job transaction ends, deferred model spend is flushed in its own transaction. */
export function makeBuildServices(database: Database, env: RuntimeEnv, opts: { nr?: NetworkRadarAdapter; onCall?: (e: CallEvent) => void } = {}) {
  const nr = opts.nr ?? networkRadarFromEnv(env);
  return (store: Store, job: Job): { services: BrainServices; after: () => Promise<void> } => {
    const { deps, router } = buildBrainDeps(store, env, nr, opts.onCall);
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
    const nr = opts.nr ?? networkRadarFromEnv(env);
    h = nr ? await nr.health() : { status: "blocked", code: "not_configured", reason: "NETWORKRADAR_MCP_URL is invalid or not https" };
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
