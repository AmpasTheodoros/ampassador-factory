"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ingestMessage, approveAndRun, rejectApproval, seedDemo, MessageInput } from "@aaf/brain";
import { DomainError } from "@aaf/core";
import { runtime, WORKSPACE_ID } from "./runtime";
import { requireSession, authMode, checkPassword, setSessionCookie, clearSessionCookie } from "./auth";

const msg = (e: unknown) => encodeURIComponent(e instanceof DomainError || e instanceof Error ? e.message.slice(0, 300) : "error");

export async function login(form: FormData) {
  if (authMode() !== "password") redirect("/login");
  if (!checkPassword(String(form.get("password") ?? ""))) redirect("/login?error=1");
  await setSessionCookie();
  redirect("/overview");
}
export async function logout() {
  await clearSessionCookie();
  redirect("/login");
}

export async function submitMessage(form: FormData) {
  await requireSession();
  const parsed = MessageInput.safeParse({
    fromEmail: String(form.get("fromEmail") ?? "").trim(),
    fromName: String(form.get("fromName") ?? "").trim() || undefined,
    subject: String(form.get("subject") ?? "").trim(),
    body: String(form.get("body") ?? "").trim(),
  });
  if (!parsed.success) redirect(`/inbox?error=${encodeURIComponent("Sender email and message text are required")}`);
  const rt = await runtime();
  const r = await ingestMessage(rt.deps, WORKSPACE_ID, parsed.data);
  revalidatePath("/", "layout");
  redirect(`/inbox?item=${r.inboxItemId}${r.duplicate ? "&dup=1" : ""}`);
}

export async function decideApproval(form: FormData) {
  const s = await requireSession();
  const id = String(form.get("id"));
  const decision = String(form.get("decision"));
  const note = String(form.get("note") ?? "").trim() || undefined;
  const confirmHash = String(form.get("confirmHash") ?? "") || undefined;
  const rt = await runtime();
  try {
    if (decision === "approve") await approveAndRun(rt.deps, WORKSPACE_ID, id, { id: s.userId, role: s.role }, { note, confirmHash });
    else await rejectApproval(rt.deps, WORKSPACE_ID, id, { id: s.userId, role: s.role }, note);
  } catch (e) {
    redirect(`/approvals?id=${id}&error=${msg(e)}`);
  }
  revalidatePath("/", "layout");
  redirect(`/approvals?id=${id}`);
}

export async function replayApproval(form: FormData) {
  const s = await requireSession();
  const id = String(form.get("id"));
  const rt = await runtime();
  try {
    await rt.gateway.replay(WORKSPACE_ID, id, { id: s.userId, role: s.role });
  } catch (e) {
    redirect(`/approvals?id=${id}&error=${msg(e)}`);
  }
  revalidatePath("/", "layout");
  redirect(`/approvals?id=${id}`);
}

export async function completeTask(form: FormData) {
  await requireSession();
  const rt = await runtime();
  await rt.store.setTaskStatus(WORKSPACE_ID, String(form.get("id")), "done");
  await rt.store.audit(WORKSPACE_ID, "user:owner", "task.completed", "task", String(form.get("id")));
  revalidatePath("/", "layout");
}

export async function loadDemoData() {
  await requireSession();
  const rt = await runtime();
  await seedDemo(rt.deps, WORKSPACE_ID);
  revalidatePath("/", "layout");
  redirect("/overview");
}
