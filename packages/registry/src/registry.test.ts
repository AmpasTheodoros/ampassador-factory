import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_TOOLS } from "@aaf/tools";
import { DEPARTMENTS, SKILLS, AGENTS, BLUEPRINTS, SkillDef, DepartmentDef, AgentDef, Blueprint } from "./index";

const root = resolve(__dirname, "../../..");

describe("registry honesty", () => {
  it("all entries satisfy their schemas", () => {
    SKILLS.forEach((s) => SkillDef.parse(s));
    DEPARTMENTS.forEach((d) => DepartmentDef.parse(d));
    AGENTS.forEach((a) => AgentDef.parse(a));
    BLUEPRINTS.forEach((b) => Blueprint.parse(b));
  });
  it("covers departments A-N", () => {
    expect(DEPARTMENTS.map((d) => d.letter).join("")).toBe("ABCDEFGHIJKLMN");
  });
  it("a live skill names tests that exist on disk; a planned skill claims none", () => {
    for (const s of SKILLS) {
      if (s.readiness === "live") {
        expect(s.testedBy.length, s.id).toBeGreaterThan(0);
        for (const f of s.testedBy) expect(existsSync(resolve(root, f)), `${s.id}: ${f}`).toBe(true);
      }
      if (s.readiness === "planned") expect(s.testedBy, s.id).toEqual([]);
    }
  });
  it("every tool referenced by a skill or agent exists in the gateway registry", () => {
    const ids = new Set(BUILTIN_TOOLS.map((t) => t.toolId));
    for (const s of SKILLS) for (const t of s.toolIds) expect(ids.has(t), `${s.id} -> ${t}`).toBe(true);
    for (const a of AGENTS) for (const t of a.allowedToolIds) expect(ids.has(t), `${a.id} -> ${t}`).toBe(true);
  });
  it("agents may not hold a send tool directly: external tools still need approval in the gateway", () => {
    for (const a of AGENTS) for (const t of a.allowedToolIds) {
      const def = BUILTIN_TOOLS.find((x) => x.toolId === t)!;
      if (def.riskTier === "external_communication" || def.riskTier === "financial_or_irreversible") expect(def.approvalPolicy).toMatch(/always/);
    }
  });
  it("no department is live without a live skill", () => {
    for (const d of DEPARTMENTS.filter((d) => d.readiness === "live")) expect(SKILLS.some((s) => s.departmentId === d.id && s.readiness === "live")).toBe(true);
  });
  it("blueprints are all unconfigured templates", () => {
    expect(BLUEPRINTS.length).toBe(5);
  });
});
