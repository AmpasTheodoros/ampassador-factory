import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { logout } from "@/lib/actions";
import { runtime, WORKSPACE_ID } from "@/lib/runtime";
import { DemoBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

const LIVE = [
  ["/overview", "Overview"], ["/inbox", "Inbox"], ["/approvals", "Approvals"], ["/agents", "Agents"],
  ["/automations", "Automations"], ["/analytics", "Analytics"], ["/settings", "Settings"],
] as const;
const PLANNED = [
  ["Network", "R2"], ["Sales", "R2"], ["Research", "R2"], ["Projects", "R2"], ["Content", "R3"], ["Marketing", "R4"],
  ["Knowledge", "R4"], ["Events", "R4"], ["Finance", "R4"],
] as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const rt = await runtime();
  const pending = (await rt.store.listApprovals(WORKSPACE_ID, "awaiting_approval")).length;
  const hasDemo = (await rt.store.listInbox(WORKSPACE_ID)).some((i) => i["isDemo"]);
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <nav aria-label="Main" className="border-b border-[var(--line)] p-3 md:w-56 md:shrink-0 md:border-b-0 md:border-r">
        <div className="mb-3 px-2 text-sm font-semibold">Command Center</div>
        <ul className="flex flex-wrap gap-1 md:block md:space-y-1">
          {LIVE.map(([href, label]) => (
            <li key={href}>
              <Link href={href} className="block rounded-md px-2 py-1.5 text-sm hover:bg-[var(--line)]">
                {label}
                {label === "Approvals" && pending > 0 ? <span className="ml-2 rounded-full bg-[var(--warn)] px-1.5 text-xs text-white" aria-label={`${pending} pending`}>{pending}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
        <details className="mt-4 hidden text-xs md:block">
          <summary className="muted cursor-pointer px-2">Planned (not built)</summary>
          <ul className="mt-1 space-y-1 px-2">
            {PLANNED.map(([n, r]) => (
              <li key={n} className="muted" aria-disabled="true">{n} <span className="font-mono">{r}</span></li>
            ))}
          </ul>
        </details>
      </nav>
      <div className="min-w-0 flex-1">
        {session.mode === "dev_open" && <div role="status" className="bg-[var(--warn)] px-4 py-1 text-xs text-white">Dev mode: no password set, anyone who can reach this server is signed in. Set AAF_ADMIN_PASSWORD.</div>}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-4 py-2 text-xs muted">
          <span>Workspace: personal {hasDemo && <DemoBadge />}</span>
          <form action={logout}><button className="btn" type="submit">Sign out</button></form>
        </div>
        <main className="mx-auto max-w-5xl p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
