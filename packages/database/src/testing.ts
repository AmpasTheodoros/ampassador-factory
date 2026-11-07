import { Db } from "./db";
import { PgDatabase, PgliteDatabase, type Database } from "./driver";

export interface TestHarness {
  /** Privileged owner handle: fixtures and negative tests only. Never pass this to request-handling code. */
  admin: Db;
  /** The same interface production uses. */
  database: Database;
  close(): Promise<void>;
}

/** In-process embedded Postgres, request path = Database.run (SET LOCAL ROLE per transaction). */
export async function openTestHarness(): Promise<TestHarness> {
  const admin = await Db.open();
  const database = new PgliteDatabase(admin);
  return { admin, database, close: () => admin.close() };
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
    close: async () => {
      await database.close();
      await server.stop();
      await admin.close();
    },
  };
}
