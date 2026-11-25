/**
 * Scenario interpreter. Executes compiled DSL with bounded effects.
 * Randomness and character mutations are delegated to the Host so the kernel
 * can record dice and enforce resource invariants.
 */
import { MAX_EFFECTS_PER_TRIGGER } from "./compiler.js";
import type { CompiledScenario, Cond, Effect, Resolution, SceneNode, Trigger } from "./schema.js";

export interface EnemyState {
  hp: number;
  maxHp: number;
}

export interface EpisodeState {
  node: string;
  flags: string[];
  clues: string[];
  clocks: Record<string, number>;
  usedTriggers: string[];
  defeated: string[];
  combat: { active: boolean; enemies: Record<string, EnemyState> };
  visitedNodes: string[];
  /** last turn at which the story advanced (clue, flag, scene, combat) */
  progressTurn?: number;
  /** hint ids already offered to the GM */
  hintsGiven?: string[];
  /** actions without story consequence (small talk, flavour); not counted toward maxTurns */
  freeActions?: number;
}

export interface Host {
  turn(): number;
  hasItem(item: string): boolean;
  /** Apply a character-level effect (damage, heal, items, gold, relation). Returns narration. */
  applyCharacterEffect(effect: Extract<Effect, { op: "damage" | "heal" | "give_item" | "take_item" | "gold" | "relation" }>): string | undefined;
  /** Create combat stats for an enemy (from monster catalog). */
  spawnEnemy(enemyId: string): EnemyState;
}

export interface EffectOutput {
  texts: string[];
  revealedClues: string[];
  moved?: string;
  combatStarted: string[];
  combatEnded: boolean;
  defeated: string[];
  effectsApplied: number;
}

export function initialState(s: CompiledScenario): EpisodeState {
  return {
    node: s.initialNode,
    flags: [],
    clues: [],
    clocks: Object.fromEntries(s.clocks.map((c) => [c.id, 0])),
    usedTriggers: [],
    defeated: [],
    combat: { active: false, enemies: {} },
    visitedNodes: [s.initialNode],
  };
}

export function evalCond(c: Cond, st: EpisodeState, host: Pick<Host, "turn" | "hasItem">): boolean {
  if ("flag" in c) return st.flags.includes(c.flag);
  if ("clue" in c) return st.clues.includes(c.clue);
  if ("node" in c) return st.node === c.node;
  if ("clock" in c) return (st.clocks[c.clock] ?? 0) >= c.gte;
  if ("defeated" in c) return st.defeated.includes(c.defeated);
  if ("hasItem" in c) return host.hasItem(c.hasItem);
  if ("turnGte" in c) return host.turn() >= c.turnGte;
  if ("combat" in c) return st.combat.active === c.combat;
  if ("not" in c) return !evalCond(c.not, st, host);
  if ("all" in c) return c.all.every((x) => evalCond(x, st, host));
  if ("any" in c) return c.any.some((x) => evalCond(x, st, host));
  return false;
}

export function currentNode(s: CompiledScenario, st: EpisodeState): SceneNode {
  const n = s.nodes.find((x) => x.id === st.node);
  if (!n) throw new Error(`node ${st.node} missing`);
  return n;
}

export function visibleTargets(s: CompiledScenario, st: EpisodeState, host: Pick<Host, "turn" | "hasItem">) {
  return currentNode(s, st).targets.filter((t) => {
    if (t.kind === "enemy" && (st.defeated.includes(t.id) || !st.combat.enemies[t.id])) return false;
    return !t.visibleWhen || evalCond(t.visibleWhen, st, host);
  });
}

export function availableExits(s: CompiledScenario, st: EpisodeState, host: Pick<Host, "turn" | "hasItem">) {
  return currentNode(s, st).exits.map((x) => ({ ...x, open: !x.requires || evalCond(x.requires, st, host) }));
}

