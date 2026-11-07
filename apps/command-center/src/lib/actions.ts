"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { ingestMessage, approveAndRun, rejectApproval, seedDemo, MessageInput } from "@aaf/brain";
import { enqueue, requestCancel, replay as replayJob } from "@aaf/jobs";
import { refreshNetworkRadarConnection } from "@aaf/jobs";
import { DomainError, newId } from "@aaf/core";
import { Store } from "@aaf/database";
import { getEnv } from "./config";
import { getDb } from "./db";
import { getAuth } from "./auth";
import { assertSameOrigin, withApp } from "./runtime";
import { dispatchJobs, getTelemetry, runtimeEnv } from "./services";

const msg = (e: unknown) => encodeURIComponent(e instanceof DomainError || e instanceof Error ? e.message.slice(0, 300) : "error");

function clientIp(h: Headers): string {
  // Vercel sets x-forwarded-for with the client first; behind other proxies configure accordingly.
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

export async function login(form: FormData) {
  await assertSameOrigin();
  const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 254);
  const password = String(form.get("password") ?? "").slice(0, 200);
  const h = await headers();
  const { database } = await getDb();
  const tel = await getTelemetry();
  // Rate limit BEFORE touching credentials: per IP and per account (distributed, DB-backed).
  const allowed = await database.run({ kind: "anon" }, async (q) => {
    const s = new Store(q);
    const ipOk = await s.rateHit(`login:ip:${clientIp(h)}`, 20, 300);
    const emailOk = await s.rateHit(`login:email:${email || "none"}`, 8, 300);
    return ipOk && emailOk;
  });
  if (!allowed) {
    tel.event("login_rate_limited");
    redirect("/login?error=rate");
  }
  const auth = await getAuth();
  if (!auth || !email || !password) redirect("/login?error=1");
  const r = await auth.signIn(email, password);
  tel.event("login", { ok: r.ok });
  if (!r.ok) redirect(r.reason === "error" ? "/login?error=unavailable" : "/login?error=1"); // same message for unknown user and wrong password
  redirect("/overview");
}

export async function logout() {
  await assertSameOrigin();
  const auth = await getAuth();
  await auth?.signOut();
  redirect("/login");
}

export async function submitMessage(form: FormData) {
  const parsed = MessageInput.safeParse({
    fromEmail: String(form.get("fromEmail") ?? "").trim(),
    fromName: String(form.get("fromName") ?? "").trim() || undefined,
    subject: String(form.get("subject") ?? "").trim(),
    body: String(form.get("body") ?? "").trim(),
  });
  if (!parsed.success) redirect(`/inbox?error=${encodeURIComponent("Sender email and message text are required")}`);
  const env = getEnv();
  let target: { itemId?: string; dup: boolean; error?: string };
  try {
    const out = await withApp(async (app) => {
      await refreshNetworkRadarConnection(app.store, app.workspaceId, runtimeEnv()); // cached; keeps connector status truthful
      if (env.AAF_TRIAGE_MODE === "inline") {
        const r = await ingestMessage(app.deps, app.workspaceId, parsed.data);
        return { itemId: r.inboxItemId, dup: r.duplicate, workspaceId: app.workspaceId, jobId: undefined as string | undefined, correlationId: "" };
      }
      const r = await ingestMessage(app.deps, app.workspaceId, parsed.data, { triage: false });
      let jobId: string | undefined;
      const correlationId = newId();
      if (!r.duplicate && r.inboxItemId) {
        const j = await enqueue(app.store.db, app.workspaceId, { type: "w1.triage", input: { inboxItemId: r.inboxItemId }, idempotencyKey: `triage:${r.inboxItemId}`, correlationId, createdBy: `user:${app.user.id}` });
        jobId = j.jobId;
      }
      return { itemId: r.inboxItemId, dup: r.duplicate, workspaceId: app.workspaceId, jobId, correlationId };
    }, { mutating: true });
    // the durable job runs AFTER the user transaction has committed, as the workspace-pinned service role
    if (out.jobId) await dispatchJobs({ workspaceId: out.workspaceId, jobId: out.jobId, correlationId: out.correlationId });
    target = { itemId: out.itemId, dup: out.dup };
  } catch (e) {
    target = { dup: false, error: msg(e) };
  }
  if (target.error) redirect(`/inbox?error=${target.error}`);
  revalidatePath("/", "layout");
  redirect(`/inbox?item=${target.itemId}${target.dup ? "&dup=1" : ""}`);
}

