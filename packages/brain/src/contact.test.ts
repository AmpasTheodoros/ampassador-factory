import { describe, it, expect } from "vitest";
import { Db, Store } from "@aaf/database";
import { ToolGateway, BUILTIN_TOOLS, type Services } from "@aaf/tools";
import { ingestMessage, type BrainDeps } from "./index";

const WS = "aaaaaaaa-0000-4000-8000-000000000001";
const MSG = { fromEmail: "maria@ikos.example", fromName: "Maria", subject: "Call?", body: "Could we have a call next week?" };

async function setup(services: Services, connected: boolean) {
  const db = await Db.open();
  const store = new Store(db);
  await store.ensureWorkspace(WS, "T", "00000000-0000-4000-8000-0000000000aa");
  if (connected) await store.upsertConnection(WS, "networkradar", "connected", "ok", ["networkradar.read"]);
  const deps: BrainDeps = { store, gateway: new ToolGateway(store, BUILTIN_TOOLS, { services }), ownerName: "Theo" };
  return { store, deps };
}
const facts = async (store: Store) =>
  ((await store.listRecommendations(WS))[0]!["why"] as { facts: { label: string; status: string; recordId?: string; value: string }[] })
    .facts;

describe("contact verification labels (NetworkRadar lookup via the tool gateway)", () => {
  it("exact-email match => verified, with the canonical record id in facts and provenance", async () => {
    const { store, deps } = await setup(
      {
        networkradar: {
          lookupContact: async () => ({ match: "verified", personId: "ckperson1", recordIds: ["ckperson1"], candidates: [] }),
        },
      },
      true,
    );
    await ingestMessage(deps, WS, MSG);
    const f = (await facts(store)).find((x) => x.label === "NetworkRadar record")!;
    expect(f).toMatchObject({ status: "verified", recordId: "ckperson1", value: "ckperson1" });
    const prov = (await store.listRecommendations(WS))[0]!["provenance"] as { source: string; kind: string; recordId?: string }[];
    expect(prov.find((p) => p.source === "networkradar")).toMatchObject({ kind: "record", recordId: "ckperson1" });
  });
  it("name-only candidates are NOT verified and nothing about the person is asserted", async () => {
    const { store, deps } = await setup(
      {
        networkradar: {
          lookupContact: async () => ({ match: "candidate", recordIds: [], candidates: [{ id: "ckx", name: "Maria Georgiou" }] }),
        },
      },
      true,
    );
    await ingestMessage(deps, WS, MSG);
    expect((await facts(store)).find((x) => x.label === "NetworkRadar record")).toMatchObject({
      status: "unverified",
      value: "name-only candidates",
    });
  });
  it("no record => unverified", async () => {
    const { store, deps } = await setup(
      { networkradar: { lookupContact: async () => ({ match: "none", recordIds: [], candidates: [] }) } },
      true,
    );
    await ingestMessage(deps, WS, MSG);
    expect((await facts(store)).find((x) => x.label === "NetworkRadar record")!.status).toBe("unverified");
  });
  it("connector blocked at runtime (adapter throws) => triage still completes, unverified, error recorded", async () => {
    const { store, deps } = await setup(
      {
        networkradar: {
          lookupContact: async () => {
            throw new Error("unauthorized");
          },
        },
      },
      true,
    );
    const r = await ingestMessage(deps, WS, MSG);
    expect(r.triage!.approvalId).toBeTruthy();
    expect((await facts(store)).find((x) => x.label === "NetworkRadar record")!.status).toBe("unverified");
    expect((await store.listToolCalls(WS)).some((c) => c["toolId"] === "networkradar.lookup_contact" && c["outcome"] === "failed")).toBe(
      true,
    );
  });
  it("not connected => the lookup never runs", async () => {
    let called = 0;
    const { store, deps } = await setup(
      {
        networkradar: {
          lookupContact: async () => {
            called++;
            return { match: "none", recordIds: [], candidates: [] };
          },
        },
      },
      false,
    );
    await ingestMessage(deps, WS, MSG);
    expect(called).toBe(0);
    expect((await store.listToolCalls(WS)).find((c) => c["toolId"] === "networkradar.lookup_contact")).toMatchObject({ outcome: "denied" });
  });
});
