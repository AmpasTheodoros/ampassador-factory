import { DEPARTMENTS, SKILLS, AGENTS, BLUEPRINTS } from "@aaf/registry";
import { BUILTIN_TOOLS } from "@aaf/tools";
import { Card, PageTitle, Badge } from "@/components/ui";

const tone = (r: string) => (r === "live" ? "good" : r === "partial" ? "warn" : "neutral") as "good" | "warn" | "neutral";

export default function Agents() {
  return (
    <>
      <PageTitle
        title="Agents, skills and tools"
        sub="Readiness is stated, not implied. A skill is only live if a test in this repository proves it."
      />
      <div className="space-y-4">
        <Card title="Agents">
          {AGENTS.map((a) => (
            <div key={a.id} className="space-y-1 text-sm">
              <div className="flex items-center gap-2 font-medium">
                {a.name} <Badge tone={tone(a.readiness)}>{a.readiness}</Badge>
              </div>
              <p className="muted">{a.description}</p>
              <p className="muted text-xs">Allowed tools: {a.allowedToolIds.join(", ")}</p>
            </div>
          ))}
        </Card>
        <Card title="Departments">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Departments and readiness</caption>
              <thead>
                <tr className="muted text-xs">
                  <th className="py-1 pr-3">#</th>
                  <th className="pr-3">Department</th>
                  <th className="pr-3">Release</th>
                  <th className="pr-3">State</th>
                  <th>Scope</th>
                </tr>
              </thead>
              <tbody>
                {DEPARTMENTS.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--line)] align-top">
                    <td className="py-2 pr-3 font-mono">{d.letter}</td>
                    <td className="pr-3">{d.name}</td>
                    <td className="pr-3 font-mono">{d.release}</td>
                    <td className="pr-3">
                      <Badge tone={tone(d.readiness)}>{d.readiness}</Badge>
                    </td>
                    <td className="muted">{d.scope}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Skills (versioned)">
          <ul className="space-y-2 text-sm">
            {SKILLS.map((s) => (
              <li key={s.id}>
                <span className="font-medium">{s.name}</span> <span className="font-mono text-xs">v{s.version}</span>{" "}
                <Badge tone={tone(s.readiness)}>{s.readiness}</Badge>
                <div className="muted text-xs">
                  {s.summary}
                  {s.testedBy.length ? ` Tested by ${s.testedBy.join(", ")}.` : ""}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Tool gateway registry">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Registered tools</caption>
              <thead>
                <tr className="muted">
                  <th className="py-1 pr-3">Tool</th>
                  <th className="pr-3">Connector</th>
                  <th className="pr-3">Risk tier</th>
                  <th className="pr-3">Approval</th>
                  <th>Retry / timeout</th>
                </tr>
              </thead>
              <tbody>
                {BUILTIN_TOOLS.map((t) => (
                  <tr key={t.toolId} className="border-t border-[var(--line)]">
                    <td className="py-2 pr-3 font-mono">{t.toolId}</td>
                    <td className="pr-3">{t.connector}</td>
                    <td className="pr-3">{t.riskTier}</td>
                    <td className="pr-3">{t.approvalPolicy}</td>
                    <td>
                      {t.retry.max}x, {t.timeoutMs}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title="Client blueprints (templates, all unconfigured)">
          <ul className="space-y-1 text-sm">
            {BLUEPRINTS.map((b) => (
              <li key={b.id}>
                {b.industry} <Badge>unconfigured</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
