import Link from "next/link";
import { listJobs } from "@aaf/jobs";
import { withApp } from "@/lib/runtime";
import { submitMessage } from "@/lib/actions";
import { Card, PageTitle, Empty, Badge, DemoBadge, OriginBadge, Provenance, StatusBadge, fmt, type Origin } from "@/components/ui";

type Why = {
  reasons: string[];
  flags: string[];
  confidence: number;
  urgency: number;
  impact: number;
  effort: number;
  classification?: { by: "rules" | "ai" | "ai+rules"; model: string | null; location: string | null };
  facts?: { label: string; value: string; status: "verified" | "unverified"; source: string; recordId?: string }[];
};

export const maxDuration = 60; // triage and approval actions run model calls and jobs

export default async function Inbox({ searchParams }: { searchParams: Promise<{ item?: string; error?: string; dup?: string }> }) {
  const { item, error, dup } = await searchParams;
  const data = await withApp(async (app) => {
    const rows = await app.store.listInbox(app.workspaceId);
    const sel = item ? await app.store.getInboxItem(app.workspaceId, item) : undefined;
    const rec = sel ? await app.store.recommendationForInbox(app.workspaceId, item!) : undefined;
    const approvals = sel
      ? (await app.store.listApprovals(app.workspaceId)).filter(
          (a) => (a["sourceContext"] as { inboxItemId?: string }).inboxItemId === item,
        )
      : [];
    const jobs = sel
      ? (await listJobs(app.store.db, app.workspaceId, undefined, 50)).filter(
          (j) => (j.input as { inboxItemId?: string }).inboxItemId === item,
        )
      : [];
    return { rows, sel, rec, approvals, jobs };
  });
  const { rows, sel, rec, approvals, jobs } = data;
  const why = rec?.["why"] as Why | undefined;
  const payload = sel?.["eventPayload"] as { fromEmail: string; fromName: string | null; subject: string; body: string } | undefined;
  const job = jobs[0];

  return (
    <>
      <PageTitle title="Inbox" sub="Signals from connected sources and pasted conversations. Nothing here is sent automatically." />
      {error && (
        <p role="alert" className="mb-3 text-sm c-bad">
          {error}
        </p>
      )}
      {dup && (
        <p role="status" className="mb-3 text-sm muted">
          This message was already ingested; showing the existing item.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <div className="space-y-4">
          <Card title="Add a message">
            <form action={submitMessage} className="space-y-2">
              <label className="block text-xs" htmlFor="fromEmail">
                Sender email
              </label>
              <input id="fromEmail" name="fromEmail" type="email" required className="field" />
              <label className="block text-xs" htmlFor="fromName">
                Sender name
              </label>
              <input id="fromName" name="fromName" className="field" />
              <label className="block text-xs" htmlFor="subject">
                Subject
              </label>
              <input id="subject" name="subject" className="field" />
              <label className="block text-xs" htmlFor="body">
                Message
              </label>
              <textarea id="body" name="body" required rows={6} className="field" />
              <button className="btn btn-primary w-full" type="submit">
                Triage
              </button>
            </form>
          </Card>
          <Card title="Items">
            {rows.length === 0 ? (
              <Empty>Inbox is empty. Paste a message above.</Empty>
            ) : (
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={String(r["id"])}>
                    <Link
                      href={`/inbox?item=${r["id"]}`}
                      className={`block rounded-md p-2 text-sm hover:bg-[var(--line)] ${r["id"] === item ? "bg-[var(--line)]" : ""}`}
                    >
                      <div className="font-medium">{String(r["title"])}</div>
                      <div className="muted flex flex-wrap items-center gap-1 text-xs">
                        {String(r["contactName"] ?? r["contactEmail"])} <StatusBadge s={String(r["status"])} />
                        {r["isDemo"] ? <DemoBadge /> : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          {!sel ? (
            <Empty>Select an item to see the classification, reasoning and draft.</Empty>
          ) : (
            <>
              <Card title="Message (untrusted content, shown as plain text)">
                <p className="text-sm">
                  <b>{payload!.fromName ?? payload!.fromEmail}</b>{" "}
                  <span className="muted">
                    &lt;{payload!.fromEmail}&gt; · {fmt(sel["eventOccurredAt"])} · source {String(sel["eventSource"])}
                  </span>{" "}
                  <OriginBadge kind="unverified" detail="sender from header" />
                </p>
                <p className="mt-1 font-medium">{payload!.subject}</p>
                <pre className="mt-2 whitespace-pre-wrap text-sm">{payload!.body}</pre>
              </Card>
              {job && ["queued", "running", "dead", "failed"].includes(job.status) && (
                <Card title="Background job">
                  <p className="text-sm">
                    <StatusBadge s={job.status} /> triage job, attempt {job.attempts}/{job.maxAttempts}
                    {job.error ? ` · ${job.error}` : ""}{" "}
                    <Link className="btn ml-2" href="/operations">
                      Operations
                    </Link>
                  </p>
                </Card>
              )}
              {rec && why && (
                <Card title="Brain recommendation">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{String(rec["title"])}</h3>
                    <Badge tone="good">{String(rec["actionClass"]).replace("_", " ")}</Badge>
                    {why.classification && (
                      <OriginBadge
                        kind={why.classification.by as Origin}
                        detail={why.classification.model ? `${why.classification.model} (${why.classification.location})` : undefined}
                      />
                    )}
                  </div>
                  <p className="muted mt-1 text-sm">
                    confidence {Math.round(why.confidence * 100)}% · urgency {why.urgency}/10 · impact {why.impact}/10 · effort {why.effort}
                    /10 · score {Number(rec["score"])}
                  </p>
                  <ul className="mt-2 list-disc pl-5 text-sm">
                    {why.reasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                  {why.flags.length > 0 && (
                    <ul className="mt-2 text-sm c-warn">
                      {why.flags.map((f, i) => (
                        <li key={i}>Warning: {f}</li>
                      ))}
                    </ul>
                  )}
                  {why.facts && (
                    <div className="mt-3">
                      <h4 className="muted text-xs font-semibold uppercase">What is known about the sender</h4>
                      <ul className="mt-1 space-y-1 text-sm">
                        {why.facts.map((f, i) => (
                          <li key={i}>
                            {f.label}: <span className="font-mono">{f.value}</span> <OriginBadge kind={f.status} detail={f.source} />
                            {f.recordId ? <span className="muted font-mono text-xs"> #{f.recordId}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <details className="mt-2 text-xs">
                    <summary className="muted cursor-pointer">Provenance</summary>
                    <Provenance items={rec["provenance"] as never} />
                  </details>
                </Card>
              )}
              <Card title="Proposed actions">
                {approvals.length === 0 ? (
                  <Empty>
                    {rec && ["ignore", "monitor"].includes(String(rec["actionClass"]))
                      ? "No reply proposed: this message does not call for one."
                      : "No action proposed."}
                  </Empty>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {approvals.map((a) => (
                      <li key={String(a["id"])} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {String(a["summary"])}{" "}
                          <OriginBadge
                            kind={(a["sourceContext"] as { draftSource?: string }).draftSource === "llm" ? "ai" : "template"}
                            detail={(a["sourceContext"] as { draftModel?: string }).draftModel ?? undefined}
                          />
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge s={String(a["status"])} />
                          <Link className="btn" href={`/approvals?id=${a["id"]}`}>
                            Review
                          </Link>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
