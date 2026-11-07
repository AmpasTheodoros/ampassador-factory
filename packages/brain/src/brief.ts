import type { Provenance } from "@aaf/core";
import type { BrainDeps } from "./workflows";

export interface BriefItem {
  key: string;
  kind: "reply" | "approval" | "task" | "blocker" | "waiting" | "monitor";
  title: string;
  why: string[];
  score: number;
  nextAction: { label: string; href: string };
  provenance: Provenance[];
  isDemo: boolean;
  stale?: string;
}
export interface Brief {
  generatedAt: string;
  critical: BriefItem | null;
  important: BriefItem[];
  waiting: BriefItem[];
  monitor: BriefItem[];
  blockers: BriefItem[];
  gaps: { connector: string; note: string }[];
  emptyReason?: string;
}

const STALE_DAYS = 7;
const s = (v: unknown) => String(v ?? "");
const days = (a: number, b: number) => Math.floor((a - b) / 86400_000);

/** W4: ranks only what exists in the store. No generic advice is ever generated. */
export async function generateBrief(deps: BrainDeps, ws: string): Promise<Brief> {
  const { store } = deps;
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();
  const nowIso = new Date(nowMs).toISOString();
  const items = new Map<string, BriefItem>();
  const put = (it: BriefItem) => {
    const cur = items.get(it.key);
    if (!cur || it.score > cur.score) items.set(it.key, it);
  };
  const stale = (createdAt: unknown) => {
    const d = days(nowMs, new Date(s(createdAt)).getTime());
    return d >= STALE_DAYS ? `Source is ${d} days old: verify it is still current` : undefined;
  };

  await deps.gateway.expireStale(ws);

  const recs = await store.listRecommendations(ws, 100);
  const inbox = new Map((await store.listInbox(ws)).map((i) => [s(i["id"]), i]));
  const approvals = await store.listApprovals(ws);
  const awaiting = approvals.filter((a) => a["status"] === "awaiting_approval");
  const failed = approvals.filter((a) => a["status"] === "failed");
  const unknown = approvals.filter((a) => a["status"] === "unknown_outcome");
  const tasks = await store.listTasks(ws, "open");
  const runs = await store.listRuns(ws, 30);
  const conns = await store.listConnections(ws);

  const monitor: BriefItem[] = [];
  for (const r of recs) {
    const ib = inbox.get(s(r["inboxItemId"]));
    if (!ib || ib["status"] === "actioned" || ib["status"] === "dismissed") continue;
    const cls = s(r["actionClass"]);
    const base: BriefItem = {
      key: `inbox:${s(r["inboxItemId"])}`, kind: "reply", title: s(r["title"]), score: Number(r["score"]),
      why: ((r["why"] as { reasons?: string[] }).reasons ?? []).slice(0, 3),
      nextAction: { label: "Open in Inbox", href: `/inbox?item=${s(r["inboxItemId"])}` },
      provenance: r["provenance"] as Provenance[], isDemo: !!r["isDemo"], stale: stale(r["createdAt"]),
    };
    if (cls === "monitor" || cls === "ignore") monitor.push({ ...base, kind: "monitor" });
    else put(base);
  }

  for (const a of awaiting) {
    const ctx = a["sourceContext"] as { inboxItemId?: string; isDemo?: boolean; provenance?: Provenance[] };
    const hoursLeft = (new Date(s(a["expiresAt"])).getTime() - nowMs) / 3600_000;
    const ibKey = ctx.inboxItemId ? `inbox:${ctx.inboxItemId}` : `approval:${s(a["id"])}`;
    const prior = items.get(ibKey);
    put({
      key: ibKey, kind: "approval", title: `Approve or reject: ${s(a["summary"])}`,
      // a pending decision is worth more than the bare recommendation, but never outranks genuinely urgent items by itself
      score: (prior ? prior.score + 5 : 40) + (hoursLeft < 6 ? 15 : 0),
      why: [...(prior?.why ?? []), `Nothing happens until you decide. Expires in ${Math.max(0, Math.round(hoursLeft))}h.`],
      nextAction: { label: "Review approval", href: `/approvals?id=${s(a["id"])}` },
      provenance: ctx.provenance ?? prior?.provenance ?? [{ source: "approvals", recordId: s(a["id"]), retrievedAt: nowIso, kind: "record" }],
      isDemo: !!ctx.isDemo, stale: stale(a["createdAt"]),
    });
  }

  const waiting: BriefItem[] = [];
  for (const t of tasks) {
    const due = t["dueAt"] ? new Date(s(t["dueAt"])).getTime() : null;
    const overdueDays = due ? days(nowMs, due) : -1;
    const isFollowUp = s(t["sourceRef"]).startsWith("approval:");
    const prov: Provenance[] = [{ source: "tasks", recordId: s(t["id"]), retrievedAt: nowIso, kind: t["isDemo"] ? "demo" : "record" }];
    const base = { key: `task:${s(t["id"])}`, title: s(t["title"]), nextAction: { label: "Open tasks", href: `/overview#tasks` }, provenance: prov, isDemo: !!t["isDemo"] };
    if (due && due < nowMs) put({ ...base, kind: "task", score: 55 + Math.min(overdueDays, 10) * 2, why: [`Overdue by ${Math.max(0, overdueDays)} day(s)`] });
    else if (due && due - nowMs < 2 * 86400_000) put({ ...base, kind: "task", score: 45, why: ["Due within 48 hours"] });
    else if (isFollowUp) waiting.push({ ...base, kind: "waiting", score: 20, why: [due ? `Follow-up window ends ${new Date(due).toISOString().slice(0, 10)}` : "Waiting on a reply"] });
  }

  const blockers: BriefItem[] = [];
  for (const a of unknown)
    blockers.push({ key: `unknown:${s(a["id"])}`, kind: "blocker", title: `Outcome unknown, check whether it went out: ${s(a["summary"])}`, score: 90, why: ["The send was attempted but its result was never confirmed. It will not be retried until you reconcile it."], nextAction: { label: "Reconcile", href: `/approvals?id=${s(a["id"])}` }, provenance: [{ source: "approvals", recordId: s(a["id"]), retrievedAt: nowIso, kind: "record" }], isDemo: false });
  for (const a of failed)
    blockers.push({ key: `failed:${s(a["id"])}`, kind: "blocker", title: `Action failed and needs an operator: ${s(a["summary"])}`, score: 80, why: ["Exhausted retries; see the receipts"], nextAction: { label: "Open automations", href: `/automations` }, provenance: [{ source: "approvals", recordId: s(a["id"]), retrievedAt: nowIso, kind: "record" }], isDemo: false });
  for (const r of runs.filter((r) => r["status"] === "failed").slice(0, 3))
    blockers.push({ key: `run:${s(r["id"])}`, kind: "blocker", title: `Workflow ${s(r["workflow"])} failed: ${s(r["error"]).slice(0, 120)}`, score: 70, why: ["Recorded failure"], nextAction: { label: "Open automations", href: `/automations` }, provenance: [{ source: "workflow_runs", recordId: s(r["id"]), retrievedAt: nowIso, kind: "record" }], isDemo: false });
  const w = await store.getWorkspace(ws);
  const spend = await store.monthSpendEur(ws);
  const budget = Number(w?.["monthlyBudgetEur"] ?? 0);
  if (budget > 0 && spend / budget >= 0.8)
    blockers.push({ key: "budget", kind: "blocker", title: `AI spend is ${spend.toFixed(2)} of ${budget.toFixed(2)} EUR this month`, score: 75, why: [spend >= budget ? "Budget reached: model calls are stopped" : "Over 80% of budget"], nextAction: { label: "Open analytics", href: "/analytics" }, provenance: [{ source: "cost_events", retrievedAt: nowIso, kind: "record" }], isDemo: false });

  const ranked = [...items.values()].sort((a, b) => b.score - a.score);
  const connected = new Set(conns.filter((c) => c["status"] === "connected").map((c) => s(c["connector"])));
  const gaps = ["gmail", "google_calendar", "networkradar"].filter((c) => !connected.has(c)).map((c) => ({
    connector: c,
    note: c === "google_calendar" ? "Meetings are not shown: calendar is not connected" : c === "gmail" ? "Replies are not read automatically: paste messages into the Inbox" : "Contacts are not verified: NetworkRadar is not connected",
  }));

  return {
    generatedAt: nowIso,
    critical: ranked[0] ?? null,
    important: ranked.slice(1, 4),
    waiting: waiting.slice(0, 5),
    monitor: monitor.slice(0, 5),
    blockers: blockers.sort((a, b) => b.score - a.score),
    gaps,
    emptyReason: ranked.length === 0 ? "Nothing needs action in the sources that are available. Paste a message into the Inbox or connect a source." : undefined,
  };
}
