import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/config";
import { getDb } from "@/lib/db";
import { dispatchJobs } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Scheduler hook (Vercel Cron / Trigger.dev schedule / uptime pinger): runs due jobs for the workspaces that have
 * any. Authenticated by a shared secret. It acts only through workspace-pinned service transactions.
 */
export async function POST(req: Request) {
  const secret = getEnv().AAF_CRON_SECRET;
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret)))
    return new NextResponse("unauthorized", { status: 401 });
  const { database, embedded } = await getDb();
  if (!embedded) {
    // With a least-privileged app role there is deliberately no cross-tenant listing. Scheduled fan-out is done by
    // Trigger.dev per workspace (payload carries workspaceId); this endpoint then only serves the embedded dev database.
    return NextResponse.json(
      { ok: false, error: "tick is for the embedded dev database; use Trigger.dev schedules in production" },
      { status: 501 },
    );
  }
  const ws = await embedded.query<{ id: string }>(
    `select distinct workspace_id as id from jobs where status in ('queued','waiting_approval','running')`,
  );
  for (const w of ws) await dispatchJobs({ workspaceId: w.id, jobId: "tick", correlationId: "tick" });
  void database;
  return NextResponse.json({ ok: true, workspaces: ws.length });
}
