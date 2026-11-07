import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { NetworkRadarAdapter, NetworkRadarError, READ_ONLY_TOOLS, missingConfig } from "./index";

/**
 * CONTRACT TEST AGAINST A LOCAL MOCK. Not a test of the live NetworkRadar deployment.
 * The mock reproduces what the NetworkRadar source documents: stateless Streamable HTTP, Bearer auth,
 * read tools annotated readOnlyHint, write tools present on the same server, results as JSON text.
 */
const KEY = "nrro_" + "t".repeat(43);              // a read-only key: the (patched) server limits it to the five read tools
const FULL_KEY = "full-access-key-not-a-real-credential"; // the legacy full-access key: the server exposes EVERYTHING to it
const LEAKY_KEY = "nrro_" + "L".repeat(43);          // looks read-only but the server (misconfigured) gives it the full surface
const calls: string[] = [];
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (m: string) => ({ isError: true, content: [{ type: "text" as const, text: m }] });

const PEOPLE = [
  { id: "ckperson1", name: "Maria Papadopoulou", title: "COO", organization: "Ikos", tier: "A", relationshipStatus: "warm", overallScore: 80, lastContact: null, lastConversation: null, email: "maria@ikos.example" },
  { id: "ckperson2", name: "Maria Georgiou", title: "Buyer", organization: "Sani", tier: "B", relationshipStatus: "cold", overallScore: 40, lastContact: null, lastConversation: null, email: "m.georgiou@sani.example" },
];

function buildServer(restricted: boolean) {
  const s = new McpServer({ name: "mock-network-radar", version: "0" });
  const ro = { readOnlyHint: true };
  s.registerTool("search_people", { description: "d", inputSchema: { query: z.string().optional(), limit: z.number().optional() }, annotations: ro }, async ({ query }) => {
    calls.push("search_people");
    return ok(PEOPLE.filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase())).map(({ email: _e, ...rest }) => rest));
  });
  s.registerTool("get_person", { description: "d", inputSchema: { personId: z.string() }, annotations: ro }, async ({ personId }) => {
    calls.push("get_person");
    const p = PEOPLE.find((x) => x.id === personId);
    return p ? ok(p) : fail(`No person with id ${personId}.`);
  });
  s.registerTool("get_relationship_brief", { description: "d", inputSchema: { personId: z.string() }, annotations: ro }, async ({ personId }) => {
    calls.push("get_relationship_brief");
    return ok({ person: { id: personId }, nextMove: { type: "reply" }, brief: "Warm; owes them a one-pager." });
  });
  s.registerTool("list_actions", { description: "d", inputSchema: { status: z.string().optional(), personId: z.string().optional() }, annotations: ro }, async () => {
    calls.push("list_actions");
    return ok([{ id: "ckaction1", title: "Send one-pager", status: "todo", priority: "high" }]);
  });
  s.registerTool("get_network_summary", { description: "d", inputSchema: {}, annotations: ro }, async () => {
    calls.push("get_network_summary");
    return ok({ people: 2, organizations: 2, events: 1, openActions: 1, relationshipStages: { warm: 1, cold: 1 } });
  });
  if (restricted) return s; // what the patched NetworkRadar serves a read-only key: nothing else exists
  // dangerous tools living on the same server, exactly like the real (unpatched) one
  s.registerTool("send_email", { description: "SENDS EMAIL", inputSchema: { to: z.string() } }, async () => { calls.push("send_email"); return ok({ sent: true }); });
  s.registerTool("set_relationship_objective", { description: "writes", inputSchema: { personId: z.string() } }, async () => { calls.push("set_relationship_objective"); return ok({}); });
  return s;
}

