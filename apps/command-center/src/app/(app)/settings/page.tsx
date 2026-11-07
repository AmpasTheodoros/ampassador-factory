import { runtime, WORKSPACE_ID } from "@/lib/runtime";
import { authMode } from "@/lib/auth";
import { Card, PageTitle, StatusBadge, Badge, fmt } from "@/components/ui";

export default async function Settings() {
  const rt = await runtime();
  const ws = await rt.store.getWorkspace(WORKSPACE_ID);
  const conns = await rt.store.listConnections(WORKSPACE_ID);
  return (
    <>
      <PageTitle title="Settings" />
      <div className="space-y-4">
        <Card title="Workspace">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
            <dt className="muted">Name</dt><dd>{String(ws?.["name"])}</dd>
            <dt className="muted">Data policy</dt><dd><Badge>{String(ws?.["dataPolicy"])}</Badge></dd>
            <dt className="muted">Monthly AI budget</dt><dd>{Number(ws?.["monthlyBudgetEur"]).toFixed(2)} EUR</dd>
            <dt className="muted">Sign-in</dt><dd>{authMode() === "password" ? "Password" : authMode() === "dev_open" ? "Dev mode (open)" : "Closed (not configured)"}</dd>
            <dt className="muted">Role</dt><dd>owner (single user in R1)</dd>
          </dl>
        </Card>
        <Card title="Model routing">
          <p className="text-sm">{rt.llm.configured ? `Provider configured: ${rt.llm.location}, model ${rt.llm.model}.` : "No LLM configured. Drafts use deterministic templates."}</p>
          <p className="muted mt-1 text-xs">Policy local_only never falls back to a cloud provider. redact_then_cloud masks emails and phone numbers first. Local worker nodes: none registered (prototype planned for R4).</p>
        </Card>
        <Card title="Connectors">
          <ul className="divide-y divide-[var(--line)]">
            {conns.map((c) => (
              <li key={String(c["id"])} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span><span className="font-mono">{String(c["connector"])}</span><span className="muted block text-xs">{String(c["detail"])}</span></span>
                <span className="flex items-center gap-2"><StatusBadge s={String(c["status"])} /><span className="muted text-xs">{fmt(c["updatedAt"])}</span></span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
