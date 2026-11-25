import type { Kernel } from "@mcp-quest/kernel";
import { eldiaWorld } from "@mcp-quest/world";
import { describe, expect, it } from "vitest";
import { makeKernel, newCharacter, newPlayer, rid } from "../helpers/world.js";

function setup(adventure = "goblin_village", cls = "thief", seed?: string) {
  const { kernel, sql } = makeKernel(seed ? { seed: () => seed } : {});
  const acc = newPlayer(kernel);
  const chr = newCharacter(kernel, acc, cls);
  const s = kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: adventure, request_id: rid() }) as any;
  let turn = s.turn as number;
  const go = (action_id: string, parameters: Record<string, string> = {}) => {
    const r = kernel.call(acc, "act", { episode_id: s.episode_id, action_id, parameters, expected_turn: turn, request_id: rid() }) as any;
    turn = r.turn;
    return r;
  };
  return { kernel, sql, acc, chr, ep: s.episode_id as string, go };
}

describe("free-form play", () => {
  it("get_actions is GM material: verbs + affordances, no player-facing menu", () => {
    const { kernel, acc, ep, go } = setup();
    go("move", { to: "mine_entrance" });
    const a = kernel.call(acc, "get_actions", { episode_id: ep }) as any;
    expect(a.actions[0].action_id).toBe("attempt");
    expect(a.gm_note).toContain("一覧を見せない");
    const bypass = a.affordances.find((x: any) => x.via === "attempt" && x.target_id === "sentry_post");
    expect(bypass.skills).toEqual(expect.arrayContaining(["stealth", "deception", "acrobatics", "athletics"]));
    expect(JSON.stringify(a)).not.toMatch(/difficulty":\s*1[0-9]/); // no DCs leaked
  });

  it("the same obstacle can be overcome with different skills", () => {
    for (const skill of ["stealth", "deception", "acrobatics", "athletics"]) {
      const { go } = setup();
      go("move", { to: "mine_entrance" });
      const r = go("attempt", { target_id: "sentry_post", skill, intent: "見張りをどうにかする" });
      expect(r.result.checks[0].skill).toBe(skill);
      expect(r.narrative_license.level).toBe("embellish");
    }
  });

  it("social skills on an NPC route to the matching conversation trigger", () => {
    const { go } = setup();
    go("move", { to: "smithy" });
    const r = go("attempt", { target_id: "bran", skill: "persuasion", intent: "鉱山の話を聞かせてほしいと頼む" });
    expect(r.result.checks[0]).toMatchObject({ skill: "persuasion", difficulty: 12 });
  });

  it("anything else is a generic attempt: server rolls, GM narrates freely within limits, no story facts change", () => {
    const { kernel, acc, ep, go } = setup();
    const before = kernel.call(acc, "observe", { episode_id: ep }) as any;
    const r = go("attempt", { target_id: "notice_board", skill: "athletics", intent: "掲示板を逆立ちして眺める", difficulty: "hard" });
    expect(r.improvised.outcome).toMatch(/success|failure/);
    expect(r.result.checks[0].difficulty).toBe(16);
    expect(r.narrative_license.level).toBe("free");
    expect(r.narrative_license.must_not.join()).toContain("手がかり");
    expect(r.known_clues ?? r.revealed_clues).toEqual([]);
    expect(r.scene.node).toBe(before.scene.node);
  });

  it("trivial actions need no roll and do not consume the story budget", () => {
    const { go } = setup();
    let r: any;
    for (let i = 0; i < 30; i++) r = go("attempt", { intent: "エールを一杯頼む" });
    expect(r.result.checks).toHaveLength(0);
    expect(r.progress.story_turn).toBe(0);
    expect(r.progress.episode_complete).toBe(false);
  });

  it("there is still a hard cap so every episode ends", () => {
    const { go } = setup();
    let r: any;
    for (let i = 0; i < 48 && !r?.progress.episode_complete; i++) r = go("attempt", { intent: "ぼんやりする" });
    expect(r.progress.episode_complete).toBe(true);
  });

  it("free conversation returns in-character material from public data only", () => {
    const { go } = setup();
    go("talk", { target_id: "marta" }); // scripted briefing
    go("talk", { target_id: "marta" }); // scripted follow-up
    const r = go("talk", { target_id: "marta", topic: "昔の冒険の話" });
    expect(r.npc_reaction.manner).toBeDefined();
    expect(r.narrative_license.level).toBe("free");
    const marta = eldiaWorld.npcs.find((n) => n.id === "npc_marta")!;
    expect(marta.rumors).toContain(r.npc_reaction.may_mention);
  });

  it("improvised moves work in combat", () => {
    const { go } = setup("goblin_village", "warrior", "combat-seed");
    go("move", { to: "mine_entrance" });
    go("interact", { target_id: "sentry_post", option_id: "attack_sentry" });
    const r = go("attempt", { target_id: "sentry", skill: "athletics", intent: "盾で殴りつける" });
    expect(r.result.combat[0].kind).toBe("player_attack");
  });

  it("when the player is stuck, the GM receives a subtle nudge (not a menu)", () => {
    const { go } = setup();
    go("move", { to: "mine_entrance" });
    go("attempt", { intent: "空を見上げる" });
    const r = go("attempt", { intent: "あくびをする" });
    expect(r.gm_nudge.text).toContain("見張り");
    expect(r.gm_nudge.how).toContain("選択肢として列挙しない");
  });
});
