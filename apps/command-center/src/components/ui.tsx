import type { ReactNode } from "react";

type Tone = "neutral" | "good" | "warn" | "bad" | "demo";
const tones: Record<Tone, string> = {
  neutral: "border-[var(--line)] text-[var(--muted)]",
  good: "border-[var(--accent)] text-[var(--accent)]",
  warn: "border-[var(--warn)] text-[var(--warn)]",
  bad: "border-[var(--bad)] text-[var(--bad)]",
  demo: "border-[var(--warn)] text-[var(--warn)] border-dashed",
};
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}
export const DemoBadge = () => <Badge tone="demo">DEMO</Badge>;

export function statusTone(s: string): Tone {
  if (["succeeded", "connected", "approved", "done", "actioned"].includes(s)) return "good";
  if (["failed", "rejected", "expired", "error"].includes(s)) return "bad";
  if (["awaiting_approval", "executing", "queued", "running", "not_connected", "new"].includes(s)) return "warn";
  return "neutral";
}
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={statusTone(s)}>{s === "not_connected" ? "Needs connection" : s.replaceAll("_", " ")}</Badge>;

export function Card({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card p-4">
      {title && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide muted">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}
export const PageTitle = ({ title, sub }: { title: string; sub?: string }) => (
  <header className="mb-5">
    <h1 className="text-2xl font-semibold">{title}</h1>
    {sub && <p className="muted mt-1 text-sm">{sub}</p>}
  </header>
);
export const Empty = ({ children }: { children: ReactNode }) => <p className="muted rounded-lg border border-dashed border-[var(--line)] p-4 text-sm">{children}</p>;

export function Provenance({ items }: { items: { source: string; recordId?: string; retrievedAt: string; kind?: string; note?: string }[] }) {
  return (
    <ul className="space-y-1 text-xs">
      {items.map((p, i) => (
        <li key={i} className="muted">
          <span className="font-mono">{p.source}</span>
          {p.recordId ? <span className="font-mono"> #{p.recordId.slice(0, 8)}</span> : null}
          {" · "}{p.kind ?? "record"}{" · "}{new Date(p.retrievedAt).toISOString().slice(0, 16).replace("T", " ")}
          {p.note ? ` · ${p.note}` : ""}
        </li>
      ))}
    </ul>
  );
}
export const fmt = (iso: unknown) => (iso ? new Date(String(iso)).toISOString().slice(0, 16).replace("T", " ") + "Z" : "-");