let server: http.Server;
let url: string;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const known: Record<string, boolean> = { [KEY]: true, [FULL_KEY]: false, [LEAKY_KEY]: false }; // value = restricted?
    if (!(bearer in known)) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer resource_metadata="x"' }).end("Unauthorized");
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const mcp = buildServer(known[bearer]!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const adapter = (key = KEY, extra: object = {}) => new NetworkRadarAdapter({ url, apiKey: key, timeoutMs: 8000, ...extra });

describe("NetworkRadar adapter: contract against a local mock MCP server (real HTTP, real MCP SDK)", () => {
  it("health: connected, and reports the read-only tools only", async () => {
    const h = await adapter().health();
    expect(h).toEqual({ status: "connected", tools: [...READ_ONLY_TOOLS] });
  });

  it("wrong or missing credentials => blocked: unauthorized, never connected", async () => {
    const wrong = "nrro_" + "w".repeat(43);
    const h = await adapter(wrong).health();
    expect(h).toMatchObject({ status: "blocked", code: "unauthorized" });
    await expect(adapter(wrong).getNetworkSummary()).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("the five read operations return typed data with canonical ids and source provenance", async () => {
    const a = adapter();
    const s = await a.searchPeople({ query: "Maria" });
    expect(s.data.map((p) => p.id)).toEqual(["ckperson1", "ckperson2"]);
    expect(s.source).toMatchObject({ system: "networkradar", tool: "search_people", recordIds: ["ckperson1", "ckperson2"] });
    expect(new Date(s.source.retrievedAt).getTime()).toBeGreaterThan(0);
    expect((await a.getPerson("ckperson1")).source.recordIds).toEqual(["ckperson1"]);
    expect((await a.getRelationshipBrief("ckperson1")).data.brief).toMatch(/one-pager/);
    expect((await a.listActions({ status: "todo" })).source.recordIds).toEqual(["ckaction1"]);
    expect((await a.getNetworkSummary()).data.openActions).toBe(1);
  });

  it("a tool-level error from the server is surfaced, not swallowed", async () => {
    await expect(adapter().getPerson("missing")).rejects.toMatchObject({ code: "tool_error" });
  });

  it("CANNOT call write tools: refused client-side before any request reaches the server", async () => {
    calls.length = 0;
    // strict mode OFF + the full-access key: this isolates the client-side allowlist as the only barrier
    const a = adapter(FULL_KEY, { requireRestricted: false }) as unknown as { call: (t: string, a: object, s: z.ZodType) => Promise<unknown> };
    for (const t of ["send_email", "set_relationship_objective", "create_person", "approve_chief_reply"])
      await expect(a.call(t, {}, z.unknown())).rejects.toMatchObject({ code: "forbidden_tool" });
    expect(calls).toEqual([]);
  });

  it("refuses an allow-listed tool if the SERVER does not mark it read-only (defence in depth)", async () => {
    const lax = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const s = new McpServer({ name: "drifted", version: "0" });
      s.registerTool("get_person", { description: "now writes!", inputSchema: { personId: z.string() } }, async () => ok(PEOPLE[0]));
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await s.connect(t);
      await t.handleRequest(req, res, chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined);
    });
    await new Promise<void>((r) => lax.listen(0, "127.0.0.1", r));
    const u = `http://127.0.0.1:${(lax.address() as AddressInfo).port}/mcp`;
    // strict mode ON: the missing annotation is caught as an over-broad credential
    const strict = new NetworkRadarAdapter({ url: u, apiKey: KEY });
    await expect(strict.getPerson("ckperson1")).rejects.toMatchObject({ code: "credential_too_broad" });
    expect(await strict.health()).toMatchObject({ status: "blocked", code: "credential_too_broad" });
    // strict mode OFF: the per-tool readOnlyHint check still refuses it
    const a = new NetworkRadarAdapter({ url: u, apiKey: "x", requireRestricted: false });
    await expect(a.getPerson("ckperson1")).rejects.toMatchObject({ code: "not_read_only" });
    expect(await a.health()).toMatchObject({ status: "blocked", code: "contract" });
    await new Promise((r) => lax.close(r));
  });

  it("lookupContact: VERIFIED only on exact email match; same-name different person is only a candidate", async () => {
    const a = adapter();
    const v = await a.lookupContact({ email: "maria@ikos.example", name: "Maria" });
    expect(v).toMatchObject({ match: "verified", personId: "ckperson1" });
    expect(v.source).toMatchObject({ tool: "get_person", recordIds: ["ckperson1"] });
    const c = await a.lookupContact({ email: "someone.else@elsewhere.example", name: "Maria" });
    expect(c.match).toBe("candidate");
    expect(c.personId).toBeUndefined();
    expect(c.candidates).toHaveLength(2);
    expect(await a.lookupContact({ email: "x@y.example", name: "Nobody Atall" })).toMatchObject({ match: "none" });
  });

  it("insecure http to a remote host is refused at construction (bearer credential)", () => {
    expect(() => new NetworkRadarAdapter({ url: "http://netwrokradar.vercel.app/mcp", apiKey: "k" })).toThrow(/https/);
    expect(() => new NetworkRadarAdapter({ url: "not a url", apiKey: "k" })).toThrow(NetworkRadarError);
  });

  it("an unreachable server is reported as blocked/transport, quickly and without throwing from health()", async () => {
    const h = await new NetworkRadarAdapter({ url: "http://127.0.0.1:9/mcp", apiKey: KEY, timeoutMs: 2000 }).health();
    expect(h.status).toBe("blocked");
  });

  it("the full-access key is REFUSED at construction: the Company OS can only hold a read-only key", () => {
    expect(() => adapter(FULL_KEY)).toThrow(/READ-ONLY key/);
    expect(() => adapter("")).toThrow(/READ-ONLY key/);
    try { adapter(FULL_KEY); } catch (e) { expect((e as NetworkRadarError).code).toBe("not_configured"); expect((e as Error).message).not.toContain(FULL_KEY); }
  });

  it("a key that LOOKS read-only but whose server grants write tools is refused on every call, before any tool runs", async () => {
    calls.length = 0;
    const a = adapter(LEAKY_KEY);
    expect(await a.health()).toMatchObject({ status: "blocked", code: "credential_too_broad" });
    await expect(a.searchPeople({ query: "Maria" })).rejects.toMatchObject({ code: "credential_too_broad" });
    await expect(a.lookupContact({ email: "maria@ikos.example", name: "Maria" })).rejects.toMatchObject({ code: "credential_too_broad" });
    expect(calls).toEqual([]); // not even the read tools were executed
  });

  it("against a correctly restricted server the tool list is exactly the five read tools", async () => {
    const tools = await new Promise<string[]>(async (resolve) => {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const c = new Client({ name: "t", version: "0" }, { capabilities: {} });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${KEY}` } } }));
      resolve((await c.listTools()).tools.map((t) => t.name).sort());
      await c.close();
    });
    expect(tools).toEqual([...READ_ONLY_TOOLS].sort());
  });

  it("missingConfig names absent variables without echoing values", () => {
    expect(missingConfig({})).toEqual(["NETWORKRADAR_MCP_URL", "NETWORKRADAR_MCP_API_KEY"]);
    expect(missingConfig({ NETWORKRADAR_MCP_URL: "https://x" })).toEqual(["NETWORKRADAR_MCP_API_KEY"]);
  });
});
