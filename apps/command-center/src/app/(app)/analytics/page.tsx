import { withApp } from "@/lib/runtime";
import { Card, PageTitle, Empty } from "@/components/ui";

export default async function Analytics() {
  const { ws, spend, inbox, approvals, calls, llm } = await withApp(async (app) => ({
    ws: await app.store.getWorkspace(app.workspaceId),
    spend: await app.store.monthSpendEur(app.workspaceId),
    inbox: await app.store.listInbox(app.workspaceId),
    approvals: await app.store.listApprovals(app.workspaceId),
    calls: await app.store.listToolCalls(app.workspaceId, 1000),
    llm: app.router.available(),
  }));
  const budget = Number(ws?.["monthlyBudgetEur"] ?? 0);
  const real = inbox.filter((i) => !i["isDemo"]);
  const by = (s: string) => approvals.filter((a) => a["status"] === s).length;
  const denied = calls.filter((c) => c["outcome"] === "denied").length;
  const stat = (label: string, v: string | number, note?: string) => (
    <div className="card p-3"><div className="muted text-xs">{label}</div><div className="text-2xl font-semibold">{v}</div>{note && <div className="muted text-xs">{note}</div>}</div>
  );
  return (
    <>
      <PageTitle title="Analytics" sub="Counts of what actually happened in this workspace. No estimates, no projected revenue." />
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        {stat("Messages ingested", real.length, `${inbox.length - real.length} demo excluded`)}
        {stat("Awaiting approval", by("awaiting_approval"))}
        {stat("Approved and executed", by("succeeded"), "exported or sent")}
        {stat("Rejected (corrections)", by("rejected"))}
      </div>
      <div className="mt-4 space-y-4">
        <Card title="AI spend this month">
          <p className="text-sm">{spend.toFixed(2)} of {budget.toFixed(2)} EUR budget {spend >= budget ? "(model calls are stopped)" : ""}</p>
          <progress className="mt-2 w-full" value={Math.min(spend, budget)} max={budget || 1} aria-label="Budget used" />
          {!llm && <p className="muted mt-2 text-xs">No LLM provider configured: drafts are deterministic templates and cost nothing.</p>}
        </Card>
        <Card title="Guardrail activity">
          <p className="text-sm">{denied} tool call(s) were denied (missing connector, scope, invalid input or rate limit).</p>
        </Card>
        <Card title="Business outcomes">
          <Empty>Meetings, proposals, paid pilots and revenue are not tracked yet. They arrive with the sales engine (R2); until then this page does not show numbers it cannot back.</Empty>
        </Card>
      </div>
    </>
  );
}