export async function decideApproval(form: FormData) {
  const id = String(form.get("id"));
  const decision = String(form.get("decision"));
  const note = String(form.get("note") ?? "").trim() || undefined;
  const confirmHash = String(form.get("confirmHash") ?? "") || undefined;
  let out: { workspaceId: string } | { error: string };
  try {
    out = await withApp(async (app) => {
      const user = { id: app.user.id, role: app.role };
      if (decision === "approve") await approveAndRun(app.deps, app.workspaceId, id, user, { note, confirmHash });
      else await rejectApproval(app.deps, app.workspaceId, id, user, note);
      (await getTelemetry()).event("approval_decided", { decision });
      return { workspaceId: app.workspaceId };
    }, { mutating: true });
    // wake any job parked on this approval (resume happens in the service role, outside this transaction)
    await dispatchJobs({ workspaceId: out.workspaceId, jobId: "resume", correlationId: id });
  } catch (e) {
    out = { error: msg(e) };
  }
  if ("error" in out) redirect(`/approvals?id=${id}&error=${out.error}`);
  revalidatePath("/", "layout");
  redirect(`/approvals?id=${id}`);
}

export async function replayApproval(form: FormData) {
  const id = String(form.get("id"));
  let error: string | undefined;
  try {
    await withApp((app) => app.gateway.replay(app.workspaceId, id, { id: app.user.id, role: app.role }), { mutating: true });
  } catch (e) {
    error = msg(e);
  }
  if (error) redirect(`/approvals?id=${id}&error=${error}`);
  revalidatePath("/", "layout");
  redirect(`/approvals?id=${id}`);
}

export async function completeTask(form: FormData) {
  const id = String(form.get("id"));
  await withApp(async (app) => {
    await app.store.setTaskStatus(app.workspaceId, id, "done");
    await app.store.audit(app.workspaceId, `user:${app.user.id}`, "task.completed", "task", id);
  }, { mutating: true });
  revalidatePath("/", "layout");
}

export async function loadDemoData() {
  await withApp(async (app) => {
    await seedDemo(app.deps, app.workspaceId);
  }, { mutating: true });
  revalidatePath("/", "layout");
  redirect("/overview");
}

export async function cancelJob(form: FormData) {
  const id = String(form.get("id"));
  await withApp(async (app) => {
    await requestCancel(app.store.db, app.workspaceId, id, `user:${app.user.id}`);
  }, { mutating: true });
  revalidatePath("/", "layout");
  redirect("/operations");
}

export async function replayJobAction(form: FormData) {
  const id = String(form.get("id"));
  const r = await withApp(async (app) => {
    if (!["owner", "admin"].includes(app.role)) throw new DomainError("forbidden", "Only owner/admin may replay jobs");
    return { workspaceId: app.workspaceId };
  }, { mutating: true });
  // replay needs to write job state: that is an internal operation, done by the service role pinned to this workspace
  const { database } = await getDb();
  await database.run({ kind: "service", workspaceId: r.workspaceId, reason: "operator-replay" }, async (q) => {
    await replayJob(q, r.workspaceId, id, "operator", new Date());
  });
  await dispatchJobs({ workspaceId: r.workspaceId, jobId: id, correlationId: id });
  revalidatePath("/", "layout");
  redirect("/operations");
}
