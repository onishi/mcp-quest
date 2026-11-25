import { eldiaWorld } from "@mcp-quest/world";
import { describe, expect, it } from "vitest";
import { makeKernel, newCharacter, newPlayer, rid } from "../helpers/world.js";

const SECRET_STRINGS = [
  ...eldiaWorld.npcs.flatMap((n) => [...n.secrets, ...n.goals, ...n.fears]),
  ...eldiaWorld.facts.filter((f) => f.visibility === "secret").map((f) => f.text),
].filter((s) => s.length >= 6); // very short words (e.g. 盗賊) collide with public vocabulary

describe("player responses never leak server-only data", () => {
  it("resume/observe/actions/adventures/character contain no NPC secrets or unrevealed secret facts", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const outputs: unknown[] = [];
    outputs.push(kernel.call(acc, "resume_game", { character_id: chr }));
    outputs.push(kernel.call(acc, "get_adventures", { character_id: chr }));
    const ep = kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: "goblin_village", request_id: rid() }) as any;
    outputs.push(ep);
    outputs.push(kernel.call(acc, "observe", { episode_id: ep.episode_id }));
    outputs.push(kernel.call(acc, "get_actions", { episode_id: ep.episode_id }));
    outputs.push(kernel.call(acc, "inspect", { episode_id: ep.episode_id, target_id: "marta" }));
    outputs.push(kernel.call(acc, "get_character", { character_id: chr }));
    outputs.push(kernel.call(acc, "get_rules", {}));
    for (let i = 0; i < 4; i++) {
      const obs = kernel.call(acc, "observe", { episode_id: ep.episode_id }) as any;
      outputs.push(kernel.call(acc, "act", { episode_id: ep.episode_id, action_id: "talk", parameters: { target_id: "marta", topic: "噂話" }, expected_turn: obs.turn, request_id: rid() }));
    }
    const text = JSON.stringify(outputs);
    for (const secret of SECRET_STRINGS) expect(text, `leaked: ${secret}`).not.toContain(secret);
    // Internal fields of the scenario (seed, triggers, resolutions) are never returned.
    expect(text).not.toContain("rng_seed");
    expect(text).not.toContain("onSuccess");
    expect(text).not.toContain("r_victory");
  });

  it("the public snapshot only contains public facts", () => {
    const { kernel } = makeKernel();
    const snap = JSON.stringify(kernel.publicSnapshot());
    for (const secret of SECRET_STRINGS) expect(snap).not.toContain(secret);
  });

  it("tool input cannot carry an account id (identity comes from auth only)", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    expect(() => kernel.call(acc, "get_my_account", { account_id: "acc_other" })).toThrow();
  });
});
