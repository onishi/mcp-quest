import { compileScenario } from "@mcp-quest/scenario-dsl";
import { catalogOf } from "@mcp-quest/kernel";
import { eldiaWorld, scenarioSources } from "@mcp-quest/world";
import { describe, expect, it } from "vitest";

const catalog = catalogOf(eldiaWorld);
const base = () => structuredClone(scenarioSources[0]) as any;

async function errorsOf(src: unknown) {
  const r = await compileScenario(src, catalog);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
}

describe("scenario compiler", () => {
  it("compiles every shipped scenario with a digest and rule versions", async () => {
    for (const src of scenarioSources) {
      const r = await compileScenario(src, catalog);
      if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
      expect(r.scenario.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(r.scenario.ruleVersions.dsl).toBeDefined();
    }
  });

  it("digest is stable for identical input", async () => {
    const a = await compileScenario(base(), catalog);
    const b = await compileScenario(base(), catalog);
    expect(a.ok && b.ok && a.scenario.digest === b.scenario.digest).toBe(true);
  });

  it("rejects undefined ids", async () => {
    const s = base();
    s.triggers[0].effects.push({ op: "reveal_clue", id: "no_such_clue" });
    s.triggers[0].effects.push({ op: "give_item", item: "excalibur", qty: 1 });
    const errs = await errorsOf(s);
    expect(errs.some((e) => e.includes("unknown clue no_such_clue"))).toBe(true);
    expect(errs.some((e) => e.includes("unknown item excalibur"))).toBe(true);
  });

  it("rejects forbidden constructs (unknown ops, code-like fields)", async () => {
    const s = base();
    s.triggers[0].effects.push({ op: "eval", code: "fetch('https://example.com')" });
    expect((await errorsOf(s)).length).toBeGreaterThan(0);
    const s2 = base();
    s2.triggers[0].script = "while(true){}";
    expect((await errorsOf(s2)).length).toBeGreaterThan(0);
  });

  it("rejects unreachable nodes", async () => {
    const s = base();
    s.nodes.push({ id: "island", name: "孤島", location: "loc_ruins", description: "どこからも行けない" });
    expect((await errorsOf(s)).some((e) => e.includes("unreachable"))).toBe(true);
  });

  it("requires withdraw resolution and turn-limit/character-down fallbacks (termination)", async () => {
    const s = base();
    s.resolutions = s.resolutions.filter((r: any) => r.outcome !== "withdrawn");
    s.fallbackPolicy = s.fallbackPolicy.filter((f: any) => f.when !== "turn_limit");
    const errs = await errorsOf(s);
    expect(errs.some((e) => e.includes("withdrawn"))).toBe(true);
    expect(errs.some((e) => e.includes("turn_limit"))).toBe(true);
  });

  it("rejects required objectives that can never be completed", async () => {
    const s = base();
    s.objectives.push({ id: "o_impossible", text: "不可能", required: true, doneWhen: { flag: "never_set_anywhere" } });
    expect((await errorsOf(s)).some((e) => e.includes("never be completed"))).toBe(true);
  });

  it("rejects rewards over impact limits", async () => {
    const s = base();
    s.resolutions[0].rewards.gold = 199;
    expect((await errorsOf(s)).some((e) => e.includes("maxGold"))).toBe(true);
  });

  it("rejects excessive effect chains (execution bound)", async () => {
    const s = base();
    s.triggers[0].effects = Array.from({ length: 16 }, () => ({ op: "advance_clock", id: "alarm", amount: 1 }));
    expect((await errorsOf(s)).some((e) => e.includes("too many effects"))).toBe(true);
  });

  it("rejects secrets referenced in public text", async () => {
    const s = base();
    s.hook = "fact_elena_forbidden_research についての話";
    expect((await errorsOf(s)).some((e) => e.includes("secret"))).toBe(true);
  });
});
