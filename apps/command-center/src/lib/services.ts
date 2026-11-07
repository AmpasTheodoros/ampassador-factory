import "server-only";
import { createTelemetry, noopTelemetry, type Telemetry } from "@aaf/telemetry";
import { LocalDispatcher, TriggerDispatcher, realTriggerSdk, brainHandlers, makeBuildServices, type JobDispatcher, type RuntimeEnv } from "@aaf/jobs";
import { getEnv } from "./config";
import { getDb } from "./db";

const g = globalThis as unknown as { __aafTel?: Promise<Telemetry> };

export function getTelemetry(): Promise<Telemetry> {
  const env = getEnv();
  return (g.__aafTel ??= createTelemetry(env, env.AAF_APP_ORIGIN ?? "aaf").catch(() => noopTelemetry));
}

export function runtimeEnv(): RuntimeEnv {
  const e = getEnv();
  return {
    AI_GATEWAY_API_KEY: e.AI_GATEWAY_API_KEY, AAF_AI_MODEL_CLASSIFY: e.AAF_AI_MODEL_CLASSIFY, AAF_AI_MODEL_DRAFT: e.AAF_AI_MODEL_DRAFT,
    AAF_LLM_BASE_URL: e.AAF_LLM_BASE_URL, AAF_LLM_MODEL: e.AAF_LLM_MODEL, AAF_LLM_API_KEY: e.AAF_LLM_API_KEY, AAF_LLM_LOCATION: e.AAF_LLM_LOCATION,
    AAF_AI_PRICE_IN_PER_M: e.AAF_AI_PRICE_IN_PER_M, AAF_AI_PRICE_OUT_PER_M: e.AAF_AI_PRICE_OUT_PER_M, AAF_OWNER_NAME: e.AAF_OWNER_NAME,
    NETWORKRADAR_MCP_URL: e.NETWORKRADAR_MCP_URL, NETWORKRADAR_MCP_API_KEY: e.NETWORKRADAR_MCP_API_KEY,
  };
}

async function localDispatcher(): Promise<LocalDispatcher<import("@aaf/jobs").BrainServices>> {
  const { database, ledger } = await getDb();
  const tel = await getTelemetry();
  const env = runtimeEnv();
  return new LocalDispatcher(database, brainHandlers, {
    workerId: `local-${process.pid}`,
    buildServices: makeBuildServices(database, env, { ledger, onCall: (e) => tel.modelCall({ ...e, model: e.modelLabel, workspaceId: e.workspaceId }) }),
  });
}

/**
 * Runs due jobs for a workspace. With the Trigger.dev driver it asks Trigger.dev first; if that fails
 * it falls back to the local engine (claims are leased and enqueue is idempotent, so a double dispatch cannot double-run a job).
 */
export async function dispatchJobs(d: { workspaceId: string; jobId: string; correlationId: string }): Promise<{ driver: "local" | "trigger"; fellBack: boolean }> {
  const env = getEnv();
  const tel = await getTelemetry();
  let dispatcher: JobDispatcher | undefined;
  if (env.AAF_JOB_DRIVER === "trigger" && env.TRIGGER_SECRET_KEY) {
    try {
      dispatcher = new TriggerDispatcher(await realTriggerSdk());
      await dispatcher.dispatch(d);
      return { driver: "trigger", fellBack: false };
    } catch (e) {
      tel.error(e, { where: "trigger-dispatch", jobId: d.jobId });
    }
  }
  const local = await localDispatcher();
  await local.dispatch(d);
  return { driver: "local", fellBack: env.AAF_JOB_DRIVER === "trigger" };
}
