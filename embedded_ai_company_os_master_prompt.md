# MASTER BUILD PROMPT — THEODOROS AI COMPANY OS

You are my principal software architect, staff full-stack engineer, AI systems engineer, product designer, DevOps engineer, and pragmatic technical co-founder. Your assignment is to **design and IMPLEMENT** a production-oriented AI Operating System for my actual business, beginning with an end-to-end working vertical slice and extending it through clear releases. This is not a request for slides, a static mockup, a figma-only design, or a collection of disconnected chatbot demos. Write working code, migrations, tests, documentation, and deployable services in the repository to which you have access.

## 0. Context and mission

I am Theodoros Ampas. I operate as an **Embedded AI Partner**. I enter existing business workflows, observe how work actually gets done, identify bottlenecks, design and implement useful AI/software improvements, help teams adopt them, and transfer ownership. My immediate business priorities are building credible proof of work, converting valuable conversations into paid pilots, delivering excellent projects, maintaining relationships, and publishing content that comes from real work.

Core loop:
`Observation -> Conversation -> Insight -> Research -> Work -> Proof -> Content -> Distribution -> Relationships -> Opportunities -> More Work`

Take inspiration from ReStructure AI's blueprints, especially their "137 AI Agents Run Your Entire Company", one-person social media team, one-person marketing team, AI sales system, CMO / ad studio, e-commerce and roofing office systems. Adapt the architecture, not their brand, copyrighted design assets, marketing claims, or exact visuals. Source material to inspect when web access is available:
- https://restructure-europe.vercel.app/el/newsletter/
- https://restructure-europe.vercel.app/el/newsletter/social/
- https://restructure-europe.vercel.app/el/newsletter/roof/
- https://restructure-europe.vercel.app/el/newsletter/system/
- https://restructure-europe.vercel.app/el/newsletter/sales/
- https://restructure-europe.vercel.app/el/newsletter/store/
- https://restructure-europe.vercel.app/el/newsletter/social-team/
- https://restructure-europe.vercel.app/el/newsletter/marketing-team/
- https://restructure-europe.vercel.app/el/newsletter/agent-company/
- https://restructure-europe.vercel.app/el/newsletter/ad-agency/

The attached diagrams (if available in this environment) are **architectural references** showing: signals; systems of record; owner input; agent permissions; knowledge; company brain; event/interrupt handling; specialist teams; analytics; and human handoffs. Preserve those concepts, but improve simplicity, verifiability, permission boundaries, execution safety, and business usefulness.

**Critical product goal:** A daily usable Command Center that knows the state of my relationships, sales opportunities, projects, content, calendar, and follow-ups; proposes a few high-leverage actions; carries out approved work using existing systems; measures outcomes; and learns from logged exceptions and corrections.

This must also be architected as a reusable **client deployment platform** so we can eventually instantiate industry-specific AI operating layers (e.g., hospitality/property management, B2B services, e-commerce, roofing) without hardcoding any one vertical. My personal operating system is the first tenant and the proving ground; NOT an unvalidated full SaaS launch.

## 1. Product philosophy / non-negotiables

1. Understand real workflows before automating; do not automate a process just because it can be automated.
2. Prefer deterministic software for execution, AI for judgment/interpretation, and human oversight for consequential actions.
3. A "department" or "agent" is a product capability, not necessarily a separate persistent process, model, prompt or billable agent. Do not create 137 fake agents. Implement a small number of real, composable agents + reusable skills + deterministic workflows.
4. Reuse existing tools and data stores; do NOT create a parallel CRM or replace NetworkRadar.
5. Show provenance: source system, record IDs, timestamps, citations, assumptions, uncertainty and approvals where relevant.
6. Never silently send emails, DMs, social posts, ads, payment actions, contract actions, customer replies or destructive mutations. Require explicit authorization by a configured approval policy. Safe idempotent background reads/synchronization can run automatically.
7. Do not fabricate metrics, success stories, revenue uplifts, client conversations, working integrations, or API connectivity. Mark synthetic demo data as DEMO.
8. Prefer minimum complexity and low recurring cost; no Kubernetes, microservice explosion or speculative tooling.
9. Build for debuggability, tests, migrations, versioning, audit trails and provider portability from day one.
10. The app must be genuinely useful without waiting for every connector to be installed.

## 2. Mandatory stack and hosting decisions

