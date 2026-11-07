import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

/**
 * NetworkRadar adapter (read-only).
 *
 * Contract discovered from the NetworkRadar source (not assumed):
 *   - Remote MCP, stateless Streamable HTTP, at <origin>/mcp.
 *   - Auth: `Authorization: Bearer <MCP_API_KEY>` (maps to ONE owner) or Clerk OAuth for interactive clients.
 *   - The server has NO read-only key scope: the API key can reach every tool, including send_email.
 *   Therefore read-only is enforced HERE, twice: a fixed allow-list of tool names, and a runtime check that
 *   the server itself advertises `readOnlyHint` for the tool. Anything else is refused before any request.
 *
 * Every result carries its source (system, tool, retrieval time) and the canonical NetworkRadar record ids.
 */
export const READ_ONLY_TOOLS = ["search_people", "get_person", "get_relationship_brief", "list_actions", "get_network_summary"] as const;
export type ReadOnlyTool = (typeof READ_ONLY_TOOLS)[number];
const ALLOW = new Set<string>(READ_ONLY_TOOLS);

export type NetworkRadarErrorCode =
  | "credential_too_broad"
  | "unauthorized"
  | "forbidden_tool"
  | "not_read_only"
  | "tool_missing"
  | "contract"
  | "transport"
  | "tool_error"
  | "timeout"
  | "not_configured";
export class NetworkRadarError extends Error {
  constructor(
    public code: NetworkRadarErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NetworkRadarError";
  }
}

export interface Sourced<T> {
  data: T;
  source: { system: "networkradar"; tool: ReadOnlyTool; retrievedAt: string; recordIds: string[] };
}

const Person = z.object({ id: z.string(), name: z.string() }).passthrough();
const PersonSummary = Person.extend({
  title: z.string().nullable().optional(),
  organization: z.string().nullable().optional(),
  relationshipStatus: z.string().nullable().optional(),
}).passthrough();
const PersonFull = Person.extend({ email: z.string().nullable().optional() }).passthrough();
const Brief = z.object({ person: z.unknown(), nextMove: z.unknown().optional(), brief: z.string().optional() }).passthrough();
const Action = z.object({ id: z.string(), title: z.string(), status: z.string() }).passthrough();
const Summary = z
  .object({
    people: z.number(),
    organizations: z.number(),
    events: z.number(),
    openActions: z.number(),
    relationshipStages: z.record(z.string(), z.number()),
  })
  .passthrough();

export type PersonSummary = z.infer<typeof PersonSummary>;
export type PersonFull = z.infer<typeof PersonFull>;
export type NetworkAction = z.infer<typeof Action>;
export type NetworkSummary = z.infer<typeof Summary>;

export const READONLY_KEY_PREFIX = "nrro_";

export interface NetworkRadarConfig {
  url: string;
  apiKey: string;
  timeoutMs?: number;
  /**
   * Default true. The Company OS must hold a credential that the NetworkRadar SERVER limits to read-only tools
   * (see docs/networkradar-readonly-key). With this on: the key must carry the read-only prefix, and every call is
   * refused if the server lists even one tool that is not readOnlyHint. Turn off only for tests of the client-side allowlist.
   */
  requireRestricted?: boolean;
}
export interface AdapterOptions {
  /** Test seam: supply a transport instead of real HTTP. */
  transportFactory?: (cfg: NetworkRadarConfig) => Transport;
}

export type Health =
  | { status: "connected"; tools: string[] }
  | { status: "blocked"; code: NetworkRadarErrorCode; reason: string }
  | { status: "not_configured"; missing: string[] };

export function missingConfig(env: { NETWORKRADAR_MCP_URL?: string; NETWORKRADAR_MCP_API_KEY?: string }): string[] {
  return (["NETWORKRADAR_MCP_URL", "NETWORKRADAR_MCP_API_KEY"] as const).filter((k) => !env[k]);
}

