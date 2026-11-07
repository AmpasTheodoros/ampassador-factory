import { NextResponse } from "next/server";
import { runtime } from "@/lib/runtime";

export const dynamic = "force-dynamic";

/** Unauthenticated liveness: reveals only ok/db state, nothing about data. */
export async function GET() {
  try {
    const rt = await runtime();
    await rt.db.query("select 1");
    return NextResponse.json({ ok: true, db: "ok" });
  } catch {
    return NextResponse.json({ ok: false, db: "error" }, { status: 503 });
  }
}