Use this stack by default, **subject to inspecting the actual repo and current official documentation first**:
- **Monorepo:** pnpm + Turborepo; strict TypeScript, Zod schemas, typed domain boundaries.
- **Web:** Next.js App Router + React + Tailwind CSS + shadcn/ui, Lucide, responsive and accessible.
- **Backend / APIs:** Next.js Route Handlers for interactive HTTP; typed server-side domain services; avoid long-lived background jobs inside a synchronous web request.
- **AI:** current Vercel AI SDK (verify exact installed version and current APIs), provider abstraction and configurable model routing across OpenAI/Anthropic/other providers; optional Vercel AI Gateway. Avoid hardcoded model IDs or undocumented API calls. Use source-version-compatible built-in agent abstractions before adding LangGraph. Add LangGraph only if a documented workflow truly needs graph-state complexity.
- **Database:** Supabase Postgres, Supabase Auth, Storage, pgvector, structured relational records plus hybrid full-text/vector search. Use proper SQL migrations and typed queries.
- **Background execution:** Trigger.dev as the *single* primary workflow engine in the first implementation. Durable tasks, retries, step checkpoints, schedules, queue limits and status tracking. Do not also introduce Temporal, Inngest, n8n, and Vercel Workflow unless there is an evidenced need.
- **Observability:** Langfuse for AI traces/evaluations, Sentry for errors, PostHog for product/website behavior; use adapters and graceful degradation when not configured.
- **Hosting:** Vercel for web/API, Supabase for relational data, managed Trigger.dev workers initially. Reserve Docker Compose/VPS for tasks that need persistent worker processes, browser automation or media processing. **No Kubernetes at this stage.**
- **Local inference:** optional local worker node with Ollama or an OpenAI-compatible MLX endpoint; private connectivity via Tailscale/WireGuard or equivalent authenticated tunnel. Do not expose the local inference port publicly.
- **Media:** FFmpeg + Remotion where deterministic video cutting/rendering is warranted. External provider adapters for ElevenLabs, HeyGen, Canva/other graphics, and Buffer/Metricool, only when access and documented APIs exist.
- **Development/testing:** ESLint, Prettier, Vitest, Playwright, typecheck, CI in GitHub Actions, health checks, environment templates and docs.

Check latest official docs for all dependencies before implementing specific APIs. Pin reviewed package versions in a lockfile. Choose EU region for data when possible and document data residency.

## 3. Repository architecture

Start as a **modular monolith**. Suggested layout (adapt to existing repo; do not destructively restructure a working project):

```
apps/
  command-center/           # Next.js web app and API
packages/
  core/                     # domain entities, IDs, schemas, errors, events
  database/                 # Supabase client, repositories, SQL migrations
  brain/                    # planner/router, context assembly, model policies
  agents/                   # specialist agent definitions / configs
  skills/                   # reusable versioned operational procedures
  tools/                    # typed tool registry, policy enforcement
  integrations/             # NetworkRadar, Gmail, Calendar, Drive, etc.
  knowledge/                # ingestion, chunking, retrieval, provenance
  workflows/                # Trigger.dev jobs and schedules
  media/                    # media interfaces / rendering contracts
  approvals/                # action requests, human sign-off, audit
  telemetry/                # traces, errors, cost, quality, analytics
  ui/                       # reusable presentation components
workers/
  media/                    # Dockerized FFmpeg/Remotion/Playwright when needed
  local-ai/                 # optional secure local worker and model adapter
infra/
  docker/                   # Dockerfiles, compose, sample configs
  ci/                       # test/build/deployment templates
supabase/
  migrations/
  tests/                    # database and RLS tests
  seed.sql                  # clearly labelled synthetic demo data only
docs/
  architecture.md
  data-model.md
  integrations.md
  agent-and-skill-registry.md
  security-and-approvals.md
  deployment.md
  operations-runbook.md
  roadmap.md
  decision-log.md
```

Use clean boundaries: integrations expose typed, authenticated capabilities; agents must not bypass the tool gateway to call arbitrary mutation APIs; workflows have IDs, statuses and audit records. Support adapters that can be swapped without rewriting domain logic.

## 4. Core architecture / event loop

Implement the following flow:

`External signals / scheduled checks / manual input -> ingest + dedupe -> normalized events -> context retrieval -> policy/priority router -> specialist skill or deterministic workflow -> tool calls -> validation + optional approval -> execution -> audit + measurement -> follow-up/learning.`

