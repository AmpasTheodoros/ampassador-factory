import "server-only";
import { Db, PgDatabase, PgliteDatabase, type Database } from "@aaf/database";
import { authProviderName, getEnv, isProd, productionProblems } from "./config";
import { LOCAL_AUTH_SQL, seedDevUser } from "./auth/local";

export interface DbHandle {
  database: Database;
  /** Present only for the embedded database (dev/e2e). Never used for request handling. */
  embedded?: Db;
}

const g = globalThis as unknown as { __aafDb?: Promise<DbHandle> };

async function open(): Promise<DbHandle> {
  const env = getEnv();
  if (isProd(env)) {
    const problems = productionProblems(env);
    if (problems.length) throw new Error(`Production configuration invalid: ${problems.map((p) => p.key).join(", ")}`);
  }
  if (env.DATABASE_URL) {
    const database = new PgDatabase({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX });
    // Refuse to serve if the connection role could bypass RLS (superuser, BYPASSRLS, or table owner).
    if (isProd(env)) await database.assertLeastPrivilege();
    return { database };
  }
  if (isProd(env)) throw new Error("DATABASE_URL is required in production");
  const embedded = await Db.open({ dataDir: env.AAF_DATA_DIR === ":memory:" ? undefined : env.AAF_DATA_DIR });
  if (authProviderName(env) === "local") {
    await embedded.exec(LOCAL_AUTH_SQL);
  }
  const database = new PgliteDatabase(embedded);
  if (authProviderName(env) === "local" && env.AAF_DEV_EMAIL && env.AAF_DEV_PASSWORD) await seedDevUser(database, env.AAF_DEV_EMAIL, env.AAF_DEV_PASSWORD);
  if (authProviderName(env) === "local" && env.AAF_DEV_EMAIL_2 && env.AAF_DEV_PASSWORD_2) await seedDevUser(database, env.AAF_DEV_EMAIL_2, env.AAF_DEV_PASSWORD_2);
  return { database, embedded };
}

export function getDb(): Promise<DbHandle> {
  return (g.__aafDb ??= open().catch((e) => {
    g.__aafDb = undefined; // allow retry after a transient failure
    throw e;
  }));
}
