import type { Database } from "@aaf/database";
import { runWorkspace, type Handlers, type RunOptions, type RunSummary } from "./runner";

export interface Dispatch {
  workspaceId: string;
  jobId: string;
  correlationId: string;
}
export interface JobDispatcher {
  readonly name: "local" | "trigger";
  /** Ask the engine to run due jobs for this workspace. Must be safe to call repeatedly (claims are leased, enqueue is idempotent). */
  dispatch(d: Dispatch): Promise<void>;
}

/** Local execution: runs due jobs in-process and awaits them. Used in development, tests and as the fallback. */
export class LocalDispatcher<S> implements JobDispatcher {
  readonly name = "local" as const;
  last?: RunSummary;
  constructor(
    private database: Database,
    private handlers: Handlers<S>,
    private opts: RunOptions<S>,
  ) {}
  async dispatch(d: Dispatch) {
    this.last = await runWorkspace(this.database, d.workspaceId, this.handlers, this.opts);
  }
}

/** The subset of the Trigger.dev SDK used here, injectable for tests. */
export interface TriggerLike {
  trigger(taskId: string, payload: Dispatch, options: { idempotencyKey: string }): Promise<{ id: string }>;
}
export const TRIGGER_TASK_ID = "aaf-run-workspace";

/**
 * Trigger.dev dispatch: the task payload carries the workspace + correlation context; the worker rebuilds a
 * workspace-pinned service connection from it and runs the SAME handlers. The idempotency key makes repeated
 * dispatches of the same job collapse into one Trigger.dev run.
 * Scaffolded against @trigger.dev/sdk 4.x types; NOT verified against a live Trigger.dev project (no credentials).
 */
export class TriggerDispatcher implements JobDispatcher {
  readonly name = "trigger" as const;
  constructor(private sdk: TriggerLike) {}
  async dispatch(d: Dispatch) {
    await this.sdk.trigger(TRIGGER_TASK_ID, d, { idempotencyKey: `job:${d.jobId}` });
  }
}

export async function realTriggerSdk(): Promise<TriggerLike> {
  const { tasks } = await import("@trigger.dev/sdk");
  return {
    trigger: async (id, payload, options) => ({ id: (await tasks.trigger(id, payload, { idempotencyKey: options.idempotencyKey })).id }),
  };
}