export class NetworkRadarAdapter {
  constructor(
    private cfg: NetworkRadarConfig,
    private opts: AdapterOptions = {},
  ) {
    let u: URL;
    try {
      u = new URL(cfg.url);
    } catch {
      throw new NetworkRadarError("not_configured", "NETWORKRADAR_MCP_URL is not a valid URL");
    }
    if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname))
      throw new NetworkRadarError("not_configured", "NetworkRadar URL must be https (the API key is a bearer credential)");
    if (cfg.requireRestricted !== false && !cfg.apiKey.startsWith(READONLY_KEY_PREFIX))
      throw new NetworkRadarError(
        "not_configured",
        `NETWORKRADAR_MCP_API_KEY must be a NetworkRadar READ-ONLY key (starts with "${READONLY_KEY_PREFIX}"). Never put the full-access MCP_API_KEY in the Company OS.`,
      );
  }

  private transport(): Transport {
    if (this.opts.transportFactory) return this.opts.transportFactory(this.cfg);
    return new StreamableHTTPClientTransport(new URL(this.cfg.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } },
    });
  }

  private async withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "aaf-command-center", version: "0.1.0" }, { capabilities: {} });
    const timeoutMs = this.cfg.timeoutMs ?? 10_000;
    const timer = AbortSignal.timeout(timeoutMs);
    try {
      await Promise.race([
        client.connect(this.transport()),
        new Promise<never>((_, rej) =>
          timer.addEventListener("abort", () => rej(new NetworkRadarError("timeout", `NetworkRadar did not answer within ${timeoutMs}ms`))),
        ),
      ]);
      return await fn(client);
    } catch (e) {
      throw mapError(e);
    } finally {
      await client.close().catch(() => {});
    }
  }

  /** Allow-list first (no network), then the server's own readOnlyHint, then the call. */
  private async call<S extends z.ZodType>(
    tool: string,
    args: Record<string, unknown>,
    schema: S,
  ): Promise<{ value: z.infer<S>; retrievedAt: string }> {
    if (!ALLOW.has(tool)) throw new NetworkRadarError("forbidden_tool", `Tool "${tool}" is not on the read-only allow-list`);
    return this.withClient(async (client) => {
      const listed = await client.listTools();
      this.assertRestricted(listed.tools);
      const def = listed.tools.find((t) => t.name === tool);
      if (!def) throw new NetworkRadarError("tool_missing", `Server does not expose "${tool}" (contract drift)`);
      if (def.annotations?.readOnlyHint !== true)
        throw new NetworkRadarError("not_read_only", `Server does not mark "${tool}" as read-only; refusing to call it`);
      const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.cfg.timeoutMs ?? 10_000 });
      const content = res.content as { type: string; text?: string }[] | undefined;
      const text = content?.find((c) => c.type === "text")?.text;
      if (res.isError) throw new NetworkRadarError("tool_error", (text ?? "tool error").slice(0, 200));
      if (!text) throw new NetworkRadarError("contract", `"${tool}" returned no text content`);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new NetworkRadarError("contract", `"${tool}" returned non-JSON`);
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new NetworkRadarError("contract", `"${tool}" output did not match the expected shape`);
      return { value: parsed.data, retrievedAt: new Date().toISOString() };
    });
  }

  private sourced<T>(tool: ReadOnlyTool, value: T, retrievedAt: string, ids: string[]): Sourced<T> {
    return { data: value, source: { system: "networkradar", tool, retrievedAt, recordIds: ids } };
  }

  /** Server-side proof that the credential is restricted: nothing on its tool list may be a non-read tool. */
  private assertRestricted(tools: { name: string; annotations?: { readOnlyHint?: boolean } }[]) {
    if (this.cfg.requireRestricted === false) return;
    const broad = tools.filter((t) => t.annotations?.readOnlyHint !== true);
    if (broad.length)
      throw new NetworkRadarError(
        "credential_too_broad",
        `This credential can reach ${broad.length} tool(s) that are not read-only (for example "${broad[0]!.name}"). Refusing to use it: ask NetworkRadar for a read-only key.`,
      );
  }

  async health(): Promise<Health> {
    try {
      const tools = await this.withClient(async (c) => (await c.listTools()).tools);
      this.assertRestricted(tools);
      const byName = new Map(tools.map((t) => [t.name, t]));
      const bad = READ_ONLY_TOOLS.filter((t) => byName.get(t)?.annotations?.readOnlyHint !== true);
      if (bad.length) return { status: "blocked", code: "contract", reason: `Missing or not read-only: ${bad.join(", ")}` };
      return { status: "connected", tools: READ_ONLY_TOOLS.slice() };
    } catch (e) {
      const err = mapError(e);
      return { status: "blocked", code: err.code, reason: err.message };
    }
  }

  async searchPeople(q: { query?: string; limit?: number }): Promise<Sourced<PersonSummary[]>> {
    const r = await this.call("search_people", { query: q.query, limit: Math.min(q.limit ?? 10, 25) }, z.array(PersonSummary));
    return this.sourced(
      "search_people",
      r.value,
      r.retrievedAt,
      r.value.map((p) => p.id),
    );
  }
  async getPerson(personId: string): Promise<Sourced<PersonFull>> {
    const r = await this.call("get_person", { personId }, PersonFull);
    return this.sourced("get_person", r.value, r.retrievedAt, [r.value.id]);
  }
  async getRelationshipBrief(personId: string): Promise<Sourced<z.infer<typeof Brief>>> {
    const r = await this.call("get_relationship_brief", { personId }, Brief);
    return this.sourced("get_relationship_brief", r.value, r.retrievedAt, [personId]);
  }
  async listActions(
    filter: {
      status?: "todo" | "waiting" | "scheduled" | "done" | "cancelled";
      priority?: "critical" | "high" | "medium" | "low";
      personId?: string;
    } = {},
  ): Promise<Sourced<NetworkAction[]>> {
    const r = await this.call("list_actions", filter, z.array(Action));
    return this.sourced(
      "list_actions",
      r.value,
      r.retrievedAt,
      r.value.map((a) => a.id),
    );
  }
  async getNetworkSummary(): Promise<Sourced<NetworkSummary>> {
    const r = await this.call("get_network_summary", {}, Summary);
    return this.sourced("get_network_summary", r.value, r.retrievedAt, []);
  }

  /**
   * Identity resolution. "verified" requires an EXACT email match on the canonical record.
   * A name-only hit is a "candidate": it is shown as unverified and never used to assert facts about the sender.
   */
  async lookupContact(q: { email?: string; name?: string }): Promise<{
    match: "verified" | "candidate" | "none";
    personId?: string;
    source?: Sourced<PersonFull>["source"];
    candidates: { id: string; name: string }[];
  }> {
    const query = q.name?.trim() || q.email?.split("@")[0];
    if (!query) return { match: "none", candidates: [] };
    const found = await this.searchPeople({ query, limit: 5 });
    if (found.data.length === 0) return { match: "none", candidates: [] };
    if (q.email) {
      for (const cand of found.data.slice(0, 3)) {
        const full = await this.getPerson(cand.id);
        if (full.data.email && full.data.email.toLowerCase() === q.email.toLowerCase())
          return { match: "verified", personId: full.data.id, source: full.source, candidates: [] };
      }
    }
    return { match: "candidate", candidates: found.data.map((p) => ({ id: p.id, name: p.name })) };
  }
}

function mapError(e: unknown): NetworkRadarError {
  if (e instanceof NetworkRadarError) return e;
  const anyE = e as { code?: number | string; message?: string; name?: string };
  if (anyE?.code === 401 || anyE?.code === 403 || /\b401\b|\b403\b|unauthor/i.test(anyE?.message ?? ""))
    return new NetworkRadarError("unauthorized", "NetworkRadar rejected the credentials (401/403)");
  if (/timeout|abort/i.test(`${anyE?.name} ${anyE?.message}`)) return new NetworkRadarError("timeout", "NetworkRadar request timed out");
  return new NetworkRadarError("transport", (anyE?.message ?? "transport error").slice(0, 200));
}