**Core components:**
- **Signals/Ingestion:** emails, contacts, replies, events, project activity, content signals, form submissions, social analytics, website activity, explicit user notes, file uploads. Only ingest available/authorized sources.
- **Systems of record:** NetworkRadar for relationship records where applicable; Google Calendar for calendar events; Drive for source files; GitHub for code; existing billing/CRM/client apps for their own data. Avoid two-way sync by default; define ownership per field.
- **Company Brain:** context builder, priority scorer, routing, task planner, decision log; must expose *why* it recommends something.
- **Knowledge layer:** personal brand/voice, ICP, offer, project SOPs, case studies, pricing constraints, channel rules, customer preferences where lawful, workflow exceptions, reusable learnings. Separate policy/rules from untrusted retrieved content.
- **Specialist capabilities:** sales, network, intelligence, projects, content, publishing, finance, customer, events, website, analytics.
- **Interrupts:** reply arrives, prospect signal, meeting tomorrow, missed follow-up, deadline at risk, post performs abnormally, negative comment, client escalation, agent error, cost threshold exceeded, bad data, security failure.
- **Human handoffs:** approvals, calls, relationship judgment, irreversible actions, client-sensitive decisions.
- **Observability:** cost, duration, success/failure, model/tool calls, run inputs/outputs (redacted), data provenance, outcome KPI.

Use a typed event envelope, e.g. `{id, workspaceId, source, externalId?, type, occurredAt, receivedAt, correlationId, payloadVersion, payload, dedupeKey}`. Define a real idempotency and replay mechanism. Avoid sync loops.

## 5. Departments and detailed capabilities

Create a registry containing these departments, their skills, readiness states, data requirements, permissions, test coverage, and workflow triggers. Build **real, integrated capabilities** in priority order; inaccessible connectors should show honest `not_connected` states rather than fake outputs.

### A. Chief of Staff / Company Brain
- Daily and weekly brief: top ONE critical action, 2–3 important actions, blockers, meetings, waiting-on replies, high-value follow-ups, project risks, most promising lead.
- Ask "What should I do today?" and retrieve live supported context; display evidence/links and allow one-click create task, prepare draft, approve workflow.
- Strategic signal/noise filtering; action classification: Act now / Schedule / Follow up / Monitor / Save idea / Ignore.
- Explain why actions were chosen, confidence, urgency, expected impact, and effort.
- Approval inbox, execution history, pending jobs, error alerts, budget overview.

### B. Network & Relationship Intelligence
- **NetworkRadar is the source of truth where available.** Discover real integration contract/SDK/MCP/API before calling it; never assume ChatGPT-connected tools are automatically accessible inside the deployed web app.
- Inbound replies -> contact match -> summarize thread -> extract needs -> next best action -> useful follow-up draft -> user approval -> send/log/schedule.
- Contact brief: person/company, relationship history, last contact, promised actions, previous interests, mutual context, next steps. Prevent irrelevant or creepy personalization.
- Relationship priority, meeting prep, event contacts, warm introductions, stalled discussions, contacts awaiting reply.

### C. Sales & Deals
- ICP/market mapping, prospect/company research, relevant business signals, prospect qualification, specific problem hypothesis, outreach concepts, meeting prep, meeting notes, pipeline, deal risk, proposals, paid pilot scopes, follow-up engine.
- Connect to real CRM/service if configured; avoid creating and syncing conflicting source records.
- Capture outcomes: conversations, qualified meetings, proposals, paid pilots, won/lost, revenue; reject vanity-only metrics.
- No autonomous bulk cold email, misleading personalization or unsolicited AI voice calls. Human review, opt-out, rate limits and compliance policies.

### D. Research & Market Intelligence
- Industry research, competitor/offer research, market signals, potential connectors, relevant events, client workflow investigation, document analysis.
- Every claim must carry a source URL/file reference and date or be marked as inference; freshness rules for current information.
- Generate concise research briefs and identify what to observe directly before automating anything.

### E. Projects & Delivery
- Project intake, workflow discovery, mapping existing processes, scoped solution proposal, milestones, tasks, blockers, deliverables, owner assignment, client updates (drafted), pilot measurement, postmortems, case-study evidence.
- Provide workflow maps showing current-state and future-state; baseline vs actual outcome; cost and quality tradeoffs; human control points.
- Integrate with GitHub, Drive, Calendar and existing project trackers where authorized.

