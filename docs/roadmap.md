# Roadmap

| Release | Scope | State |
|---|---|---|
| R1 | Foundation: schema + RLS, tool gateway, approvals, inbox, W1 (manual input), W4 (brief), registry, UI shell, cost guard | **Built and tested** (see README for results) |
| R2 | NetworkRadar adapter (after verifying a real contract), Gmail drafts/read, Calendar read, Supabase Auth + RLS-enforced reads, Trigger.dev scheduled brief, sales lifecycle, W2 | Not started |
| R3 | Content engine, W3, Metricool/Buffer adapter, media worker only if needed | Not started |
| R4 | Projects/ops/finance read-only, website experiments, events, marketing, evals loop, blueprints instantiation, local worker | Not started |

Next concrete milestone (R2-1): establish how the deployed app can reach NetworkRadar (API/MCP over HTTP with its own credentials), implement `networkradar.lookup_contact`, and make the Inbox show the verified record.

Known R1 limitations: single user; no login rate limit; server uses the owner DB role (RLS tested but not the enforcement path in the app); keyword classifier; LLM path untested against a real provider; no scheduled jobs; no Docker/CI deploy verified; Vercel deployment not attempted (PGlite on serverless needs Supabase first).
