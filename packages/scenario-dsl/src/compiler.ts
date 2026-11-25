/**
 * Scenario compiler / validator. Pure, deterministic, no LLM, no I/O.
 *
 * Checks (spec §5.4, §5.5): schema/types, internal references, references to
 * the world catalog, reachability of nodes, satisfiable required objectives,
 * mandatory withdraw/turn-limit exits (termination), execution-size limits and
 * that secrets are not referenced from public text.
 */
import {
  type CompiledScenario,
  type Cond,
  type Effect,
  type Scenario,
  ScenarioSourceSchema,
  SCHEMA_VERSION,
} from "./schema.js";

export interface WorldCatalog {
  items: ReadonlySet<string>;
  monsters: ReadonlySet<string>;
  /** NPCs, locations and other world entities */
  entities: ReadonlySet<string>;
  facts: ReadonlySet<string>;
  /** ids of facts whose visibility is secret (must not be revealed in public text) */
  secretFacts?: ReadonlySet<string>;
}

export interface CompileIssue {
  path: string;
  message: string;
}

export type CompileResult =
  | { ok: true; scenario: CompiledScenario; warnings: CompileIssue[] }
  | { ok: false; errors: CompileIssue[]; warnings: CompileIssue[] };

export const DSL_RULE_VERSION = "scenario-dsl@1.0.0";
/** Upper bound on effects executed for a single trigger, including clock cascades. */
export const MAX_EFFECTS_PER_TRIGGER = 16;