### F. Content Studio / One-Person Social Media Team
Replicate the *functional coverage* of the social blueprint, not a shallow copy of its diagram:
- **Signals:** real customer questions, project discoveries, comments/DMs where available, videos, competitor content, search trends, website behavior, collaboration requests, creative tests.
- **System of record:** editorial calendar, ideas, raw footage, brand kit, scripts, media assets, publish history, performance, attribution to originating projects/conversations.
- **Owner inputs:** voice/tone rules, audience, goals, offer, video/raw material, approvals, preferred formats.
- **Knowledge:** `/voice`, `/offer`, `/audience`, `/content`, `/platforms`, `/hooks`, `/community`, `/reporting` as versioned knowledge documents/SOPs (managed in DB/files as appropriate).
- **Research:** trend scout, competitor monitor, question miner, audience research, keyword research, idea scoring, content planning.
- **Studio:** hook hypotheses, outline/script writer, caption variants, clip recommendations, subtitle rendering, thumbnail/graphics briefs, media upload, B-roll suggestions, translation/localization, brand/claim checking, optional voiceover/provider plugins.
- **Publish/community:** approval queues, scheduler, multi-platform repurposing, human-approved DM/comment draft responses, collaboration opportunity tracker, lead tagging.
- **Growth:** cross-post performance, retention, watch time, clicks, relevant conversations, inbound leads, meetings and attributable business value; learning loop; A/B tests where data permits.
- Prioritize material from **real work**. Do not publish filler just to hit posting frequency. Never claim automated content was reviewed/posted if it was not.

### G. Marketing, Ads & Conversion
- Audience/offer mapping, campaign plans, creative briefs, assets, landing page audits, tracked experiments, ads reporting, CRM conversion and attributed outcomes.
- Design campaign and budget planning separately from live spending. Require explicit approvals for ad creation/launch/budget changes.
- Avoid unverified claims such as "extra €20k/month" or "-€24k agency cost"; show actual measured values only.
- Ad platforms should be optional integrations, not hard dependencies.

### H. Customer & Service
- Customer context, knowledge-backed answer drafts, request triage, issue escalation, sentiment/urgency flags, service follow-up, meeting scheduling.
- Require customer-facing safeguards and evidence-backed answers; hand off rather than hallucinate.

### I. Operations & Back Office
- Contract/document intake, approval processes, invoice reminders, project deadlines, simple structured reporting, administrative task routing.
- Do not move money, modify accounting records or execute contracts without explicit approval.

### J. Finance
- Revenue/pipeline/cost dashboards and cashflow projections only from actual connected records; label estimates; AI workflow spend analytics; payment/invoice status when connected.
- Fine-grained permissions; no hidden writes to financial systems.

### K. Website, Analytics & Experiments
- GA4/PostHog monitoring, conversion flows, key pages, form performance, tracking errors, site health, controlled experiment history.
- Preserve baselines; do not auto-edit the live website during experiments unless explicitly authorized.

### L. Events & Opportunity Radar
- Relevant conferences, local business and startup events, registration/deadline tracking, pre-event targets, strong operational questions, post-event follow-ups, relationship outcomes.
- Prioritize serious operators/potential buyers/connectors over broad attendance counts.

### M. Knowledge & Agent Improvement
- Ingest approved files/transcripts/SOPs, classify knowledge, chunk and cite accurately, version policies and skills, collect corrections and exception cases.
- Keep an evaluation dataset for important skills. Never allow an agent to rewrite its own live skill instructions or safety policies silently: propose changes, run evals, require review, then version/promote.

### N. Reusable Client Blueprints (not a separate fake SaaS)
- Build a declarative `Blueprint` registry: industry, source systems, entities, signals, rules, skills, permissions, KPIs, handoffs, allowed automations, required connector scopes, data isolation.
- Provide example **templates**, clearly marked as unconfigured: hospitality/property management, roofing office, e-commerce store, B2B sales team and professional services. Do not pretend these can run without client-specific workflow discovery and connections.
- Keep personal/company workspace and client data strictly isolated.

## 6. Database and data ownership

