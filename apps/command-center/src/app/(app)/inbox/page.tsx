import Link from "next/link";
import { runtime, WORKSPACE_ID } from "@/lib/runtime";
import { submitMessage } from "@/lib/actions";
import { Card, PageTitle, Empty, Badge, DemoBadge, Provenance, StatusBadge, fmt } from "@/components/ui";

export default async function Inbox({ searchParams }: { searchParams: Promise<{ item?: string; error?: string; dup?: string }> }) {
  const { item, error, dup } = await searchParams;
  const rt = await runtime();
  const rows = await rt.store.listInbox(WORKSPACE_ID);
  const sel = item ? await rt.store.getInboxItem(WORKSPACE_ID, item) : undefined;
  const rec = sel ? await rt.store.recommendationForInbox(WORKSPACE_ID, item!) : undefined;
  const approvals = sel ? (await rt.store.listApprovals(WORKSPACE_ID)).filter((a) => (a["sourceContext"] as { inboxItemId?: string }).inboxItemId === item) : [];
  const why = rec?.["why"] as { reasons: string[]; flags: string[]; confidence: number; urgency: number; impact: number; effort: number } | undefined;
  const payload = sel?.["eventPayload"] as { fromEmail: string; fromName: string | null; subject: string; body: string } | undefined;

  return (
    <>
      <PageTitle title="Inbox" sub="Signals from connected sources and pasted conversations. Nothing here is sent automatically." />
      {error && <p role="alert" className="mb-3 text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
      {dup && <p role="status" className="mb-3 text-sm muted">This message was already ingested; showing the existing item.</p>}
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <div className="space-y-4">
          <Card title="Add a message">
            <form action={submitMessage} className="space-y-2">
              <label className="block text-xs" htmlFor="fromEmail">Sender email</label>
              <input id="fromEmail" name="fromEmail" type="email" required className="field" />
              <label className="block text-xs" htmlFor="fromName">Sender name</label>
              <input id="fromName" name="fromName" className="field" />
              <label className="block text-xs" htmlFor="subject">Subject</label>
              <input id="subject" name="subject" className="field" />
              <label className="block text-xs" htmlFor="body">Message</label>
              <textarea id="body" name="body" required rows={6} className="field" />
              <button className="btn btn-primary w-full" type="submit">Triage</button>
            </form>
          </Card>
          <Card title="Items">
            {rows.length === 0 ? <Empty>Inbox is empty. Paste a message above.</Empty> : (
              <ul className="space-y-1">
                {rows.map((r) => (
                  <li key={String(r["id"])}>
                    <Link href={`/inbox?item=${r["id"]}`} className={`block rounded-md p-2 text-sm hover:bg-[var(--line)] ${r["id"] === item ? "bg-[var(--line)]" : ""}`}>
                      <div className="font-medium">{String(r["title"])}</div>
                      <div className="muted flex flex-wrap items-center gap-1 text-xs">{String(r["contactName"] ?? r["contactEmail"])} <StatusBadge s={String(r["status"])} />{r["isDemo"] ? <DemoBadge /> : null}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          {!sel ? <Empty>Select an item to see the classification, reasoning and draft.</Empty> : (
            <>
              <Card title="Message (untrusted content, shown as plain text)">
                <p className="text-sm"><b>{payload!.fromName ?? payload!.fromEmail}</b> <span className="muted">&lt;{payload!.fromEmail}&gt; · {fmt(sel["eventOccurredAt"])} · source {String(sel["eventSource"])}</span></p>
                <p className="mt-1 font-medium">{payload!.subject}</p>
                <pre className="mt-2 whitespace-pre-wrap text-sm">{payload!.body}</pre>
              </Card>
              {rec && why && (
                <Card title="Brain recommendation">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{String(rec["title"])}</h3><Badge tone="good">{String(rec["actionClass"]).replace("_", " ")}</Badge></div>
                  <p className="muted mt-1 text-sm">confidence {Math.round(why.confidence * 100)}% · urgency {why.urgency}/10 · impact {why.impact}/10 · effort {why.effort}/10 · score {Number(rec["score"])}</p>
                  <ul className="mt-2 list-disc pl-5 text-sm">{why.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  {why.flags.length > 0 && <ul className="mt-2 text-sm" style={{ color: "var(--warn)" }}>{why.flags.map((f, i) => <li key={i}>Warning: {f}</li>)}</ul>}
                  <details className="mt-2 text-xs"><summary className="muted cursor-pointer">Provenance</summary><Provenance items={rec["provenance"] as never} /></details>
                </Card>
              )}
              <Card title="Proposed actions">
                {approvals.length === 0 ? <Empty>{rec && ["ignore", "monitor"].includes(String(rec["actionClass"])) ? "No reply proposed: this message does not call for one." : "No action proposed."}</Empty> : (
                  <ul className="space-y-2 text-sm">
                    {approvals.map((a) => (
                      <li key={String(a["id"])} className="flex flex-wrap items-center justify-between gap-2">
                        <span>{String(a["summary"])}</span>
                        <span className="flex items-center gap-2"><StatusBadge s={String(a["status"])} /><Link className="btn" href={`/approvals?id=${a["id"]}`}>Review</Link></span>
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
