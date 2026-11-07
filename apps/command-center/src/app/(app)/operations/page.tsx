import Link from "next/link";
import { counts, listJobs, jobEvents } from "@aaf/jobs";
import { refreshNetworkRadarConnection } from "@aaf/jobs";
import { withApp } from "@/lib/runtime";
import { cancelJob, replayJobAction } from "@/lib/actions";
import { authProviderName, getEnv } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getTelemetry, runtimeEnv } from "@/lib/services";
import { Card, PageTitle, Empty, StatusBadge, Badge, fmt } from "@/components/ui";

export default async function Operations({ searchParams }: { searchParams: Promise<{ job?: string }> }) {
  const { job: selJob } = await searchParams;
  const env = getEnv();
  const { database } = await getDb();
  const health = await database.health();
  const tel = await getTelemetry();
  const d = await withApp(async (app) => {
    const nr = await refreshNetworkRadarConnection(app.store, app.workspaceId, runtimeEnv());
    const ws = await app.store.getWorkspace(app.workspaceId);
    return {
      role: app.role,
      nr,
      jobCounts: await counts(app.store.db, app.workspaceId),
      jobs: await listJobs(app.store.db, app.workspaceId, undefined, 30),
      events: selJob ? await jobEvents(app.store.db, app.workspaceId, selJob) : [],
      pendingApprovals: (await app.store.listApprovals(app.workspaceId, "awaiting_approval")).length,
      deadApprovals: [
        ...(await app.store.listApprovals(app.workspaceId, "failed")),
        ...(await app.store.listApprovals(app.workspaceId, "unknown_outcome")),
      ],
      cost: await app.store.costSummary(app.workspaceId),
      spend: await app.store.monthSpendEur(app.workspaceId),
      budget: Number(ws?.["monthlyBudgetEur"] ?? 0),
      toolCalls: await app.store.listToolCalls(app.workspaceId, 25),
      toolCounts: await app.store.toolCallCounts(app.workspaceId),
      conns: await app.store.listConnections(app.workspaceId),
      models: app.router.describe(),
      runs: await app.store.listRuns(app.workspaceId, 10),
    };
  });
  const c = d.jobCounts;
  const active = (c.queued ?? 0) + (c.running ?? 0) + (c.waiting_approval ?? 0);
  const failed = (c.dead ?? 0) + (c.failed ?? 0);
  const stat = (label: string, v: string | number, note?: string, tone?: "bad") => (
    <div className="card p-3">
      <div className="muted text-xs">{label}</div>
      <div className={`text-2xl font-semibold ${tone === "bad" && Number(v) > 0 ? "c-bad" : ""}`}>{v}</div>
      {note && <div className="muted text-xs">{note}</div>}
    </div>
  );
  const canAdmin = d.role === "owner" || d.role === "admin";
  return (
    <>
      <PageTitle title="Operations" sub="Jobs, approvals, model spend, tool history and integration health for this workspace." />
      <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-5">
        {stat("Active jobs", active, `${c.queued ?? 0} queued · ${c.running ?? 0} running · ${c.waiting_approval ?? 0} waiting`)}
        {stat("Completed jobs", c.succeeded ?? 0)}
        {stat("Failed jobs", failed, "dead-lettered", "bad")}
        {stat("Pending approvals", d.pendingApprovals)}
        {stat("Model spend (month)", `${d.spend.toFixed(2)} €`, `of ${d.budget.toFixed(2)} €`)}
      </div>
      <div className="mt-4 space-y-4">
        <Card title="Jobs">
          {d.jobs.length === 0 ? (
            <Empty>No jobs yet. Submitting a message in the Inbox creates one.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {d.jobs.map((j) => (
                <li key={j.id} className="space-y-1 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge s={j.status} />
                    <span className="font-mono text-xs">{j.type}</span>
                    <span className="muted text-xs">
                      {j.progress}% · attempt {j.attempts}/{j.maxAttempts} · {fmt(j.createdAt)} · corr {j.correlationId.slice(0, 8)}
                    </span>
                    <Link className="btn" href={`/operations?job=${j.id}`}>
                      Events
                    </Link>
                    {["queued", "running", "waiting_approval"].includes(j.status) && (
                      <form action={cancelJob}>
                        <input type="hidden" name="id" value={j.id} />
                        <button className="btn" type="submit">
                          Cancel
                        </button>
                      </form>
                    )}
                    {["dead", "failed", "cancelled"].includes(j.status) && canAdmin && (
                      <form action={replayJobAction}>
                        <input type="hidden" name="id" value={j.id} />
                        <button className="btn" type="submit">
                          Replay
                        </button>
                      </form>
                    )}
                    {j.approvalId && j.status === "waiting_approval" && (
                      <Link className="btn" href={`/approvals?id=${j.approvalId}`}>
                        Approval
                      </Link>
                    )}
                  </div>
                  {j.error && <p className="text-xs c-bad">{j.error}</p>}
                  {selJob === j.id && (
                    <ul className="muted ml-2 text-xs">
                      {d.events.map((e) => (
                        <li key={String(e["id"])}>
                          {fmt(e["createdAt"])} · {String(e["kind"])}{" "}
                          {JSON.stringify(e["detail"]) !== "{}" ? `· ${JSON.stringify(e["detail"])}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {d.deadApprovals.length > 0 && (
          <Card title="Dead-lettered approvals and unknown outcomes">
            <ul className="space-y-2 text-sm">
              {d.deadApprovals.map((a) => (
                <li key={String(a["id"])}>
                  <StatusBadge s={String(a["status"])} /> {String(a["summary"])}{" "}
                  <Link className="btn ml-2" href={`/approvals?id=${a["id"]}`}>
                    Inspect / replay
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Model costs (this month)">
            {d.cost.length === 0 ? (
              <Empty>No model calls this month.</Empty>
            ) : (
              <table className="w-full text-left text-xs">
                <caption className="sr-only">Model spend by model</caption>
                <thead>
                  <tr className="muted">
                    <th className="py-1 pr-2">Model</th>
                    <th className="pr-2">Calls</th>
                    <th className="pr-2">Tokens in/out</th>
                    <th>EUR</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cost.map((r, i) => (
                    <tr key={i} className="border-t border-[var(--line)]">
                      <td className="py-1 pr-2 font-mono">{r.model ?? r.provider}</td>
                      <td className="pr-2">{r.calls}</td>
                      <td className="pr-2">
                        {r.tokensIn}/{r.tokensOut}
                      </td>
                      <td>{r.costEur.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="muted mt-2 text-xs">
              Configured:{" "}
              {d.models.length ? d.models.map((m) => `${m.model} (${m.location})`).join(", ") : "none: rules and templates only"}
            </p>
          </Card>
          <Card title="Integration and system health">
            <ul className="space-y-1 text-sm">
              <li>
                Database <Badge tone={health.ok ? "good" : "bad"}>{health.ok ? `ok ${health.latencyMs}ms` : "down"}</Badge>{" "}
                <span className="muted text-xs">{database.kind}</span>
              </li>
              <li>
                Auth <Badge>{authProviderName(env)}</Badge>
              </li>
              <li>
                Job driver <Badge>{env.AAF_JOB_DRIVER}</Badge>
                {env.AAF_JOB_DRIVER === "trigger" && !env.TRIGGER_SECRET_KEY ? (
                  <span className="text-xs c-warn"> TRIGGER_SECRET_KEY missing: using local engine</span>
                ) : null}
              </li>
              <li>
                Telemetry <Badge>{tel.sinks.length ? tel.sinks.join(", ") : "none configured"}</Badge>
              </li>
              {d.conns.map((cn) => (
                <li key={String(cn["id"])}>
                  <span className="font-mono text-xs">{String(cn["connector"])}</span> <StatusBadge s={String(cn["status"])} />
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <Card title="Tool execution history">
          <p className="muted mb-2 text-xs">
            {Object.entries(d.toolCounts)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ") || "no calls"}
          </p>
          {d.toolCalls.length === 0 ? (
            <Empty>No tool calls yet.</Empty>
          ) : (
            <ul className="space-y-1 text-xs">
              {d.toolCalls.map((t) => (
                <li key={String(t["id"])}>
                  <span className="font-mono">{fmt(t["createdAt"])}</span> {String(t["actor"])} →{" "}
                  <span className="font-mono">{String(t["toolId"])}</span> · {String(t["outcome"])}
                  {t["detail"] ? ` · ${String(t["detail"])}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Recent workflow runs">
          {d.runs.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="space-y-1 text-xs">
              {d.runs.map((r) => (
                <li key={String(r["id"])}>
                  <StatusBadge s={String(r["status"])} /> <span className="font-mono">{String(r["workflow"])}</span> {fmt(r["createdAt"])}{" "}
                  {r["error"] ? `· ${String(r["error"])}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
