# Architecture

Status: R1 implemented. R2-R4 planned. See `roadmap.md`.

## Flow

```
manual input / (future) connectors
  -> makeEvent (typed envelope, dedupeKey)  -> source_events (unique per workspace+dedupeKey)
  -> inbox_items
  -> Brain: classify (ordered rule table) -> score -> recommendation (why + provenance)
  -> draft (template, or LLM via ModelRouter, output validated)
  -> ToolGateway.invoke  -> denied | executed (read/draft/low-write) | queued_for_approval
  -> human decision (owner/admin only) -> ToolGateway.execute
        (re-hash payload, re-check expiry/scopes/schema, bounded retry, receipt per attempt)
  -> audit_log (append-only) + follow-up task
```

## Packages

| Package | Responsibility | Tests |
|---|---|---|
| `@aaf/core` | ids, stable hashing, event envelope, risk tiers, errors | `core.test.ts` |
| `@aaf/database` | SQL migrations (`supabase/migrations`), PGlite runtime (same SQL as Supabase), `Store` | `rls.test.ts` |
| `@aaf/tools` | tool gateway + approval lifecycle, builtin tools | `gateway.test.ts` |
| `@aaf/brain` | classifier, scoring, drafts, model router, W1 and W4 workflows, eval set | `brain.test.ts` |
| `@aaf/registry` | departments A-N, agents, skills, blueprints (readiness is tested) | `registry.test.ts` |
| `apps/command-center` | Next.js UI, server actions, session auth | `token.test.ts`, Playwright `e2e/flow.spec.ts` |

Spec packages not created yet because there is nothing real to put in them: `knowledge`, `integrations`, `workflows` (Trigger.dev), `media`, `approvals` (lives in `tools`), `telemetry`, `ui`, `workers/*`. See `decision-log.md`.

## Connector matrix (verified in this repo, not assumed)

| Connector | State | Detail |
|---|---|---|
| NetworkRadar | Not connected | An MCP server exists in the author's Claude environment, but no API contract reachable from the deployed web app has been verified. Tool `networkradar.lookup_contact` is registered and gated; the UI says "Needs connection". R2: establish the real integration mechanism, else typed contract + manual bridge. |
| Gmail | Not connected | `gmail.create_draft` / `gmail.send` registered, adapters not built. W1 falls back to `email.export_reply_draft` (approved text exported as .eml, never claimed as sent). |
| Google Calendar | Not connected | Not built. Brief says meetings are not shown. |
| GitHub, PostHog, Metricool/Buffer, Drive | Not built | Planned R2-R4. |
| LLM | Optional | Any OpenAI-compatible endpoint via `AAF_LLM_*`. Unit-tested against a fake `fetch`; **not smoke-tested against a real provider**. Without it, drafts are deterministic templates. |

## Acceptance criteria (R1) and where each is proven

1. Unconfigured production refuses sign-in; wrong password rejected; routes need a session. (`e2e` test 1, `token.test.ts`)
2. A pasted message becomes an inbox item with an intent, class, score, reasons and provenance. (`brain.test.ts` W1, `e2e` test 2)
3. NetworkRadar absence is stated on the recommendation, never faked. (`brain.test.ts`, `e2e`)
4. Replying produces an approval; nothing executes before a human decision, and a rejected/expired/unapproved item cannot execute. (`gateway.test.ts`)
5. The approved payload cannot change (DB trigger + execution-time hash check). (`gateway.test.ts`)
6. Retries are bounded with backoff, each attempt has a receipt, exhausted retries dead-letter, operator replay does not double-send. (`gateway.test.ts`)
7. Duplicate paste creates no second event/item/approval. (`rls.test.ts`, `brain.test.ts`)
8. Prompt-injection text cannot change recipient, tools or approval state. (`brain.test.ts`, `e2e` test 3)
9. `local_only` never reaches a cloud provider; budget stops model calls; `redact_then_cloud` masks identifiers. (`brain.test.ts`)
10. Two workspaces are isolated by RLS; viewers cannot write or approve; audit log is append-only. (`rls.test.ts`)
11. The daily brief ranks only stored items, gives provenance and stale warnings, and says so when empty. (`brain.test.ts`, `e2e`)
12. Skills/departments cannot be marked live without existing tests. (`registry.test.ts`)
