import { describe, it, expect, beforeAll } from "vitest";
import { Db } from "./db";
import { Store } from "./store";
import { makeEvent, newId } from "@aaf/core";

const WA = "aaaaaaaa-0000-4000-8000-000000000001";
const WB = "bbbbbbbb-0000-4000-8000-000000000002";
const UA = "11111111-0000-4000-8000-000000000001"; // owner of A
const UB = "22222222-0000-4000-8000-000000000002"; // owner of B
const VIEW = "33333333-0000-4000-8000-000000000003"; // viewer of A

let db: Db, store: Store;
let approvalA: string;

beforeAll(async () => {
  db = await Db.open();
  store = new Store(db);
  await store.ensureWorkspace(WA, "A", UA);
  await store.ensureWorkspace(WB, "B", UB, "client");
  await db.query(`insert into memberships values ($1,$2,'viewer')`, [WA, VIEW]);
  await store.createTask(WA, { title: "A secret task" });
  await store.createTask(WB, { title: "B secret task" });
  approvalA = newId();
  await store.insertApproval({ id: approvalA, workspaceId: WA, toolId: "gmail.send", riskTier: "external_communication", payload: { to: "x" }, payloadHash: "h", status: "awaiting_approval", summary: "s", sourceContext: {}, requestedBy: "agent", expiresAt: new Date(Date.now() + 1e6).toISOString(), idempotencyKey: "k1" });
  await store.audit(WA, "system", "seed", "x");
});

describe("RLS (allow/deny, two workspaces)", () => {
  it("owner sees only own workspace rows", async () => {
    const rows = await db.asUser(UA, (q) => q.query<{ title: string }>(`select title from tasks`));
    expect(rows.map((r) => r.title)).toEqual(["A secret task"]);
  });
  it("other tenant cannot read A", async () => {
    const rows = await db.asUser(UB, (q) => q.query<{ title: string }>(`select title from tasks`));
    expect(rows.map((r) => r.title)).toEqual(["B secret task"]);
  });
  it("tenant B cannot insert into A", async () => {
    await expect(db.asUser(UB, (q) => q.query(`insert into tasks(id,workspace_id,title) values ($1,$2,'evil')`, [newId(), WA]))).rejects.toThrow();
  });
  it("viewer can read but not write", async () => {
    const rows = await db.asUser(VIEW, (q) => q.query(`select 1 from tasks`));
    expect(rows.length).toBe(1);
    await expect(db.asUser(VIEW, (q) => q.query(`insert into tasks(id,workspace_id,title) values ($1,$2,'v')`, [newId(), WA]))).rejects.toThrow();
  });
  it("viewer cannot approve; other tenant cannot approve; owner can", async () => {
    const upd = (u: string) => db.asUser(u, (q) => q.query(`update approvals set status='approved' where id=$1 returning id`, [approvalA]));
    expect((await upd(VIEW)).length).toBe(0);
    expect((await upd(UB)).length).toBe(0);
    expect((await upd(UA)).length).toBe(1);
  });
  it("audit_log: a member may append for their own workspace only; no update/delete for anyone", async () => {
    await db.asUser(UA, (q) => q.query(`insert into audit_log(workspace_id,actor,action,entity) values ($1,'u','a','e')`, [WA]));
    await expect(db.asUser(UA, (q) => q.query(`insert into audit_log(workspace_id,actor,action,entity) values ($1,'u','a','e')`, [WB]))).rejects.toThrow();
    await expect(db.asUser(UA, (q) => q.query(`update audit_log set action='x'`))).rejects.toThrow();
    await expect(db.query(`delete from audit_log`)).rejects.toThrow(/append-only/);
  });
  it("unauthenticated (no sub) sees nothing", async () => {
    const rows = await db.asUser("00000000-0000-4000-8000-000000000000", (q) => q.query(`select 1 from tasks`));
    expect(rows.length).toBe(0);
  });
});

describe("event dedupe", () => {
  it("same dedupeKey is inserted once", async () => {
    const e1 = makeEvent({ workspaceId: WA, source: "manual", type: "message.received", payload: { a: 1 }, externalId: "same" });
    const e2 = makeEvent({ workspaceId: WA, source: "manual", type: "message.received", payload: { a: 1 }, externalId: "same" });
    expect((await store.insertEvent(e1)).inserted).toBe(true);
    const r = await store.insertEvent(e2);
    expect(r.inserted).toBe(false);
    expect(r.id).toBe(e1.id);
  });
  it("same dedupeKey in another workspace is independent", async () => {
    const e = makeEvent({ workspaceId: WB, source: "manual", type: "message.received", payload: { a: 1 }, externalId: "same" });
    expect((await store.insertEvent(e)).inserted).toBe(true);
  });
});
