import { refreshNetworkRadarConnection } from "@aaf/jobs";
import { missingConfig } from "@aaf/integrations";
import { withApp } from "@/lib/runtime";
import { authProviderName, getEnv } from "@/lib/config";
import { getDb } from "@/lib/db";
import { runtimeEnv } from "@/lib/services";
import { Card, PageTitle, StatusBadge, Badge, fmt } from "@/components/ui";

export default async function Settings() {
  const env = getEnv();
  const { ws, conns, models, role, nr } = await withApp(async (app) => {
    const nr = await refreshNetworkRadarConnection(app.store, app.workspaceId, runtimeEnv()); // cached 5 min
    return { ws: await app.store.getWorkspace(app.workspaceId), conns: await app.store.listConnections(app.workspaceId), models: app.router.describe(), role: app.role, nr };
  });
  const { database } = await getDb();
  return (
    <>
      <PageTitle title="Settings" />
      <div className="space-y-4">
        <Card title="Workspace">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1 text-sm">
            <dt className="muted">Name</dt><dd>{String(ws?.["name"])}</dd>
            <dt className="muted">Data policy</dt><dd><Badge>{String(ws?.["dataPolicy"])}</Badge></dd>
            <dt className="muted">Monthly AI budget</dt><dd>{Number(ws?.["monthlyBudgetEur"]).toFixed(2)} EUR</dd>
            <dt className="muted">Your role</dt><dd>{role} (from the memberships table)</dd>
            <dt className="muted">Sign-in</dt><dd>{authProviderName(env)}{authProviderName(env) === "local" ? " (development only)" : ""}</dd>
            <dt className="muted">Database</dt><dd>{database.kind === "pg" ? "PostgreSQL via pooled connection" : "Embedded PostgreSQL (development)"}</dd>
          </dl>
        </Card>
        <Card title="Model routing">
          {models.length === 0 ? <p className="text-sm">No model configured. Classification is rule-based and drafts are template-generated.</p> : (
            <ul className="space-y-1 text-sm">{models.map((m) => <li key={m.id}><span className="font-mono">{m.model}</span> <Badge>{m.location}</Badge> <span className="muted text-xs">tasks: {Array.isArray(m.tasks) ? m.tasks.join(", ") : m.tasks} · {m.priced ? "priced" : "price unknown: pessimistic estimate applied"}</span></li>)}</ul>
          )}
          <p className="muted mt-2 text-xs">local_only never falls back to a cloud provider. redact_then_cloud masks emails and phone numbers first. Calls are bounded by timeout, retries, output size and a worst-case budget check.</p>
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
          {nr.status === "not_configured" && <p className="muted mt-2 text-xs">NetworkRadar needs {missingConfig(runtimeEnv()).join(" and ")}. See docs/networkradar-connectivity.md.</p>}
        </Card>
      </div>
    </>
  );
}