Propose and implement migrations for a **minimal but coherent** normalized schema. Candidate entities (adjust/merge rather than blindly creating 50 empty tables):
- tenants/workspaces, users, memberships, roles, permissions, integration_connections, external_record_links, sync_checkpoints
- companies, contacts_ref, conversations_ref, opportunities, deals_ref, meeting_briefs, relationship_actions
- projects, workflows_discovered, tasks, milestones, deliverables, evidence, case_studies
- source_events, signals, inbox_items, business_goals, decisions, action_recommendations
- agent_definitions, skill_definitions, skill_versions, workflow_definitions, workflow_runs, workflow_steps, tool_calls, job_queue_refs
- approvals, approval_decisions, action_execution_receipts, audit_log, errors
- knowledge_sources, knowledge_chunks, embeddings, knowledge_policies, citations, exceptions, evaluations, eval_cases
- content_ideas, content_briefs, scripts, media_assets, editorial_calendar, publications, content_metrics, distribution_actions
- campaigns, experiments, campaign_metrics, cost_events, KPI_snapshots
- blueprints, blueprint_instances, model_policies, local_worker_nodes, worker_heartbeats

For cross-system records use external IDs and source references; do not mirror full private CRM contents without purpose. Store secrets in environment/secret manager, not plain text DB columns or logs. Implement workspace isolation and RLS on every exposed table; write allow/deny RLS tests for two workspaces. Ensure server-side policies check action scopes as well as authentication. Do not use user-editable metadata for authorization, and do not expose elevated Supabase credentials in frontend bundles.

## 7. Tools, approvals and reliability

All mutating operations MUST pass a typed tool gateway. Define metadata for each tool:
`toolId, description, connector, requiredScopes, riskTier, idempotency, rateLimit, approvalPolicy, inputSchema, outputSchema, timeout, retryPolicy, auditFields`.

Risk tiers:
- `read`: low-risk, allowed per connector scopes and workspace policy.
- `draft`: generates proposals/drafts without delivery; allowed and visible to user.
- `write_low`: reversible state changes; configurable approval.
- `external_communication`: email/DM/post/customer reply; explicit approval by default.
- `financial_or_irreversible`: payments, ads budget, contracts, deletion, external client mutations; strong approval and often second confirmation.

Approval lifecycle: `proposed -> awaiting_approval -> approved/rejected/expired -> executing -> succeeded/failed` with receipts and actor identity. Execution must revalidate authorization and original payload hash; approval never blindly approves a mutated payload. Add deduplication, bounded retries, exponential backoff, dead-letter reporting, run cancellation, recovery, and cost guards.

Prompt-injection defense: external email, websites, documents, comments, and retrieved text are untrusted data, not developer instructions. Never allow retrieved content to authorize tool usage or exfiltrate secrets.

## 8. Local Studio + cloud routing

Support execution targets `cloud`, `local`, `hybrid`, with a separate **data policy** independent of model routing:
- `cloud_allowed`: task may use approved hosted providers.
- `redact_then_cloud`: local processing first, verify permitted summary/redaction before cloud.
- `local_only`: must never fall back to cloud if local node is unavailable.

Build an optional local-worker prototype with:
- secure pairing/registration, signed job requests, workspace-scoped policy, heartbeat/health/capability reporting
- Ollama / compatible inference API, configurable model IDs and available-memory checks
- transcription/media processing interfaces, storage transfer with time-limited authorization, queue polling or secure push transport
- metrics, cost estimates and honest offline/unavailable states
- Docker Compose for portable non-Apple workers; native MLX where required on Apple Silicon
- NO need to own expensive hardware to run the first release

The cloud Command Center remains usable without local hardware. No public open Ollama endpoint. No silent failover of restricted data.

## 9. User experience / interface

Design a professional, information-dense but calm Command Center. Do NOT copy ReStructure branding or their precise UI. Prioritize readable content, powerful actions and clarity.

