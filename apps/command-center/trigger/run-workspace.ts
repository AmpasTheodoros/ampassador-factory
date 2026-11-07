/**
 * Trigger.dev task: runs due jobs for ONE workspace using the same handlers as the local engine.
 *
 * SCAFFOLD, NOT VERIFIED: written against @trigger.dev/sdk 4.x types; no Trigger.dev project/credentials exist yet,
 * so it has never run. Needs in the Trigger.dev environment: DATABASE_URL (the least-privileged aaf_app role),
 * the AAF_* model variables, optionally NETWORKRADAR_MCP_*. It never receives a service-role key.
 */
import { task, tasks } from "@trigger.dev/sdk";
import { PgDatabase } from "@aaf/database";
import { runWorkspace, brainHandlers, makeBuildServices, TRIGGER_TASK_ID, type Dispatch, type RuntimeEnv } from "@aaf/jobs";

export const runWorkspaceTask = task({
  id: TRIGGER_TASK_ID,
  retry: { maxAttempts: 2 },
  queue: { concurrencyLimit: 5 },
  run: async (payload: Dispatch) => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set in the Trigger.dev environment");
    const database = new PgDatabase({ connectionString: url, max: 2 });
    const ledger = new PgDatabase({ connectionString: url, max: 2 }); // separate pool: ledger transactions must never wait on job transactions
    try {
      await database.assertLeastPrivilege(); // refuse to run with an over-privileged role
      const env = process.env as RuntimeEnv;
      const summary = await runWorkspace(database, payload.workspaceId, brainHandlers, {
        workerId: `trigger-${payload.jobId}`,
        buildServices: makeBuildServices(database, env, { ledger }),
      });
      // retries and expiring leases wake the workspace again at the right time
      if (summary.nextDueAt)
        await tasks.trigger(TRIGGER_TASK_ID, payload, {
          delay: new Date(summary.nextDueAt),
          idempotencyKey: `wake:${payload.workspaceId}:${summary.nextDueAt}`,
        });
      return summary;
    } finally {
      await database.close();
      await ledger.close();
    }
  },
});
