#!/usr/bin/env node
/**
 * Generates a NetworkRadar read-only MCP credential.
 *
 *   node generate-readonly-key.mjs <id> [expiresISO]
 *
 * Prints TWO things, once:
 *   1. the KEY: give it ONLY to the Company OS (NETWORKRADAR_MCP_API_KEY). Never commit it, never paste it into chat.
 *   2. the ENTRY: add it to NetworkRadar's MCP_READONLY_KEYS (it contains only the SHA-256 hash, not the key).
 *
 * Nothing is written to disk and nothing is sent anywhere.
 */
import { createHash, randomBytes } from "node:crypto";

const id = process.argv[2];
const expires = process.argv[3];
if (!id || !/^[a-z0-9_-]{1,32}$/.test(id)) {
  console.error("usage: node generate-readonly-key.mjs <id: [a-z0-9_-]{1,32}> [expiresISO e.g. 2027-05-01T00:00:00Z]");
  process.exit(2);
}
if (expires && Number.isNaN(new Date(expires).getTime())) {
  console.error("expiry is not a valid ISO date");
  process.exit(2);
}
const key = "nrro_" + randomBytes(32).toString("base64url"); // 43 url-safe chars = 256 bits
const hash = createHash("sha256").update(key).digest("hex");
console.log("KEY (store in the Company OS only):");
console.log(`  ${key}\n`);
console.log("ENTRY (add to NetworkRadar MCP_READONLY_KEYS, comma-separated with any existing entries):");
console.log(`  ${id}:${hash}${expires ? `:${expires}` : ""}`);
