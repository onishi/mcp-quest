/**
 * Simulator (spec §5.3/§17): virtual players with random policies play every
 * scenario many times. Checks termination and resource invariants. This is a
 * rules/reachability test, not a fun test.
 */
import { GameError, hash53 } from "@mcp-quest/kernel";
import { describe, expect, it } from "vitest";
import { compiled, makeKernel, newCharacter, newPlayer, rid } from "../helpers/world.js";

const CLASSES = ["warrior", "mage", "thief", "cleric"];

function pick<T>(arr: T[], r: number): T {
  return arr[Math.floor(r * arr.length) % arr.length] as T;
}

function play(seed: number, scenarioId: string, cls: string) {
  let n = 0;
  const rnd = () => (hash53(`${seed}:${n++}`) % 10000) / 10000;
  const { kernel } = makeKernel({ seed: () => `sim-${seed}` });
  const acc = newPlayer(kernel);
  const chr = newCharacter(kernel, acc, cls);
  const start = kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: scenarioId, request_id: rid() }) as any;
  const ep = start.episode_id as string;
  let turn = 0;
  let last: any = start;
  const outcomes = new Set<string>();
  for (let step = 0; step < 200; step++) {
    const { actions } = kernel.call(acc, "get_actions", { episode_id: ep }) as any;
    // Avoid withdrawing most of the time so we explore the scenario.
    const candidates = actions.filter((a: any) => a.action_id !== "withdraw" || rnd() < 0.02);
    const a = pick(candidates, rnd()) as any;
    const params: Record<string, string> = {};
    const p = a.parameters;
    if (a.action_id === "move") params.to = pick(p.to, rnd()).id;
    if (a.action_id === "investigate") params.target_id = pick(p.target_id, rnd()).id;
    if (a.action_id === "talk") {
      params.target_id = pick(p.target_id, rnd()).id;
      params.approach = pick(p.approach, rnd());
    }
    if (a.action_id === "interact") {
      const c = pick(p.choices, rnd()) as any;
      params.target_id = c.target_id;
      params.option_id = c.option_id;
    }
    if (a.action_id === "use_item") params.item_id = pick(p.item_id, rnd()).id;
    if (a.action_id === "attack") params.target_id = pick(p.target_id, rnd()).id;
    if (a.action_id === "cast") {
      params.spell_id = pick(p.spell_id, rnd()).id;
      if (p.target_id) params.target_id = pick(p.target_id, rnd()).id;
    }
    try {
      last = kernel.call(acc, "act", { episode_id: ep, action_id: a.action_id, parameters: params, expected_turn: turn, request_id: rid() });
      turn = last.turn;
      // invariants
      expect(last.character.hp).toBeGreaterThanOrEqual(0);
      expect(last.character.hp).toBeLessThanOrEqual(last.character.max_hp);
      expect(last.character.mp).toBeGreaterThanOrEqual(0);
      if (last.progress.episode_complete) {
        outcomes.add(last.conclusion.outcome);
        break;
      }
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      // Domain errors must be non-mutating and of an expected kind.
      expect(["INVALID_ACTION", "NEEDS_CLARIFICATION"]).toContain(e.code);
    }
  }
  const s = compiled.scenarios.find((x) => x.id === scenarioId)!;
  expect(last.progress.episode_complete, `seed ${seed} did not terminate`).toBe(true);
  expect(turn).toBeLessThanOrEqual(s.maxTurns);
  const sheet = (kernel.call(acc, "get_character", { character_id: chr }) as any).character;
  expect(sheet.gold).toBeGreaterThanOrEqual(0);
  expect(sheet.xp).toBeLessThanOrEqual(s.impactLimits.maxXp);
  expect(sheet.gold).toBeLessThanOrEqual(10 + s.impactLimits.maxGold + 100);
  expect(sheet.hp).toBeGreaterThanOrEqual(1);
  const completed = kernel.sql.all("SELECT 1 FROM world_events WHERE type = 'episode.completed'");
  expect(completed).toHaveLength(1);
  return { outcome: last.conclusion.outcome as string, resolution: last.conclusion.title as string, turns: turn };
}

describe("random-policy simulation", () => {
  for (const s of compiled.scenarios) {
    it(`${s.id}: always terminates within maxTurns with valid state`, () => {
      const results = Array.from({ length: 60 }, (_, i) => play(i + 1, s.id, CLASSES[i % 4]!));
      const resolutions = new Set(results.map((r) => r.resolution));
      // A random player should be able to reach more than one ending.
      expect(resolutions.size).toBeGreaterThan(1);
    });
  }
});
