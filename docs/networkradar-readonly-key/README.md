# NetworkRadar: server-enforced read-only MCP credential

**Status: patch written and tested in a scratch clone. NOT applied to the NetworkRadar repository and NOT deployed** (not authorised).
`../netwrokradar` was only read; its working tree (which has your uncommitted LinkedIn changes) was not modified. `git apply --check` against it succeeds.

## Why

The shared `MCP_API_KEY` reaches every tool, including `send_email`. The Company OS must not hold it. This patch adds a second, separate credential that the **server** limits to five read tools.

## What the patch does (7 files, +509/-5, `0001-readonly-mcp-credential.patch`)

| Requirement | How |
|---|---|
| Separate credential | New key type with prefix `nrro_`, independent of `MCP_API_KEY` and Clerk. Only `nrro_` tokens are even considered, so existing clients cannot be affected. |
| Explicit read-only scope | The auth result gains `scope: "full" \| "read"`. Every existing path (OAuth, `MCP_API_KEY`, dev) stays `full`. |
| Strict server-side allowlist, no wildcard | `READ_ONLY_TOOL_ALLOWLIST` = `search_people, get_person, get_relationship_brief, list_actions, get_network_summary` (exact names). |
| Reject mutating tools before execution | Three independent layers: (1) the HTTP layer parses the JSON-RPC body and refuses any `tools/call` outside the allowlist (403) **before a server or handler is created**; batches are refused as a whole; (2) the read-scope server registers only allowlisted tools, so others do not exist (not listed, SDK answers "not found"); (3) an allowlisted tool must also carry `readOnlyHint: true` or the server **fails to build** (fails closed). Resources, prompts, GET streams and DELETE are refused too. |
| No access to `send_email` etc. | Covered by tests that assert `send_email`, `send_approved_smtp_email`, `create_person`, `set_relationship_objective`, `approve_chief_reply`, `create_gmail_draft`, `social_publish`, `forget_about_person` exist on the full surface and are absent from the read surface. |
| Secure server-side storage | Only the **SHA-256 hash** is configured (`MCP_READONLY_KEYS`); the key never exists in NetworkRadar's environment. Constant-time comparison against every entry. 256-bit random keys. |
| Rotation | Several entries may be valid at once: add the new entry, move clients, delete the old one. |
| Revocation | Delete the entry, or list its id in `MCP_READONLY_REVOKED`; effective on the next request. Optional per-entry expiry. |
| Audit of denied attempts | One structured JSON line per denial (`mcp.denied`): reason, key **id** (never the key), tool/method name (never arguments), IP. |
| Minimal change to the authorization layer | New: `scopes.ts`, `read-only.ts`, `audit.ts`. Edited: `auth.ts` (+1 resolver, scope field), `http.ts` (gate before the server exists), `server.ts` (scope parameter). |

## Evidence (in a scratch clone of `HEAD` 82e00ce)

- New tests `tests/mcp-readonly.test.ts`: **21 pass** (parsing, hashing, rotation, revocation, expiry, malformed entries, auth paths, tool surface, request gate, batch smuggling, and real MCP requests through `handleMcpHttpRequest`).
- NetworkRadar's full suite with the patch: **81 files, 1641 tests pass.**
- Cross-repo test (`companion.test.ts.txt`): the Company OS adapter against the **real patched handler** over real HTTP: a read-only key sees exactly 5 tools; the legacy full key sees 40+; `send_email` with the read-only key returns 403; the adapter refuses the full key. 5/5 pass.
- Not done: no database-backed tool was executed (no DB), no deployment, no run against `netwrokradar.vercel.app`.

## To apply (you run these; nothing here deploys)

```bash
cd ../netwrokradar
git apply --check ../ampassador-factory/docs/networkradar-readonly-key/0001-readonly-mcp-credential.patch
git checkout -b feat/mcp-readonly-key
git apply ../ampassador-factory/docs/networkradar-readonly-key/0001-readonly-mcp-credential.patch
npx vitest run tests/mcp-readonly.test.ts tests/mcp-tools.test.ts
```

Then generate a key and configure it:

```bash
node ../ampassador-factory/docs/networkradar-readonly-key/generate-readonly-key.mjs company-os 2027-05-01T00:00:00Z
```

- Put the printed **ENTRY** in NetworkRadar's Vercel env as `MCP_READONLY_KEYS` (Sensitive). It contains only a hash.
- Put the printed **KEY** in the Company OS Vercel env as `NETWORKRADAR_MCP_API_KEY` (Sensitive) and `NETWORKRADAR_MCP_URL=https://netwrokradar.vercel.app/mcp`. Never commit or paste it.
- Deploy NetworkRadar **only when you decide to**. Existing OAuth and `MCP_API_KEY` clients keep working unchanged.

## Verify live (opt-in, read-only, counts only)

```bash
AAF_SMOKE_NETWORKRADAR=1 NETWORKRADAR_MCP_URL=... NETWORKRADAR_MCP_API_KEY=nrro_... pnpm --filter @aaf/integrations test
```

It checks the credential is accepted, the tool list is exactly the five read tools, and reads `get_network_summary` (aggregate counts). It never calls a mutating tool and never prints a person record.

## Company OS side (already implemented)

- The adapter refuses any key not starting `nrro_` (so the full key cannot be configured by mistake).
- On **every** call it also checks the server's actual tool list: if any tool is not `readOnlyHint`, it refuses (`credential_too_broad`) before executing anything.
- Contact verification stays exact-email only, canonical ids preserved, unverified candidates labelled.

## Limitations

- Denials are logged to stdout (Vercel function logs). If they must outlive log retention, replace the sink in `audit.ts` with a database writer.
- One read-only credential maps to the single `MCP_OWNER_ID`, like `MCP_API_KEY` does; per-user machine credentials would need more design.
- The key list lives in an environment variable; changing it needs an env update (and, on Vercel, a redeploy of the project to take effect). `MCP_READONLY_REVOKED` has the same property.
- OAuth access is unchanged and remains `full`.