Sidebar routes (implement according to release readiness, not fake complete functionality):
- `/overview` — real daily brief, goals, KPIs, blockers, upcoming meetings, priority queue
- `/inbox` — signals, replies, exceptions, triage
- `/approvals` — view/approve/reject proposed actions with payload diffs and source context
- `/network` — contacts and relevant relationship actions via NetworkRadar adapter
- `/sales` — pipeline, proposals, lead research and follow-up activities
- `/research` — research brief workflows, findings, source links
- `/projects` — workflow discovery, project status, evidence and deliverables
- `/content` — ideas, briefs, calendar, media, publishing, performance
- `/marketing` — campaigns/ads/plans, optional integrations
- `/analytics` — business outcomes and technical/agent cost metrics
- `/knowledge` — sources, SOPs, policies, retrieval debug
- `/agents` — registry, capabilities, availability, runs, costs, evals, version history
- `/automations` — workflow definitions, schedule controls, queue/errors
- `/events` — event opportunities and prep
- `/finance` — finance data read-only unless explicitly connected
- `/settings` — workspace, roles, connectors, policies, model routing and local nodes

Components: global search, command palette, chat/command bar with contextual actions, reusable drawers, status badges, actionable tables, provenance panels, job progress, mobile responsiveness, good empty/error/loading states, keyboard accessibility. Show "Needs connection" on inaccessible connectors and "Demo" on all seeded examples. Do NOT turn every AI output into a chat window; render structured recommendations, approvals, drafts, workflow diagrams and business metrics appropriately.

## 10. Integrations (discover, never invent)

Priority integration adapters:
1. **NetworkRadar2**: relationship records, contacts, conversations, follow-ups and tasks; inspect real available integration mechanism, auth model, and endpoints. Existing ChatGPT plugin access does NOT imply the Next.js application can call it directly. If integration cannot be established, implement typed contract, mock for tests, clear connection UI and manual import/export bridge.
2. Gmail: search/read threads, create drafts, send only with approval, associate external thread IDs, avoid duplicated sends.
3. Google Calendar: read events, find availability, create/update invitations only with approval.
4. Google Drive: documents, transcripts, approved ingestion.
5. GitHub: repo metadata, issues/PRs, project state and proof links.
6. Website analytics: PostHog and GA4.
7. Social publishing/analytics: Buffer or Metricool as the primary adapter; optional platform-native APIs when terms and scopes permit.
8. Media: ElevenLabs/HeyGen/Canva optional; fallback to manual upload/export paths.
9. Client business systems: plug-in adapters via typed HTTP/API/MCP contracts.

Use OAuth safely, minimal scopes, token encryption, refresh-token handling, revocation, connector status and sync cursors. Respect provider policies. Do not scrape authenticated sites or impersonate users through browser automation in violation of authorization or terms.

## 11. Four end-to-end workflows that MUST work

### Workflow W1: Reply -> valuable follow-up -> approval -> log
Signal from a connected inbox or manually pasted conversation -> identify person and authoritative NetworkRadar record -> retrieve prior context -> classify intent and problem -> research if useful -> suggest 1–3 actions -> draft a useful, specific reply -> require approval -> create Gmail draft or authorized send -> log action and follow-up -> measure whether a meeting/project resulted. If no connector, allow manual text ingest and export a draft while marking the external write unavailable.

### Workflow W2: Workflow discovery -> pilot -> proof
Observe/record current business process -> identify friction and exceptions -> map as-is workflow -> propose to-be improvements and non-AI alternatives -> generate tightly scoped pilot -> estimate baseline -> create tasks and milestones -> capture results and failures -> generate a source-backed case-study draft requiring approval.

### Workflow W3: Work -> content -> distribution -> learning
Choose a real project observation (with confidential data redacted) -> derive audience and point of view -> propose hooks and formats -> draft outline/script -> upload raw footage or edit media where tools exist -> review/approve -> schedule/publish if connected and explicitly approved -> collect metrics -> measure real engagement/conversations/leads -> store learning. Never fabricate footage, reach or engagement.

### Workflow W4: Morning Chief of Staff brief
On-demand and scheduled -> inspect actual tasks, project deadlines, replies, calendar, opportunities, content and workflow failures -> dedupe and rank -> output 1 critical action, up to 3 important actions, optional waiting/monitor items, each with provenance and next-step action; no generic motivation.

Also implement concise reference flows for an event research/handoff, local-only document processing, and an approval timeout/recovery case when building subsequent releases.

## 12. Testing, quality and security gates

