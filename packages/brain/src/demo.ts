import { ingestMessage, type BrainDeps } from "./workflows";

/** Synthetic examples, all flagged is_demo and shown with a DEMO badge. Not real people or conversations. */
export const DEMO_MESSAGES = [
  { fromEmail: "demo.operator@example.com", fromName: "Demo Operator", subject: "Could we have a call about automating our bookings?", body: "Hi, I run a small property management company (DEMO DATA). We lose a lot of time on booking confirmations. Are you available for a call next week?", externalId: "demo-1" },
  { fromEmail: "demo.buyer@example.com", fromName: "Demo Buyer", subject: "Pricing for a pilot", body: "(DEMO DATA) Interested in what a small pilot would cost for our back office. What are your rates?", externalId: "demo-2" },
  { fromEmail: "demo.latecomer@example.com", fromName: "Demo Latecomer", subject: "Re: intro", body: "(DEMO DATA) Thanks, but not right now. Maybe next quarter.", externalId: "demo-3" },
] as const;

export async function seedDemo(deps: BrainDeps, ws: string) {
  const results = [];
  for (const m of DEMO_MESSAGES) results.push(await ingestMessage(deps, ws, { ...m }, { isDemo: true }));
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();
  const has = (await deps.store.listTasks(ws)).some((t) => t["isDemo"]);
  if (!has) {
    await deps.store.createTask(ws, { title: "DEMO: send case-study draft to a pilot prospect", dueAt: new Date(nowMs - 2 * 86400_000).toISOString(), isDemo: true });
    await deps.store.createTask(ws, { title: "DEMO: prepare notes for workflow-discovery visit", dueAt: new Date(nowMs + 86400_000).toISOString(), isDemo: true });
  }
  return results;
}
