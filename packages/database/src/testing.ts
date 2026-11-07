import { Db } from "./db";
import type { AdminHandle } from "./live";
import { PgDatabase, PgliteDatabase, type Database } from "./driver";
import type { Queryable } from "./db";

export interface TestHarness {
  /** Privileged owner handle: fixtures and negative tests only. Never pass this to request-handling code. */
  admin: AdminHandle & Queryable;
  /** "embedded" (PGlite) or "realpg" (a real PostgreSQL server reached as the least-privileged aaf_app login role). */
  backend: "embedded" | "realpg";
  /** The same interface production uses. */
  database: Database;
  /** Real-Postgres harness only: dedicated pool for autonomous ledger transactions. */
  ledgerDatabase?: Database;
  close(): Promise<void>;
}

/** In-process embedded Postgres, request path = Database.run (SET LOCAL ROLE per transaction). */
export async function openTestHarness(): Promise<TestHarness> {
  if (process.env.AAF_TEST_BACKEND === "realpg") {
    const { openRealPgHarness } = await import("./live");
    const h = await openRealPgHarness();
    return { admin: h.admin, database: h.database, ledgerDatabase: h.ledgerDatabase, backend: "realpg", close: h.close };
  }
  const admin = await Db.open();
  const database = new PgliteDatabase(admin);
  return { admin, database, backend: "embedded", close: () => admin.close() };
}

/**
 * Same database, but reached through the Postgres wire protocol with the real node-postgres pool (PgDatabase),
 * so the production driver code (BEGIN/SET LOCAL/set_config/COMMIT, parameter passing) runs for real.
 * Pool size is 1 because the embedded server serialises connections onto one session.
 */
export async function openWireHarness(port: number): Promise<TestHarness> {
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const admin = await Db.open();
  const server = new PGLiteSocketServer({ db: admin.pg, port, host: "127.0.0.1" });
  await server.start();
  const database = new PgDatabase({ connectionString: `postgres://postgres:x@127.0.0.1:${port}/postgres`, max: 1, ssl: false });
  return {
    admin,
    database,
    backend: "embedded",
    close: async () => {
      await database.close();
      await server.stop();
      await admin.close();
    },
  };
}
