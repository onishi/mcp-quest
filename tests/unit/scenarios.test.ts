import { describe, expect, it } from "vitest";
import { makeKernel, newCharacter, newPlayer, rid } from "../helpers/world.js";
import type { Kernel } from "@mcp-quest/kernel";

function session(kernel: Kernel, acc: string, chr: string, adventure: string) {
  const s = kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: adventure, request_id: rid() }) as any;
  let turn = s.turn as number;
  const ep = s.episode_id as string;
  return {
    ep,
    go(action_id: string, parameters: Record<string, string> = {}) {
      const r = kernel.call(acc, "act", { episode_id: ep, action_id, parameters, expected_turn: turn, request_id: rid() }) as any;
      turn = r.turn;
      return r;
    },
  };
}

describe("missing_herbalist", () => {
  it("can be solved without any dice (light + potion + torch), with the bonus ending", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc, "warrior");
    const s = session(kernel, acc, chr, "missing_herbalist");
    expect(s.go("talk", { target_id: "elena" }).changes.items.potion_minor).toBe(1);
    s.go("move", { to: "forest_edge" });
    s.go("move", { to: "deep_forest" });
    s.go("use_item", { item_id: "torch" });
    const trail = s.go("investigate", { target_id: "old_trail" });
    expect(trail.result.checks).toHaveLength(0);
    s.go("move", { to: "spirit_spring" });
    s.go("interact", { target_id: "moonleaf_patch", option_id: "gather_moonleaf" });
    s.go("use_item", { item_id: "potion_minor", target_id: "tobi" });
    s.go("use_item", { item_id: "torch", target_id: "wolves" });
    const end = s.go("interact", { target_id: "tobi", option_id: "lead_home" });
    expect(end.progress.episode_complete).toBe(true);
    expect(end.conclusion.title).toBe("月光草と少年");
    expect(end.conclusion.world_changes).toContain("薬草採りのトビは森で迷い、冒険者に救出された。");
    // the secret fact became known to the character, but is not public
    const sheet = (kernel.call(acc, "get_character", { character_id: chr }) as any).character;
    expect(sheet.known_facts.map((f: any) => f.id)).toContain("fact_spirit_grove");
    expect(JSON.stringify(kernel.publicSnapshot())).not.toContain("精霊の泉がある");
  });
});

describe("world consequences across players", () => {
  it("banishing the spirit in last_drink removes the adventure for everyone", () => {
    const { kernel } = makeKernel({ seed: () => "banish" });
    const a = newPlayer(kernel);
    const ca = newCharacter(kernel, a, "warrior");
    const b = newPlayer(kernel);
    const cb = newCharacter(kernel, b, "mage");
    const s = session(kernel, a, ca, "last_drink");
    s.go("move", { to: "tavern_night" });
    let r = s.go("talk", { target_id: "old_spirit", approach: "intimidate" });
    expect(r.combat.active).toBe(true);
    for (let i = 0; i < 20 && !r.progress.episode_complete; i++) r = s.go("attack", { target_id: "angry_wisp" });
    expect(r.progress.episode_complete).toBe(true);
    expect(r.conclusion.title).toBe("消えた光"); // deterministic with seed "banish"
    const adv = kernel.call(b, "get_adventures", { character_id: cb }) as any;
    const ld = adv.adventures.find((x: any) => x.adventure_id === "last_drink");
    expect(ld.available).toBe(false);
    expect(ld.unavailable_reason).toContain("関係者が不在");
  });
});