/** Triggers usable right now (node, target visibility, when-condition, once). */
export function eligibleTriggers(s: CompiledScenario, st: EpisodeState, host: Pick<Host, "turn" | "hasItem">): Trigger[] {
  const targets = new Set(visibleTargets(s, st, host).map((t) => t.id));
  return s.triggers.filter((t) => {
    if (t.once && st.usedTriggers.includes(t.id)) return false;
    if (t.nodes && !t.nodes.includes(st.node)) return false;
    if (t.target && !targets.has(t.target)) return false;
    if (t.when && !evalCond(t.when, st, host)) return false;
    return true;
  });
}

export function applyEffects(s: CompiledScenario, st: EpisodeState, host: Host, effects: Effect[], out: EffectOutput, depth = 0): void {
  for (const e of effects) {
    if (out.effectsApplied >= MAX_EFFECTS_PER_TRIGGER * 2) throw new Error("effect limit exceeded");
    out.effectsApplied++;
    switch (e.op) {
      case "reveal_clue":
        if (!st.clues.includes(e.id)) {
          st.clues.push(e.id);
          out.revealedClues.push(e.id);
        }
        break;
      case "set_flag":
        if (!st.flags.includes(e.id)) st.flags.push(e.id);
        break;
      case "clear_flag":
        st.flags = st.flags.filter((f) => f !== e.id);
        break;
      case "advance_clock": {
        const clock = s.clocks.find((c) => c.id === e.id);
        if (!clock) break;
        const before = st.clocks[e.id] ?? 0;
        const after = Math.min(clock.max, before + e.amount);
        st.clocks[e.id] = after;
        if (before < clock.max && after >= clock.max && depth === 0) applyEffects(s, st, host, clock.onFull, out, depth + 1);
        break;
      }
      case "move_to":
        st.node = e.node;
        out.moved = e.node;
        if (!st.visitedNodes.includes(e.node)) {
          st.visitedNodes.push(e.node);
          if (depth === 0) applyEffects(s, st, host, currentNode(s, st).onEnter, out, depth + 1);
        }
        break;
      case "start_combat":
        st.combat.active = true;
        for (const id of e.enemies) {
          if (st.defeated.includes(id) || st.combat.enemies[id]) continue;
          st.combat.enemies[id] = host.spawnEnemy(id);
          out.combatStarted.push(id);
        }
        break;
      case "end_combat":
        st.combat = { active: false, enemies: {} };
        out.combatEnded = true;
        break;
      case "defeat":
        markDefeated(st, e.enemy, out);
        break;
      case "narrate":
        out.texts.push(e.text);
        break;
      default: {
        const text = host.applyCharacterEffect(e);
        if (text) out.texts.push(text);
      }
    }
  }
}

export function markDefeated(st: EpisodeState, enemy: string, out: EffectOutput) {
  if (!st.defeated.includes(enemy)) st.defeated.push(enemy);
  delete st.combat.enemies[enemy];
  out.defeated.push(enemy);
  if (Object.keys(st.combat.enemies).length === 0 && st.combat.active) {
    st.combat.active = false;
    out.combatEnded = true;
  }
}

export function emptyOutput(): EffectOutput {
  return { texts: [], revealedClues: [], combatStarted: [], combatEnded: false, defeated: [], effectsApplied: 0 };
}

export function findResolution(s: CompiledScenario, st: EpisodeState, host: Pick<Host, "turn" | "hasItem">): Resolution | undefined {
  const direct = new Set(s.fallbackPolicy.map((f) => f.resolution));
  return s.resolutions.find((r) => r.outcome !== "withdrawn" && !direct.has(r.id) && evalCond(r.when, st, host));
}

export function objectiveStatus(s: CompiledScenario, st: EpisodeState, host: Pick<Host, "turn" | "hasItem">) {
  return s.objectives.map((o) => ({ id: o.id, text: o.text, required: o.required, done: evalCond(o.doneWhen, st, host) }));
}
