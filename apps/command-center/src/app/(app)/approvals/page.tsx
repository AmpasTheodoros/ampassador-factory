import Link from "next/link";
import { withApp } from "@/lib/runtime";
import { decideApproval, replayApproval } from "@/lib/actions";
import { Card, PageTitle, Empty, Badge, DemoBadge, OriginBadge, Provenance, StatusBadge, fmt } from "@/components/ui";

export const maxDuration = 60; // triage and approval actions run model calls and jobs

export default async function Approvals({ searchParams }: { searchParams: Promise<{ id?: string; error?: string }> }) {
  const { id, error } = await searchParams;
  const { rows, sel, receipts, audit, role } = await withApp(async (app) => {
    if (app.role === "owner" || app.role === "admin") await app.gateway.expireStale(app.workspaceId);
    const sel = id ? await app.store.getApproval(app.workspaceId, id) : undefined;
    return {
      rows: await app.store.listApprovals(app.workspaceId), sel,
      receipts: sel ? await app.store.listReceipts(app.workspaceId, id!) : [],
      audit: sel ? await app.store.listAudit(app.workspaceId, "approval", id) : [],
      role: app.role,
    };
  });
  const payload = sel?.["payload"] as { to?: string; subject?: string; body?: string } | undefined;
  const ctx = (sel?.["sourceContext"] ?? {}) as { flags?: string[]; provenance?: never[]; isDemo?: boolean; delivery?: string; intent?: string; draftSource?: string; draftModel?: string | null; classification?: { by: string; model: string | null }; facts?: { label: string; value: string; status: "verified" | "unverified"; source: string }[] };
  const canDecide = role === "owner" || role === "admin";
  const status = String(sel?.["status"] ?? "");
  const double = sel?.["riskTier"] === "financial_or_irreversible";
  const ok = receipts.find((r) => r["ok"]);
  const result = ok?.["result"] as { delivered?: boolean } | undefined;

  return (
    <>
      <PageTitle title="Approvals" sub="Every outbound action waits here. Approval covers the exact payload shown, identified by its hash." />
      {error && <p role="alert" className="mb-3 text-sm" style={{ color: "var(--bad)" }}>{error}</p>}
      <div className="grid gap-4 md:grid-cols-[20rem_1fr]">
        <Card title="Queue">
          {rows.length === 0 ? <Empty>Nothing proposed yet. Triage a message in the Inbox.</Empty> : (
            <ul className="space-y-1">
              {rows.map((r) => (
                <li key={String(r["id"])}>
                  <Link href={`/approvals?id=${r["id"]}`} className={`block rounded-md p-2 text-sm hover:bg-[var(--line)] ${r["id"] === id ? "bg-[var(--line)]" : ""}`}>
                    <div className="font-medium">{String(r["summary"])}</div>
                    <div className="muted flex items-center gap-1 text-xs"><StatusBadge s={String(r["status"])} />{(r["sourceContext"] as { isDemo?: boolean }).isDemo ? <DemoBadge /> : null}<Badge>{String(r["riskTier"]).replaceAll("_", " ")}</Badge></div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {!sel ? <Empty>Select a proposal to review the exact content, its source and its history.</Empty> : (
          <div className="space-y-4">
            <Card title="Proposed action" right={<StatusBadge s={status} />}>
              <p className="font-medium">{String(sel["summary"])}</p>
              <p className="muted mt-1 text-xs">Tool {String(sel["toolId"])} · requested by {String(sel["requestedBy"])} · expires {fmt(sel["expiresAt"])}</p>
              {ctx.delivery === "export_only_gmail_not_connected" && <p className="mt-2 text-sm" style={{ color: "var(--warn)" }}>Gmail is not connected. Approving exports the text; the system will NOT send it.</p>}
              {ctx.flags && ctx.flags.length > 0 && <ul className="mt-2 text-sm" style={{ color: "var(--warn)" }}>{ctx.flags.map((f, i) => <li key={i}>Warning: {f}</li>)}</ul>}
              <dl className="mt-3 space-y-2 text-sm">
                <div><dt className="muted text-xs">To</dt><dd>{payload?.to}</dd></div>
                <div><dt className="muted text-xs">Subject</dt><dd>{payload?.subject}</dd></div>
                <div><dt className="muted text-xs">Body <OriginBadge kind={ctx.draftSource === "llm" ? "ai" : "template"} detail={ctx.draftModel ?? undefined} /></dt><dd><pre className="whitespace-pre-wrap rounded-md border border-[var(--line)] p-3">{payload?.body}</pre></dd></div>
                <div><dt className="muted text-xs">Payload hash (sha-256)</dt><dd className="break-all font-mono text-xs">{String(sel["payloadHash"])}</dd></div>
              </dl>
              {status === "awaiting_approval" && !canDecide && <p className="mt-4 text-sm muted">Only an owner or admin can decide approvals.</p>}
              {status === "awaiting_approval" && canDecide && (
                <form action={decideApproval} className="mt-4 space-y-2">
                  <input type="hidden" name="id" value={String(sel["id"])} />
                  <label className="block text-xs" htmlFor="note">Note (optional, recorded as a correction if you reject)</label>
                  <input id="note" name="note" className="field" />
                  {double && <><label className="block text-xs" htmlFor="confirmHash">Second confirmation: paste the payload hash</label><input id="confirmHash" name="confirmHash" className="field font-mono" /></>}
                  <div className="flex gap-2">
                    <button name="decision" value="approve" className="btn btn-primary" type="submit">Approve{ctx.delivery === "export_only_gmail_not_connected" ? " and export" : ""}</button>
                    <button name="decision" value="reject" className="btn btn-danger" type="submit">Reject</button>
                  </div>
                </form>
              )}
              {status === "failed" && canDecide && (
                <form action={replayApproval} className="mt-4"><input type="hidden" name="id" value={String(sel["id"])} /><button className="btn" type="submit">Replay (operator)</button></form>
              )}
              {status === "succeeded" && result?.delivered === false && (
                <p className="mt-4 text-sm">Exported, not delivered. <a className="btn" href={`/api/approvals/${sel["id"]}/eml`}>Download .eml</a> and send it yourself; a follow-up task was created.</p>
              )}
            </Card>
            {ctx.provenance && <Card title="Source context"><Provenance items={ctx.provenance} />{ctx.facts && <ul className="mt-2 space-y-1 text-xs">{ctx.facts.map((f, i) => <li key={i}>{f.label}: <span className="font-mono">{f.value}</span> <OriginBadge kind={f.status} detail={f.source} /></li>)}</ul>}{ctx.intent && <p className="muted mt-2 text-xs">Intent: {ctx.intent}</p>}</Card>}
            <Card title="Execution receipts">
              {receipts.length === 0 ? <Empty>Not executed.</Empty> : (
                <ul className="space-y-1 text-sm">{receipts.map((r) => <li key={String(r["id"])}>attempt {String(r["attempt"])} · {r["ok"] ? "ok" : "failed"} · {String(r["executedBy"])} · {fmt(r["executedAt"])}{r["error"] ? ` · ${String(r["error"])}` : ""}</li>)}</ul>
              )}
            </Card>
            <Card title="Audit trail">
              <ul className="space-y-1 text-xs">{audit.map((a) => <li key={String(a["id"])}><span className="font-mono">{fmt(a["createdAt"])}</span> {String(a["actor"])} · {String(a["action"])}</li>)}</ul>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
