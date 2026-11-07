import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runtime, WORKSPACE_ID } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) return new NextResponse("unauthorized", { status: 401 });
  const { id } = await params;
  const rt = await runtime();
  const a = await rt.store.getApproval(WORKSPACE_ID, id);
  if (!a || a["status"] !== "succeeded") return new NextResponse("not found", { status: 404 });
  const ok = (await rt.store.listReceipts(WORKSPACE_ID, id)).find((r) => r["ok"]);
  const eml = (ok?.["result"] as { eml?: string } | undefined)?.eml;
  if (!eml) return new NextResponse("no export for this approval", { status: 404 });
  return new NextResponse(eml, { headers: { "content-type": "message/rfc822", "content-disposition": `attachment; filename="reply-${id.slice(0, 8)}.eml"` } });
}
