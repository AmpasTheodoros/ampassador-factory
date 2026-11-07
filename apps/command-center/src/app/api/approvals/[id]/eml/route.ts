import { NextResponse } from "next/server";
import { withApp } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const eml = await withApp(async (app) => {
    const a = await app.store.getApproval(app.workspaceId, id);
    if (!a || a["status"] !== "succeeded") return undefined;
    const ok = (await app.store.listReceipts(app.workspaceId, id)).find((r) => r["ok"]);
    return (ok?.["result"] as { eml?: string } | undefined)?.eml;
  }, { noRedirect: true });
  if (eml === null) return new NextResponse("unauthorized", { status: 401 });
  if (!eml) return new NextResponse("not found", { status: 404 });
  return new NextResponse(eml, { headers: { "content-type": "message/rfc822", "content-disposition": `attachment; filename="reply-${id.slice(0, 8)}.eml"`, "cache-control": "no-store" } });
}