export async function compileScenario(source: unknown, catalog: WorldCatalog): Promise<CompileResult> {
  const parsed = ScenarioSourceSchema.safeParse(source);
  if (!parsed.success) {
    return {
      ok: false,
      warnings: [],
      errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    };
  }
  const s = parsed.data;
  const errors: CompileIssue[] = [];
  const warnings: CompileIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  const nodeIds = uniqueIds(s.nodes, "nodes", err);
  const clueIds = uniqueIds(s.clues, "clues", err);
  const clockIds = uniqueIds(s.clocks, "clocks", err);
  const enemyIds = uniqueIds(s.enemies, "enemies", err);
  uniqueIds(s.triggers, "triggers", err);
  const resolutionIds = uniqueIds(s.resolutions, "resolutions", err);
  uniqueIds(s.objectives, "objectives", err);

  // Flags that are ever set (by any effect) — used for satisfiability checks.
  const setFlags = new Set<string>();
  const revealedClues = new Set<string>();
  const givenItems = new Set<string>();
  const defeatable = new Set<string>();
  const movesTo = new Set<string>();
  const allEffects: Array<[string, Effect]> = [];
  const collect = (path: string, effects: Effect[]) => effects.forEach((e, i) => allEffects.push([`${path}[${i}]`, e]));
  s.triggers.forEach((t, i) => {
    collect(`triggers[${i}].effects`, t.effects);
    collect(`triggers[${i}].onSuccess`, t.onSuccess);
    collect(`triggers[${i}].onFailure`, t.onFailure);
  });
  s.nodes.forEach((n, i) => collect(`nodes[${i}].onEnter`, n.onEnter));
  s.clocks.forEach((c, i) => collect(`clocks[${i}].onFull`, c.onFull));

  for (const [path, e] of allEffects) {
    switch (e.op) {
      case "set_flag":
        setFlags.add(e.id);
        break;
      case "reveal_clue":
        if (!clueIds.has(e.id)) err(path, `unknown clue ${e.id}`);
        revealedClues.add(e.id);
        break;
      case "advance_clock":
        if (!clockIds.has(e.id)) err(path, `unknown clock ${e.id}`);
        break;
      case "move_to":
        if (!nodeIds.has(e.node)) err(path, `unknown node ${e.node}`);
        movesTo.add(e.node);
        break;
      case "give_item":
      case "take_item":
        if (!catalog.items.has(e.item)) err(path, `unknown item ${e.item}`);
        if (e.op === "give_item") givenItems.add(e.item);
        break;
      case "start_combat":
        for (const en of e.enemies) {
          if (!enemyIds.has(en)) err(path, `unknown enemy ${en}`);
          defeatable.add(en);
        }
        break;
      case "defeat":
        if (!enemyIds.has(e.enemy)) err(path, `unknown enemy ${e.enemy}`);
        defeatable.add(e.enemy);
        break;
      case "relation":
        if (!catalog.entities.has(e.npc)) err(path, `unknown npc ${e.npc}`);
        break;
      default:
        break;
    }
  }

  // Clock cascades: a clock's onFull must not advance clocks (bounded execution).
  s.clocks.forEach((c, i) => {
    if (c.onFull.some((e) => e.op === "advance_clock")) err(`clocks[${i}].onFull`, "onFull may not advance clocks");
  });
  // Effect count limit per trigger including worst-case single clock cascade.
  const maxOnFull = Math.max(0, ...s.clocks.map((c) => c.onFull.length));
  s.triggers.forEach((t, i) => {
    const worst = t.effects.length + Math.max(t.onSuccess.length, t.onFailure.length);
    const clocks = [...t.effects, ...t.onSuccess, ...t.onFailure].filter((e) => e.op === "advance_clock").length;
    if (worst + clocks * maxOnFull > MAX_EFFECTS_PER_TRIGGER)
      err(`triggers[${i}]`, `too many effects (limit ${MAX_EFFECTS_PER_TRIGGER} incl. clock cascades)`);
    if ((t.action === "investigate" || t.action === "talk") && !t.target) err(`triggers[${i}]`, `${t.action} needs target`);
    if (t.action === "interact" && (!t.target || !t.option || !t.label))
      err(`triggers[${i}]`, "interact needs target, option and label");
    if (t.action === "use_item" && !t.item) err(`triggers[${i}]`, "use_item needs item");
    if (t.item && !catalog.items.has(t.item)) err(`triggers[${i}].item`, `unknown item ${t.item}`);
    if (t.check && t.onSuccess.length === 0 && t.effects.length === 0)
      warnings.push({ path: `triggers[${i}]`, message: "check without onSuccess effects" });
    if (!t.check && (t.onSuccess.length > 0 || t.onFailure.length > 0))
      err(`triggers[${i}]`, "onSuccess/onFailure require a check");
    t.nodes?.forEach((n) => nodeIds.has(n) || err(`triggers[${i}].nodes`, `unknown node ${n}`));
    if (t.target) {
      const present = s.nodes.some((n) => (!t.nodes || t.nodes.includes(n.id)) && n.targets.some((x) => x.id === t.target));
      if (!present) err(`triggers[${i}].target`, `target ${t.target} is not present in any eligible node`);
    }
  });

  // Targets referencing world entities / monsters
  s.nodes.forEach((n, i) => {
    if (!catalog.entities.has(n.location)) err(`nodes[${i}].location`, `unknown location ${n.location}`);
    n.exits.forEach((x, j) => nodeIds.has(x.to) || err(`nodes[${i}].exits[${j}]`, `unknown node ${x.to}`));
    n.targets.forEach((t, j) => {
      if (t.entity && !catalog.entities.has(t.entity)) err(`nodes[${i}].targets[${j}]`, `unknown entity ${t.entity}`);
      if (t.kind === "enemy" && !enemyIds.has(t.id)) err(`nodes[${i}].targets[${j}]`, `enemy target ${t.id} not in enemies`);
    });
  });
  s.enemies.forEach((e, i) => catalog.monsters.has(e.monster) || err(`enemies[${i}]`, `unknown monster ${e.monster}`));
  s.clues.forEach((c, i) => {
    if (c.fact && !catalog.facts.has(c.fact)) err(`clues[${i}].fact`, `unknown fact ${c.fact}`);
  });
  s.dependencies.forEach((d, i) => catalog.entities.has(d.entity) || err(`dependencies[${i}]`, `unknown entity ${d.entity}`));
  s.resolutions.forEach((r, i) => {
    r.rewards.items.forEach((it) => catalog.items.has(it) || err(`resolutions[${i}].rewards`, `unknown item ${it}`));
    if (r.rewards.xp > s.impactLimits.maxXp) err(`resolutions[${i}].rewards.xp`, "exceeds impactLimits.maxXp");
    if (r.rewards.gold > s.impactLimits.maxGold) err(`resolutions[${i}].rewards.gold`, "exceeds impactLimits.maxGold");
    r.worldEffects.forEach((w, j) => {
      if (w.op === "set_fact" && !catalog.facts.has(w.fact)) err(`resolutions[${i}].worldEffects[${j}]`, `unknown fact ${w.fact}`);
      if (w.op === "set_entity_status" && !catalog.entities.has(w.entity))
        err(`resolutions[${i}].worldEffects[${j}]`, `unknown entity ${w.entity}`);
    });
  });
  [...s.eligibility.requiresFacts, ...s.eligibility.forbidsFacts].forEach(
    (f) => catalog.facts.has(f) || err("eligibility", `unknown fact ${f}`),
  );

  // Condition references
  const checkCond = (path: string, c: Cond | undefined) => {
    if (!c) return;
    walkCond(c, (leaf) => {
      if ("clue" in leaf && !clueIds.has(leaf.clue)) err(path, `unknown clue ${leaf.clue}`);
      if ("node" in leaf && !nodeIds.has(leaf.node)) err(path, `unknown node ${leaf.node}`);
      if ("clock" in leaf && !clockIds.has(leaf.clock)) err(path, `unknown clock ${leaf.clock}`);
      if ("defeated" in leaf && !enemyIds.has(leaf.defeated)) err(path, `unknown enemy ${leaf.defeated}`);
      if ("hasItem" in leaf && !catalog.items.has(leaf.hasItem)) err(path, `unknown item ${leaf.hasItem}`);
      if ("flag" in leaf && !setFlags.has(leaf.flag)) warnings.push({ path, message: `flag ${leaf.flag} is never set` });
    });
  };
  s.triggers.forEach((t, i) => checkCond(`triggers[${i}].when`, t.when));
  s.nodes.forEach((n, i) => {
    n.exits.forEach((x, j) => checkCond(`nodes[${i}].exits[${j}].requires`, x.requires));
    n.targets.forEach((t, j) => checkCond(`nodes[${i}].targets[${j}].visibleWhen`, t.visibleWhen));
  });
  s.objectives.forEach((o, i) => checkCond(`objectives[${i}].doneWhen`, o.doneWhen));
  s.resolutions.forEach((r, i) => checkCond(`resolutions[${i}].when`, r.when));

  // Reachability of nodes from initialNode via exits or move_to effects.
  if (!nodeIds.has(s.initialNode)) err("initialNode", `unknown node ${s.initialNode}`);
  else {
    const seen = new Set([s.initialNode, ...movesTo]);
    const queue = [...seen];
    while (queue.length) {
      const id = queue.shift();
      const n = s.nodes.find((x) => x.id === id);
      for (const x of n?.exits ?? []) if (!seen.has(x.to)) (seen.add(x.to), queue.push(x.to));
    }
    s.nodes.forEach((n) => seen.has(n.id) || err(`nodes.${n.id}`, "node is unreachable"));
  }

  // Satisfiability (static over-approximation): every required objective and
  // every non-withdraw resolution must reference only things that can happen.
  const satisfiable = (c: Cond): boolean => {
    if ("flag" in c) return setFlags.has(c.flag);
    if ("clue" in c) return revealedClues.has(c.clue);
    if ("defeated" in c) return defeatable.has(c.defeated);
    if ("hasItem" in c) return true;
    if ("all" in c) return c.all.every(satisfiable);
    if ("any" in c) return c.any.some(satisfiable);
    return true;
  };
  s.objectives.forEach((o, i) => {
    if (o.required && !satisfiable(o.doneWhen)) err(`objectives[${i}]`, "required objective can never be completed");
  });
  // Withdraw and fallback-only resolutions are applied directly by the kernel.
  const directResolutions = new Set(s.fallbackPolicy.map((f) => f.resolution).filter(Boolean));
  s.resolutions.forEach((r, i) => {
    if (r.outcome === "withdrawn" || directResolutions.has(r.id)) return;
    if (!satisfiable(r.when)) err(`resolutions[${i}]`, "resolution can never be reached");
  });
  if (!s.resolutions.some((r) => r.outcome === "success")) err("resolutions", "needs at least one success resolution");
  const successCount = s.resolutions.filter((r) => r.outcome === "success" || r.outcome === "partial").length;
  if (successCount < 2) warnings.push({ path: "resolutions", message: "only one non-failure resolution; prefer multiple solutions" });

  // Termination: there must be a withdraw resolution and a turn-limit fallback.
  const withdraw = s.resolutions.find((r) => r.outcome === "withdrawn");
  if (!withdraw) err("resolutions", "needs a withdrawn resolution (players can always leave)");
  for (const when of ["turn_limit", "character_down"] as const) {
    const fb = s.fallbackPolicy.find((f) => f.when === when);
    if (!fb) err("fallbackPolicy", `needs a ${when} fallback`);
    else if (fb.mode !== "conclude" || !fb.resolution) err("fallbackPolicy", `${when} fallback must conclude with a resolution`);
  }
  s.fallbackPolicy.forEach((f, i) => {
    if (f.resolution && !resolutionIds.has(f.resolution)) err(`fallbackPolicy[${i}]`, `unknown resolution ${f.resolution}`);
  });
  if (s.dependencies.length > 0 && !s.fallbackPolicy.some((f) => f.when === "dependency_lost"))
    err("fallbackPolicy", "scenarios with dependencies need a dependency_lost fallback");
  if (s.maxTurns < s.targetTurns) err("maxTurns", "maxTurns must be >= targetTurns");

  // Secrets: public text must not mention secret fact ids.
  if (catalog.secretFacts) {
    for (const f of catalog.secretFacts) {
      if (s.hook.includes(f) || s.publicSummary.includes(f)) err("hook", `public text references secret fact ${f}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const ruleVersions = { dsl: DSL_RULE_VERSION, schema: `scenario-schema@${SCHEMA_VERSION}` };
  const digest = await sha256Hex(canonicalJson({ ...s, ruleVersions }));
  return { ok: true, scenario: { ...s, digest, ruleVersions }, warnings };
}

export function walkCond(c: Cond, visit: (leaf: Cond) => void): void {
  if ("all" in c) c.all.forEach((x) => walkCond(x, visit));
  else if ("any" in c) c.any.forEach((x) => walkCond(x, visit));
  else if ("not" in c) walkCond(c.not, visit);
  else visit(c);
}

function uniqueIds(items: Array<{ id: string }>, path: string, err: (p: string, m: string) => void): Set<string> {
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) err(path, `duplicate id ${it.id}`);
    ids.add(it.id);
  }
  return ids;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type { Scenario };
