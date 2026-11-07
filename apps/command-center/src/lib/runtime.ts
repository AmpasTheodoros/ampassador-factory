import "server-only";
import { Db, Store } from "@aaf/database";
import { ToolGateway, BUILTIN_TOOLS } from "@aaf/tools";
import { ModelRouter, OpenAICompatProvider, type BrainDeps, type LlmProvider } from "@aaf/brain";

export const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const OWNER_USER_ID = "00000000-0000-4000-8000-0000000000a1";

export interface Runtime {
  db: Db;
  store: Store;
  gateway: ToolGateway;
  deps: BrainDeps;
  llm: { configured: boolean; location?: string; model?: string };
}

const g = globalThis as unknown as { __aaf?: Promise<Runtime> };

async function boot(): Promise<Runtime> {
  const dir = process.env.AAF_DATA_DIR ?? ".data/pglite";
  const db = await Db.open({ dataDir: process.env.AAF_DATA_DIR === ":memory:" ? undefined : dir });
  const store = new Store(db);
  await store.ensureWorkspace(WORKSPACE_ID, "Theodoros (personal)", OWNER_USER_ID);
  // Honest connector status: nothing is connected in R1. Rows are only written when absent.
  const existing = new Set((await store.listConnections(WORKSPACE_ID)).map((c) => c["connector"]));
  const defaults: [string, string][] = [
    ["gmail", "Adapter not built (R2). Paste messages into the Inbox; approved replies are exported, not sent."],
    ["google_calendar", "Adapter not built (R2). Meetings are not shown."],
    ["networkradar", "Adapter not built (R2): no verified API contract reachable from the deployed app yet. Contacts are not verified."],
    ["github", "Not connected."],
    ["posthog", "Not connected."],
  ];
  for (const [c, d] of defaults) if (!existing.has(c)) await store.upsertConnection(WORKSPACE_ID, c, "not_connected", d);

  const providers: LlmProvider[] = [];
  const base = process.env.AAF_LLM_BASE_URL;
  const model = process.env.AAF_LLM_MODEL;
  const loc = process.env.AAF_LLM_LOCATION === "local" ? "local" : "cloud";
  if (base && model) providers.push(new OpenAICompatProvider("configured-llm", loc, { baseUrl: base, model, apiKey: process.env.AAF_LLM_API_KEY }));
  const router = new ModelRouter(store, providers);
  const gateway = new ToolGateway(store, BUILTIN_TOOLS);
  const deps: BrainDeps = { store, gateway, router, ownerName: process.env.AAF_OWNER_NAME ?? "Theodoros" };
  return { db, store, gateway, deps, llm: { configured: providers.length > 0, location: providers.length ? loc : undefined, model: providers.length ? model : undefined } };
}

export function runtime(): Promise<Runtime> {
  return (g.__aaf ??= boot());
}
