# Security and approvals

## Risk tiers (`@aaf/core`)

`read`, `draft`, `write_low`, `external_communication`, `financial_or_irreversible`.

- The **tier is authoritative**. `external_communication` and `financial_or_irreversible` always queue an approval, even if a tool wrongly declares `approvalPolicy: "never"` (tested).
- `financial_or_irreversible` also needs a second confirmation: the approver must echo the payload hash.

## Approval lifecycle

`awaiting_approval -> approved | rejected | expired -> executing -> succeeded | failed`  
(`proposed` exists in the schema for future two-step proposals; R1 creates approvals directly as `awaiting_approval`.)

- Transitions are compare-and-set in SQL, so two concurrent executions cannot both run.
- Only `owner`/`admin` can decide. An agent actor cannot (tested).
- Execution revalidates: payload hash, expiry, tool schema, connector status and scopes.
- A DB trigger forbids changing `payload`, `payload_hash`, `tool_id` or `workspace_id` after insert.
- Failed approvals are the dead-letter queue; `replay` is owner/admin only and reuses the approval id as idempotency key.
- Every decision, execution, tamper detection and denial is recorded (`audit_log` is append-only by trigger; `tool_calls` logs every invocation including denials).

## Untrusted content

Inbound messages are data. The classifier only returns data. The recipient of a reply is the sender header, never text from the body. LLM drafts are fenced, and rejected if they introduce a new email address or URL, placeholders, or are overlong (then the template is used). Message text is rendered as plain text in the UI.

## Data policy and model routing

Per workspace: `cloud_allowed`, `redact_then_cloud`, `local_only`. `local_only` fails closed (no provider -> error, no cloud call). Monthly EUR budget is checked before every model call. Redaction is regex masking of emails and phone numbers only: it is a minimum, not a privacy guarantee.

## Isolation

RLS is enabled on every workspace table, scoped via `memberships`. Tested with two workspaces and viewer/non-member roles (`rls.test.ts`). **Important limitation:** the R1 server connects as the database owner (PGlite locally; it would be the service role on Supabase), which bypasses RLS. Isolation in the running app therefore rests on the `Store` methods all taking `workspaceId`, with RLS as the second layer for any user-scoped client. Moving user-facing reads to RLS-enforced Supabase clients is an R2 task.

## Auth

R1 is single-user: password (`AAF_ADMIN_PASSWORD`) with an HMAC-signed, expiring, httpOnly cookie. With no password: closed in production, open and bannered in development. Supabase Auth is **not** wired into the app yet; the schema is ready for it. No login rate limiting yet (known gap).

## Secrets

Environment only; `.env.example` lists names. Nothing is stored in DB columns. Audit entries keep `to`/`subject` and hashes, not bodies.
