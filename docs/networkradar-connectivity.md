# NetworkRadar connectivity discovery (R1.5, Phase 4)

**Status: adapter implemented and proven against a local mock MCP server. Live connection is BLOCKED on one credential. Nothing was sent to, or read from, the live NetworkRadar data.**

## What was inspected

- Source: `../netwrokradar` (git `82e00ce`), read-only. Files: `mcp/README.md`, `src/app/mcp/route.ts`, `src/lib/mcp/{http,auth,server}.ts`, `src/lib/mcp/tools/core.ts`, `src/server/validators/index.ts`.
- Live: one unauthenticated `POST https://netwrokradar.vercel.app/mcp` and one `GET .../.well-known/oauth-protected-resource/mcp` on 2026-11-07. No credential was used.

## Answers

| # | Question | Finding | Evidence |
|---|---|---|---|
| 1 | Remotely accessible MCP endpoint? | **Yes**: `https://netwrokradar.vercel.app/mcp` is deployed and answering. | Live probe returned `401` with `WWW-Authenticate: Bearer resource_metadata=".../oauth-protected-resource/mcp"` (verified this session). |
| 2 | Transport | **Stateless Streamable HTTP** (`WebStandardStreamableHTTPServerTransport`, `sessionIdGenerator: undefined`; a new server per request). GET/POST/DELETE/OPTIONS. | `src/lib/mcp/http.ts` |
| 3 | Authentication | Two modes: (a) **Clerk OAuth** for interactive clients (resource metadata + authorization server `merry-dogfish-933.clerk.accounts.dev`, which is a Clerk *development* instance); (b) **`Authorization: Bearer <MCP_API_KEY>`**, which maps to one fixed owner (`MCP_OWNER_ID`). In non-production with no key set a "dev" fallback exists; production refuses. | `src/lib/mcp/auth.ts`, live metadata |
| 4 | Server-to-server access | **Yes, through the API key.** OAuth needs a user sign-in and is not suitable for a backend. Whether Clerk offers a machine-to-machine OAuth client for this resource is **not verified**. | `auth.ts` |
| 5 | Tools the Company OS should use | Read-only: `search_people`, `get_person`, `get_relationship_brief`, `list_actions`, `get_network_summary`. Each is registered with `annotations: { readOnlyHint: true }`. | `tools/core.ts` |
| 6 | Official API instead of MCP? | The repo has REST route groups under `src/app/api/` (`conversations`, `cron`, `execution`, `reference`, `search`, `social`); I did **not** inspect their auth or stability. The MCP server is the only documented machine-facing contract today, so the adapter uses it. A purpose-built read-only REST API would be a better long-term contract. | directory listing only |
| 7 | Read-only scoping | **Not supported server-side.** One API key reaches *every* tool on the server, including write and send tools (e.g. `send_email`, `set_relationship_objective`, `create_person`). | `auth.ts` has a single key; `server.ts` registers all tools |

## What the adapter does about #7

`packages/integrations/src/networkradar.ts` enforces read-only on the *client* side, twice:

1. A fixed allow-list of the five tool names. Any other name is refused **before any network request** (`forbidden_tool`).
2. At call time it lists the server's tools and refuses unless the server itself marks that tool `readOnlyHint: true` (`not_read_only`). If NetworkRadar ever changes a read tool into a writer or drops the annotation, the call is refused and health goes `blocked`.

It also: requires `https` (the key is a bearer credential), applies timeouts, maps 401/403 to `unauthorized`, validates every result with Zod, and returns each result with `{system, tool, retrievedAt, recordIds}` so canonical NetworkRadar ids are preserved.

**Contact verification rule:** `lookupContact` returns `verified` only when a canonical record's email equals the sender's email exactly (case-insensitive). A name-only hit is a `candidate` and is shown as **Unverified**; no fact about the sender is asserted from it. The `search_people` filter is documented as matching "name, title or organisation", so the adapter searches by name (or the email local-part) and then confirms by email through `get_person`.

## What is proven, and what is not

| Claim | Status |
|---|---|
| The adapter works over real HTTP + the real MCP SDK against a server that mimics NetworkRadar's documented behaviour (Bearer auth, stateless transport, read tools with `readOnlyHint`, write tools on the same server) | **Proven** (`networkradar.test.ts`, 10 tests) |
| Write tools cannot be called through the adapter | **Proven** against the mock, including the case where the mock server would allow them |
| The tool names, argument shapes and result shapes match the live deployment | **Taken from the source code, not verified live** |
| The live deployment accepts our credential and returns data | **Not tested: no credential** |
| `get_person` returns `email` | From source (`email: person.email`); not verified live |

## The exact blocker and the next action

**Blocker:** a credential for the live endpoint. `MCP_API_KEY` is a secret held in NetworkRadar's Vercel project environment. I did not read or fetch it (not authorised, and it would be an unrelated secret).

**To unblock, in this order:**

1. **Recommended first (change in the NetworkRadar repo, not made here):** add a second key, e.g. `MCP_READONLY_API_KEY`, that `resolveMcpAuth` maps to the *same owner* but limits `createNetworkRadarMcpServer` to tools annotated `readOnlyHint`. Then a leak or bug in the Company OS cannot send email or edit relationships. This is the only way to get server-side enforcement.
2. Generate a long random value for that key (or, if you accept the risk in the meantime, reuse `MCP_API_KEY`) and set, **in the Company OS environment only** (Vercel env, never in git):
   - `NETWORKRADAR_MCP_URL=https://netwrokradar.vercel.app/mcp`
   - `NETWORKRADAR_MCP_API_KEY=<the key>`
3. Run the opt-in live smoke (read-only, counts only):  
   `AAF_SMOKE_NETWORKRADAR=1 NETWORKRADAR_MCP_URL=... NETWORKRADAR_MCP_API_KEY=... pnpm --filter @aaf/integrations test`
4. Open Settings in the app: the `networkradar` connector flips to *connected* only after the adapter's health check proves all five tools exist and are read-only. Until then it shows *Needs connection* with the exact reason.

**Risk to decide before step 2 if you skip step 1:** the shared key is full-control over your NetworkRadar owner account. Client-side enforcement protects against our own bugs, not against a leaked key.

## Other notes

- The Clerk instance behind OAuth is a development instance (`*.clerk.accounts.dev`). Move NetworkRadar to a Clerk production instance before relying on OAuth anywhere.
- The adapter opens one short-lived MCP session per operation (the server is stateless). The 5-minute health cache bounds extra traffic.