Create unit, integration and E2E tests that cover:
- multi-tenant data isolation, RLS, RBAC and tool-level scopes
- impossible to execute email/post/financial action before approval; payload cannot change after approval
- retry/idempotency for sending actions, sync deduplication and correct external IDs
- prompt injection in untrusted email/web page/knowledge snippet does not change agent authority
- job timeout, retry, failure recording, cancellation and operator replay
- local_only policy fails closed when local node offline
- source citations and stale-data warnings
- no connected tool -> honest unavailable/needs-connection UI, no fake statuses
- end-to-end W1 and W4 with deterministic fixtures and at least one real API smoke test when credentials are accessible
- responsive UI and accessible navigation
- cost tracking and budget stop conditions

Use fixtures with clear synthetic labels. Create an evaluation set for priority judgment tasks: signal triage, reply quality, factual grounding and opportunity scoring. Add a quality feedback mechanism and regression tests for corrections. Ensure errors don't silently disappear.

Security: EU/GDPR-conscious handling, data minimization, per-tenant secrets, RLS and grants, no overly broad `service_role` access in user-facing routes, safe storage of PII, audit trails, least privilege, documented retention/deletion, privacy boundaries for customer data, rate limits, signed webhooks and secret redaction.

## 13. Delivery plan and REQUIRED execution behavior

You must build incrementally, but the **target architecture and full department registry** should be documented up front.

**Step 0 — Inspect:** examine repository, package manager, existing components, installed packages, database and deployment settings; do not assume a blank repo. If empty, initialize the stack. Inspect official docs for current versions. Inspect any existing NetworkRadar or project integrations; never modify unrelated running projects or production resources without authorization.

**Step 1 — Architecture + acceptance criteria:** write architecture.md, data-model.md, decision-log.md, connector matrix (real/available/needs auth/not available), security/approval model, feature registry and a release plan. Create concrete testable acceptance criteria, not generic to-dos. Keep design simple.

**Release R1 — Working foundation:** implement auth, workspace, migrations, RLS and tests, application shell, overview, agent/skill registry, typed tool gateway, approvals, structured inbox, local demo data only for unconnected sources, background job state, observability hooks, model routing, a working on-demand Chief of Staff brief and a usable W1 manual-input-to-approval-to-export flow. Run all tests and document commands/results.

**Release R2 — Revenue engine:** real integrations to the extent supported/authorized; relationship context, meeting prep, signal triage, sales deal lifecycle, opportunity research, proposal/pilot creation, follow-up scheduling, W1 with actual connector if available, W2 working end to end.

**Release R3 — Content engine:** content knowledge, idea bank, editorial calendar, script drafting, asset pipeline, approval, publish adapter, metrics ingest, complete W3. Add Docker media worker only when a real processing task requires it.

**Release R4 — Company breadth and client templates:** projects, operations, finance read-only reports, website experiments, events, marketing campaign workflows, service handoffs, learning/evaluation loop, reusable blueprints with isolated client workspaces and local-worker prototype.

Do not pretend R2–R4 are finished if only navigation tabs exist. Implement in a sensible order and leave each release with runnable tested functionality. Avoid creating all departments as empty pages merely to satisfy visual coverage.

### Completion / reporting contract
After each release, report:
1. What code and migrations were created/changed (paths)
2. What **actually works now** vs partially built vs blocked/needs credentials
3. Commands executed and tests run, with real pass/fail results
4. Security gates and approval behavior verified
5. How to run it locally and deploy to Vercel/Supabase/Trigger.dev
6. Current environment variables required (names only, NEVER values)
7. One concrete next milestone and existing limitations

If you have code execution, **start editing and testing the repository immediately**. Do not stop at architecture diagrams, a giant implementation plan, or a vague scaffold. If there is no repo/workspace attached or deployment credentials are absent, generate a complete initialized local codebase where possible, provide setup instructions, and accurately describe any external steps that require authentication.

Prefer preserving existing work over replacement. Do not purchase hardware, register domains, send email, publish content, spend money, mutate external client systems, or deploy to production without an explicitly authorized action.

### Final acceptance test
I should be able to open the Command Center, authenticate, view actual or clearly marked demo sources, submit a real conversation or event into the Inbox, see the Brain propose a reasoned next action with provenance, produce a useful draft, approve/reject it, inspect the execution/audit record, and see a follow-up task. Separately, I should be able to get a grounded daily priority brief. The architecture must leave a clean route to the complete sales/content/marketing/company/local hybrid ecosystem.

**Begin now with Step 0 and Step 1, and then implement R1 in code. Continue through later releases if the environment and time allow, always reporting actual status rather than claiming more was built than exists.**
