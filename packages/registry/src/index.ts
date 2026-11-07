import { z } from "zod";

export const Readiness = z.enum(["live", "partial", "planned"]);
export type Readiness = z.infer<typeof Readiness>;
export const Release = z.enum(["R1", "R2", "R3", "R4"]);

export const SkillDef = z.object({
  id: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  departmentId: z.string(),
  readiness: Readiness,
  summary: z.string(),
  toolIds: z.array(z.string()),
  /** Connectors this skill needs to be fully effective; absence degrades it honestly, it does not disable it. */
  optionalConnectors: z.array(z.string()),
  /** Test files that prove a "live" skill. Required when readiness is live. */
  testedBy: z.array(z.string()),
});
export type SkillDef = z.infer<typeof SkillDef>;

export const DepartmentDef = z.object({
  id: z.string(),
  letter: z.string(),
  name: z.string(),
  release: Release,
  readiness: Readiness,
  scope: z.string(),
  dataRequirements: z.array(z.string()),
});
export type DepartmentDef = z.infer<typeof DepartmentDef>;

export const AgentDef = z.object({
  id: z.string(),
  name: z.string(),
  departmentIds: z.array(z.string()),
  skillIds: z.array(z.string()),
  /** Tools an agent may request through the gateway. Mutation still passes policy + approval. */
  allowedToolIds: z.array(z.string()),
  readiness: Readiness,
  description: z.string(),
});
export type AgentDef = z.infer<typeof AgentDef>;

export const DEPARTMENTS: DepartmentDef[] = [
  { id: "chief_of_staff", letter: "A", name: "Chief of Staff / Company Brain", release: "R1", readiness: "live", scope: "Daily brief, prioritisation, approvals, history, budget", dataRequirements: ["inbox", "tasks", "approvals"] },
  { id: "network", letter: "B", name: "Network & Relationship Intelligence", release: "R2", readiness: "partial", scope: "Reply handling works from pasted messages; NetworkRadar adapter pending", dataRequirements: ["networkradar"] },
  { id: "sales", letter: "C", name: "Sales & Deals", release: "R2", readiness: "planned", scope: "Pipeline, proposals, pilots, follow-up engine", dataRequirements: ["networkradar", "crm"] },
  { id: "research", letter: "D", name: "Research & Market Intelligence", release: "R2", readiness: "planned", scope: "Sourced research briefs", dataRequirements: ["web"] },
  { id: "projects", letter: "E", name: "Projects & Delivery", release: "R2", readiness: "planned", scope: "Workflow discovery to pilot to proof (W2)", dataRequirements: ["github", "drive"] },
  { id: "content", letter: "F", name: "Content Studio", release: "R3", readiness: "planned", scope: "Work to content to distribution to learning (W3)", dataRequirements: ["metricool_or_buffer"] },
  { id: "marketing", letter: "G", name: "Marketing, Ads & Conversion", release: "R4", readiness: "planned", scope: "Campaign plans separate from live spend", dataRequirements: ["ad_platforms"] },
  { id: "customer", letter: "H", name: "Customer & Service", release: "R4", readiness: "planned", scope: "Evidence-backed answer drafts and escalation", dataRequirements: ["knowledge"] },
  { id: "operations", letter: "I", name: "Operations & Back Office", release: "R4", readiness: "planned", scope: "Document intake, reminders, routing", dataRequirements: [] },
  { id: "finance", letter: "J", name: "Finance", release: "R4", readiness: "planned", scope: "Read-only reports from connected records", dataRequirements: ["billing"] },
  { id: "website", letter: "K", name: "Website, Analytics & Experiments", release: "R4", readiness: "planned", scope: "PostHog/GA4 monitoring, experiment history", dataRequirements: ["posthog", "ga4"] },
  { id: "events", letter: "L", name: "Events & Opportunity Radar", release: "R4", readiness: "planned", scope: "Event prep and follow-up", dataRequirements: ["networkradar"] },
  { id: "knowledge", letter: "M", name: "Knowledge & Agent Improvement", release: "R4", readiness: "planned", scope: "Versioned skills, corrections, evals", dataRequirements: ["drive"] },
  { id: "blueprints", letter: "N", name: "Reusable Client Blueprints", release: "R4", readiness: "planned", scope: "Declarative templates, isolated client workspaces", dataRequirements: [] },
];

