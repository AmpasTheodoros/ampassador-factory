#!/usr/bin/env node
/**
 * A REAL PostgreSQL (official binaries via the `embedded-postgres` package, pinned to 17.x) for local validation.
 * Not Supabase, but a genuine server process: real login roles, scram-sha-256, real concurrent connections.
 *
 *   node scripts/local-postgres.mjs start      initdb (first time) + start; prints the URLs
 *   node scripts/local-postgres.mjs stop
 *   node scripts/local-postgres.mjs status
 *   node scripts/local-postgres.mjs reset      stop + delete the data directory
 *
 * Data lives in <repo>/.data/localpg (gitignored). Listens on 127.0.0.1 only.
 * Passwords below are for this throwaway local server only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const dataDir = process.env.AAF_LOCALPG_DIR ?? join(root, ".data", "localpg");
const port = process.env.AAF_LOCALPG_PORT ?? "54330";
const ADMIN_PW = "local-admin-only";

import { realpathSync } from "node:fs";
// pnpm layout: <store>/embedded-postgres@x/node_modules/{embedded-postgres,@embedded-postgres/<platform>}
const epReal = realpathSync(join(here, "..", "node_modules", "embedded-postgres"));
const bin = join(
  dirname(epReal),
  "@embedded-postgres",
  `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
  "native",
  "bin",
);
const exe = (n) => join(bin, process.platform === "win32" ? `${n}.exe` : n);
const run = (n, args, opts = {}) => spawnSync(exe(n), args, { encoding: "utf8", ...opts });

export const urls = {
  admin: `postgres://postgres:${ADMIN_PW}@127.0.0.1:${port}/postgres`,
};

const cmd = process.argv[2] ?? "status";
const running = () => run("pg_ctl", ["-D", dataDir, "status"]).status === 0;

if (cmd === "start") {
  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    mkdirSync(dataDir, { recursive: true });
    const pw = join(dataDir, "..", "pw.tmp");
    writeFileSync(pw, ADMIN_PW);
    const r = run("initdb", ["-D", dataDir, "-U", "postgres", "--auth=scram-sha-256", "--pwfile", pw, "-E", "UTF8", "--locale=C"]);
    rmSync(pw, { force: true });
    if (r.status !== 0) {
      console.error(r.stderr || r.stdout);
      process.exit(1);
    }
  }
  if (!running()) {
    const r = run(
      "pg_ctl",
      [
        "-D",
        dataDir,
        "-l",
        join(dataDir, "..", "localpg.log"),
        "-o",
        `-p ${port} -c listen_addresses=127.0.0.1 -c max_connections=100`,
        "-w",
        "-t",
        "60",
        "start",
      ],
      { stdio: "ignore" },
    ); // stdio must not be piped: the server inherits it and would keep spawnSync waiting
    if (r.status !== 0) {
      console.error("pg_ctl start failed; see .data/localpg.log");
      process.exit(1);
    }
  }
  console.log(`running on 127.0.0.1:${port}\nLOCALPG_ADMIN_URL=${urls.admin}`);
} else if (cmd === "stop") {
  if (running()) run("pg_ctl", ["-D", dataDir, "-m", "fast", "-w", "stop"]);
  console.log("stopped");
} else if (cmd === "reset") {
  if (running()) run("pg_ctl", ["-D", dataDir, "-m", "immediate", "-w", "stop"]);
  rmSync(dataDir, { recursive: true, force: true });
  console.log("data directory removed");
} else {
  console.log(running() ? `running on ${port}` : "stopped");
}
