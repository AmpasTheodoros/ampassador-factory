import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness only: the process is up. No database, no configuration detail. */
export async function GET() {
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