export const SKILLS: SkillDef[] = [
  { id: "reply_triage", version: "1.0.0", name: "Reply triage and draft", departmentId: "network", readiness: "live", summary: "Classify an inbound message, explain why, draft a reply, queue it for approval (W1).", toolIds: ["networkradar.lookup_contact", "email.export_reply_draft", "gmail.create_draft"], optionalConnectors: ["gmail", "networkradar"], testedBy: ["packages/brain/src/brain.test.ts"] },
  { id: "daily_brief", version: "1.0.0", name: "Daily Chief of Staff brief", departmentId: "chief_of_staff", readiness: "live", summary: "One critical action, up to three important, waiting, blockers, with provenance (W4).", toolIds: [], optionalConnectors: ["google_calendar", "gmail", "networkradar"], testedBy: ["packages/brain/src/brain.test.ts"] },
  { id: "approval_execution", version: "1.0.0", name: "Approval and execution", departmentId: "chief_of_staff", readiness: "live", summary: "Human decision, hash revalidation, bounded retries, receipts, replay.", toolIds: ["task.create"], optionalConnectors: [], testedBy: ["packages/tools/src/gateway.test.ts"] },
  { id: "followup_scheduling", version: "1.0.0", name: "Follow-up scheduling", departmentId: "network", readiness: "partial", summary: "Creates one follow-up task after an approved reply. No calendar write yet.", toolIds: ["task.create"], optionalConnectors: ["google_calendar"], testedBy: ["packages/brain/src/brain.test.ts"] },
  { id: "contact_verification", version: "1.0.0", name: "Contact verification (NetworkRadar, read-only)", departmentId: "network", readiness: "partial", summary: "Exact-email match against the canonical NetworkRadar record. Adapter proven against a local mock MCP server only; live access is blocked on a credential (docs/networkradar-connectivity.md).", toolIds: ["networkradar.lookup_contact"], optionalConnectors: ["networkradar"], testedBy: ["packages/integrations/src/networkradar.test.ts", "packages/brain/src/contact.test.ts"] },
  { id: "background_jobs", version: "1.0.0", name: "Durable background jobs", departmentId: "chief_of_staff", readiness: "live", summary: "Leased claims, idempotent enqueue, retry/backoff, dead-letter, cancel, replay, approval pause/resume. Local engine tested; Trigger.dev dispatch scaffolded, unverified.", toolIds: [], optionalConnectors: [], testedBy: ["packages/jobs/src/jobs.test.ts", "packages/jobs/src/handlers.test.ts"] },
  { id: "meeting_prep", version: "0.0.0", name: "Meeting prep", departmentId: "network", readiness: "planned", summary: "Needs calendar and relationship history.", toolIds: [], optionalConnectors: ["google_calendar", "networkradar"], testedBy: [] },
  { id: "workflow_discovery", version: "0.0.0", name: "Workflow discovery to pilot", departmentId: "projects", readiness: "planned", summary: "W2, scheduled for R2.", toolIds: [], optionalConnectors: [], testedBy: [] },
  { id: "content_pipeline", version: "0.0.0", name: "Work to content pipeline", departmentId: "content", readiness: "planned", summary: "W3, scheduled for R3.", toolIds: [], optionalConnectors: ["metricool"], testedBy: [] },
];

export const AGENTS: AgentDef[] = [
  { id: "chief_of_staff", name: "Chief of Staff", departmentIds: ["chief_of_staff", "network"], skillIds: ["reply_triage", "daily_brief", "followup_scheduling"], allowedToolIds: ["networkradar.lookup_contact", "email.export_reply_draft", "gmail.create_draft", "task.create"], readiness: "live", description: "The single real agent in R1. It reads, ranks, drafts and proposes. It cannot approve its own proposals." },
];

export const Blueprint = z.object({
  id: z.string(),
  industry: z.string(),
  status: z.literal("unconfigured"),
  sourceSystems: z.array(z.string()),
  entities: z.array(z.string()),
  signals: z.array(z.string()),
  kpis: z.array(z.string()),
  handoffs: z.array(z.string()),
  requiredConnectorScopes: z.array(z.string()),
  notes: z.string(),
});
export type Blueprint = z.infer<typeof Blueprint>;

const NOTE = "Template only. Cannot run until client-specific workflow discovery and connections are done. Data isolation: one workspace per client.";
export const BLUEPRINTS: Blueprint[] = [
  { id: "hospitality", industry: "Hospitality / property management", status: "unconfigured", sourceSystems: ["PMS", "channel manager", "email"], entities: ["booking", "guest", "property", "task"], signals: ["new booking", "guest message", "cancellation"], kpis: ["response time", "turnover time"], handoffs: ["guest complaint", "refund"], requiredConnectorScopes: ["pms.read", "email.read"], notes: NOTE },
  { id: "roofing_office", industry: "Roofing office", status: "unconfigured", sourceSystems: ["CRM", "calendar", "estimating tool"], entities: ["lead", "estimate", "job"], signals: ["web form", "missed call"], kpis: ["speed to lead", "estimate win rate"], handoffs: ["quote sign-off"], requiredConnectorScopes: ["crm.read", "calendar.read"], notes: NOTE },
  { id: "ecommerce", industry: "E-commerce store", status: "unconfigured", sourceSystems: ["shop platform", "support inbox", "ads"], entities: ["order", "customer", "product"], signals: ["order", "support ticket", "review"], kpis: ["first response time", "repeat rate"], handoffs: ["refund", "ad budget change"], requiredConnectorScopes: ["shop.read", "support.read"], notes: NOTE },
  { id: "b2b_sales", industry: "B2B sales team", status: "unconfigured", sourceSystems: ["CRM", "email", "calendar"], entities: ["account", "contact", "deal"], signals: ["reply", "meeting booked", "stalled deal"], kpis: ["qualified meetings", "pilot conversion"], handoffs: ["proposal", "pricing"], requiredConnectorScopes: ["crm.read", "email.read"], notes: NOTE },
  { id: "professional_services", industry: "Professional services", status: "unconfigured", sourceSystems: ["practice management", "email", "billing"], entities: ["client", "matter", "invoice"], signals: ["client email", "deadline"], kpis: ["utilisation", "days to invoice"], handoffs: ["client-sensitive decision"], requiredConnectorScopes: ["pm.read", "email.read"], notes: NOTE },
];
