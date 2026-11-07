import Link from "next/link";
import { runtime, WORKSPACE_ID } from "@/lib/runtime";
import { Card, PageTitle, Empty, StatusBadge, fmt } from "@/components/ui";

export default async function Automations() {
  const rt = await runtime();
  const runs = await rt.store.listRuns(WORKSPACE_ID);
  const calls = await rt.store.listToolCalls(WORKSPACE_ID, 30);
  const dead = await rt.store.listApprovals(WORKSPACE_ID, "failed");
  return (
    <>
      <PageTitle title="Automations" sub="Workflow runs, tool calls and dead-lettered actions. R1 workflows run inline on request; there are no schedules yet (Trigger.dev is planned for R2)." />
      <div className="space-y-4">
        <Card title="Dead letter (failed after retries)">
          {dead.length === 0 ? <Empty>No failed actions.</Empty> : <ul className="space-y-2 text-sm">{dead.map((a) => <li key={String(a["id"])}>{String(a["summary"])} <Link className="btn ml-2" href={`/approvals?id=${a["id"]}`}>Inspect / replay</Link></li>)}</ul>}
        </Card>
        <Card title="Workflow runs">
          {runs.length === 0 ? <Empty>No runs yet.</Empty> : (
            <ul className="space-y-1 text-sm">{runs.map((r) => <li key={String(r["id"])}><StatusBadge s={String(r["status"])} /> <span className="font-mono text-xs">{String(r["workflow"])}</span> <span className="muted text-xs">{fmt(r["createdAt"])} {r["error"] ? `· ${String(r["error"])}` : ""}</span></li>)}</ul>
          )}
        </Card>
        <Card title="Recent tool calls (every call is logged, including denials)">
          {calls.length === 0 ? <Empty>No tool calls yet.</Empty> : (
            <ul className="space-y-1 text-xs">{calls.map((c) => <li key={String(c["id"])}><span className="font-mono">{fmt(c["createdAt"])}</span> {String(c["actor"])} → <span className="font-mono">{String(c["toolId"])}</span> · {String(c["outcome"])}{c["detail"] ? ` · ${String(c["detail"])}` : ""}</li>)}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
