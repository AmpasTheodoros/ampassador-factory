import Link from "next/link";
import { generateBrief, type BriefItem } from "@aaf/brain";
import { withApp } from "@/lib/runtime";
import { completeTask, loadDemoData } from "@/lib/actions";
import { Card, PageTitle, Empty, Badge, DemoBadge, Provenance, StatusBadge, fmt } from "@/components/ui";

function Item({ it, big }: { it: BriefItem; big?: boolean }) {
  return (
    <div className={big ? "space-y-2" : "space-y-1"}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={big ? "text-lg font-semibold" : "font-medium"}>{it.title}</h3>
        {it.isDemo && <DemoBadge />}
        <Badge>{it.kind}</Badge>
        <span className="muted text-xs">score {it.score}</span>
      </div>
      <ul className="muted list-disc pl-5 text-sm">
        {it.why.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {it.stale && <p className="text-xs c-warn">Stale: {it.stale}</p>}
      <details className="text-xs">
        <summary className="muted cursor-pointer">Provenance</summary>
        <Provenance items={it.provenance} />
      </details>
      <Link href={it.nextAction.href} className="btn btn-primary inline-block">
        {it.nextAction.label}
      </Link>
    </div>
  );
}

export default async function Overview() {
  const { brief, tasks, conns } = await withApp(async (app) => ({
    brief: await generateBrief(app.deps, app.workspaceId),
    tasks: await app.store.listTasks(app.workspaceId, "open"),
    conns: await app.store.listConnections(app.workspaceId),
  }));
  return (
    <>
      <PageTitle title="Today" sub={`Brief generated ${fmt(brief.generatedAt)} from the records in this workspace only.`} />
      <div className="space-y-4">
        <Card title="Critical action">
          {brief.critical ? (
            <Item it={brief.critical} big />
          ) : (
            <div className="space-y-3">
              <Empty>{brief.emptyReason}</Empty>
              <form action={loadDemoData}>
                <button className="btn" type="submit">
                  Load clearly labelled DEMO data
                </button>
              </form>
            </div>
          )}
        </Card>
        {brief.important.length > 0 && (
          <Card title="Important">
            <div className="space-y-5">
              {brief.important.map((i) => (
                <Item key={i.key} it={i} />
              ))}
            </div>
          </Card>
        )}
        {brief.blockers.length > 0 && (
          <Card title="Blockers">
            <ul className="space-y-3">
              {brief.blockers.map((b) => (
                <li key={b.key}>
                  <Item it={b} />
                </li>
              ))}
            </ul>
          </Card>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Waiting on">
            {brief.waiting.length ? (
              <ul className="space-y-2 text-sm">
                {brief.waiting.map((w) => (
                  <li key={w.key}>
                    {w.title}
                    <div className="muted text-xs">{w.why[0]}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No follow-ups outstanding.</Empty>
            )}
          </Card>
          <Card title="Monitor">
            {brief.monitor.length ? (
              <ul className="space-y-2 text-sm">
                {brief.monitor.map((w) => (
                  <li key={w.key}>{w.title}</li>
                ))}
              </ul>
            ) : (
              <Empty>Nothing to monitor.</Empty>
            )}
          </Card>
        </div>
        <Card title="Not visible to the brief">
          <ul className="space-y-1 text-sm">
            {brief.gaps.map((g) => (
              <li key={g.connector}>
                <StatusBadge s="not_connected" /> <span className="ml-1">{g.note}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Open tasks">
          <div id="tasks" />
          {tasks.length === 0 ? (
            <Empty>No open tasks.</Empty>
          ) : (
            <ul className="divide-y divide-[var(--line)]">
              {tasks.map((t) => (
                <li key={String(t["id"])} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {String(t["title"])} {t["isDemo"] ? <DemoBadge /> : null}
                    <span className="muted ml-2 text-xs">due {fmt(t["dueAt"])}</span>
                  </span>
                  <form action={completeTask}>
                    <input type="hidden" name="id" value={String(t["id"])} />
                    <button className="btn" type="submit">
                      Done
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <p className="muted text-xs">
          {conns.filter((c) => c["status"] === "connected").length} of {conns.length} connectors connected.
        </p>
      </div>
    </>
  );
}
