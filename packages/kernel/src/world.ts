import { type CompiledScenario, type CompileIssue, type WorldCatalog, compileScenario } from "@mcp-quest/scenario-dsl";
import type { WorldDef } from "@mcp-quest/world";

export function catalogOf(world: WorldDef): WorldCatalog {
  return {
    items: new Set(world.items.map((i) => i.id)),
    monsters: new Set(world.monsters.map((m) => m.id)),
    entities: new Set([...world.locations.map((l) => l.id), ...world.npcs.map((n) => n.id)]),
    facts: new Set(world.facts.map((f) => f.id)),
    secretFacts: new Set(world.facts.filter((f) => f.visibility === "secret").map((f) => f.id)),
  };
}

export interface CompiledWorld {
  world: WorldDef;
  scenarios: CompiledScenario[];
  warnings: Array<{ scenario: string; issues: CompileIssue[] }>;
}

/** Compile all scenarios of a world. Fails closed: any invalid scenario aborts. */
export async function compileWorld(world: WorldDef): Promise<CompiledWorld> {
  const catalog = catalogOf(world);
  const scenarios: CompiledScenario[] = [];
  const warnings: CompiledWorld["warnings"] = [];
  const failures: string[] = [];
  for (const src of world.scenarios) {
    const id = (src as { id?: string }).id ?? "?";
    const r = await compileScenario(src, catalog);
    if (!r.ok) failures.push(`${id}: ${r.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    else scenarios.push(r.scenario);
    if (r.warnings.length) warnings.push({ scenario: id, issues: r.warnings });
  }
  if (failures.length) throw new Error(`scenario compilation failed:\n${failures.join("\n")}`);
  return { world, scenarios, warnings };
}
