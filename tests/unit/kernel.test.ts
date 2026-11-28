import { DiceStream, GameError, type Kernel, nextDayBoundary, worldDay } from "@mcp-quest/kernel";
import { describe, expect, it } from "vitest";
import { makeKernel, newCharacter, newPlayer, rid } from "../helpers/world.js";

function expectError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe(code);
    return e as GameError;
  }
  throw new Error(`expected ${code}`);
}

function start(kernel: Kernel, acc: string, chr: string) {
  return kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: "goblin_village", request_id: rid() }) as any;
}

function act(kernel: Kernel, acc: string, ep: string, turn: number, action_id: string, parameters: Record<string, string> = {}, request_id = rid()) {
  return kernel.call(acc, "act", { episode_id: ep, action_id, parameters, expected_turn: turn, request_id }) as any;
}

describe("time", () => {
  it("world day switches at 04:00 JST", () => {
    expect(worldDay(new Date("2026-11-26T18:59:59Z"))).toBe("2026-11-26"); // 03:59 JST 27th
    expect(worldDay(new Date("2026-11-26T19:00:00Z"))).toBe("2026-11-27"); // 04:00 JST 27th
    expect(nextDayBoundary(new Date("2026-11-26T10:00:00Z"))).toBe("2026-11-26T19:00:00.000Z");
  });

  it("dice stream is deterministic per (seed, turn)", () => {
    const a = new DiceStream("seed", 3);
    const b = new DiceStream("seed", 3);
    const ra = [a.d20(), a.roll("2d6+1"), a.d20()];
    const rb = [b.d20(), b.roll("2d6+1"), b.d20()];
    expect(ra).toEqual(rb);
    expect(ra[0]).toBeGreaterThanOrEqual(1);
    expect(ra[0]).toBeLessThanOrEqual(20);
  });
});

describe("accounts and invites", () => {
  it("invites are single-use and identities are unique", () => {
    const { kernel } = makeKernel();
    const { code } = kernel.createInvite({ createdBy: "admin" });
    kernel.redeemInvite({ code, displayName: "A", issuer: "t", subject: "1" });
    expectError(() => kernel.redeemInvite({ code, displayName: "B", issuer: "t", subject: "2" }), "FORBIDDEN");
    expectError(() => kernel.redeemInvite({ code: "NOPE", displayName: "B", issuer: "t", subject: "2" }), "FORBIDDEN");
    const { code: c2 } = kernel.createInvite({ createdBy: "admin" });
    expectError(() => kernel.redeemInvite({ code: c2, displayName: "A", issuer: "t", subject: "1" }), "CONFLICT");
  });

  it("unknown account cannot call tools", () => {
    const { kernel } = makeKernel();
    expectError(() => kernel.call("acc_nobody", "get_my_account", {}), "AUTH_REQUIRED");
  });
});

describe("characters", () => {
  it("create_character is idempotent and enforces one character per account", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const req = rid();
    const a = kernel.call(acc, "create_character", { name: "アリア", race: "elf", class: "mage", request_id: req }) as any;
    const b = kernel.call(acc, "create_character", { name: "アリア", race: "elf", class: "mage", request_id: req }) as any;
    expect(b.replayed).toBe(true);
    expect(b.character.character_id).toBe(a.character.character_id);
    expectError(() => kernel.call(acc, "create_character", { name: "別人", race: "elf", class: "mage", request_id: req }), "IDEMPOTENCY_CONFLICT");
    expectError(() => kernel.call(acc, "create_character", { name: "別人", race: "dwarf", class: "warrior", request_id: rid() }), "CONFLICT");
    expect(a.character.abilities.per).toBe(2); // mage 1 + elf 1
    expect(a.character.spells.map((s: any) => s.id)).toContain("firebolt");
  });

  it("validates input", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    expectError(() => kernel.call(acc, "create_character", { name: "x", race: "orc", class: "mage", request_id: rid() }), "INVALID_INPUT");
    expectError(() => kernel.call(acc, "create_character", { name: "x", race: "elf", class: "mage", request_id: rid(), account_id: "spoof" }), "INVALID_INPUT");
  });

  it("other accounts cannot read or operate a character", () => {
    const { kernel } = makeKernel();
    const a = newPlayer(kernel);
    const b = newPlayer(kernel);
    const chr = newCharacter(kernel, a);
    expectError(() => kernel.call(b, "get_character", { character_id: chr }), "FORBIDDEN");
    expectError(() => kernel.call(b, "resume_game", { character_id: chr }), "FORBIDDEN");
    expectError(() => kernel.call(b, "start_adventure", { character_id: chr, adventure_id: "goblin_village", request_id: rid() }), "FORBIDDEN");
    const ep = start(kernel, a, chr);
    expectError(() => kernel.call(b, "observe", { episode_id: ep.episode_id }), "FORBIDDEN");
    expectError(() => act(kernel, b, ep.episode_id, 0, "withdraw"), "FORBIDDEN");
  });
});

describe("adventure credits", () => {
  it("1 credit initially, consumed on start, granted daily up to 3, resume is free", () => {
    let now = new Date("2026-11-26T03:00:00Z");
    const { kernel } = makeKernel({ now: () => now });
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    expect((kernel.call(acc, "get_play_budget", {}) as any).play_budget.adventure_credits).toBe(1);
    const req = rid();
    const ep = kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: "goblin_village", request_id: req }) as any;
    // Retransmission must not double-consume
    const again = kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: "goblin_village", request_id: req }) as any;
    expect(again.replayed).toBe(true);
    expect(again.episode_id).toBe(ep.episode_id);
    expect((kernel.call(acc, "get_play_budget", {}) as any).play_budget.adventure_credits).toBe(0);
    // Only one concurrent adventure
    expectError(() => start(kernel, acc, chr), "CONFLICT");
    // pause + resume: no credit consumed
    kernel.call(acc, "pause_adventure", { episode_id: ep.episode_id, request_id: rid() });
    const resumed = kernel.call(acc, "resume_game", { character_id: chr }) as any;
    expect(resumed.active_episode.episode_status).toBe("paused");
    const r = act(kernel, acc, ep.episode_id, 0, "investigate", { target_id: "notice_board" });
    expect(r.resumed_from_pause).toBe(true);
    expect((kernel.call(acc, "get_play_budget", {}) as any).play_budget.adventure_credits).toBe(0);
    act(kernel, acc, ep.episode_id, 1, "withdraw");
    expectError(() => start(kernel, acc, chr), "NO_ADVENTURE_CREDIT");
    // next world day (after 04:00 JST) grants 1; long absence caps at 3
    now = new Date("2026-11-26T19:30:00Z");
    expect((kernel.call(acc, "get_play_budget", {}) as any).play_budget.adventure_credits).toBe(1);
    now = new Date("2026-12-10T19:30:00Z");
    expect((kernel.call(acc, "get_play_budget", {}) as any).play_budget.adventure_credits).toBe(3);
  });
});

describe("act pipeline", () => {
  it("rejects stale turns, replays receipts without rerolling and rejects key reuse", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const ep = start(kernel, acc, chr);
    act(kernel, acc, ep.episode_id, 0, "move", { to: "mine_entrance" });
    expectError(() => act(kernel, acc, ep.episode_id, 0, "investigate", { target_id: "tracks" }), "STALE_STATE");
    const key = rid();
    const first = act(kernel, acc, ep.episode_id, 1, "investigate", { target_id: "tracks" }, key);
    const second = act(kernel, acc, ep.episode_id, 1, "investigate", { target_id: "tracks" }, key);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.turn).toBe(first.turn);
    expectError(() => act(kernel, acc, ep.episode_id, 1, "investigate", { target_id: "sentry_post" }, key), "IDEMPOTENCY_CONFLICT");
    // a new key on an already-consumed turn is stale
    expectError(() => act(kernel, acc, ep.episode_id, 1, "investigate", { target_id: "tracks" }), "STALE_STATE");
  });

  it("invalid actions do not change state", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const ep = start(kernel, acc, chr);
    expectError(() => act(kernel, acc, ep.episode_id, 0, "investigate", { target_id: "grik" }), "INVALID_ACTION");
    expectError(() => act(kernel, acc, ep.episode_id, 0, "attack", { target_id: "grik_enemy" }), "INVALID_ACTION");
    expectError(() => act(kernel, acc, ep.episode_id, 0, "move", { to: "goblin_camp" }), "INVALID_ACTION");
    expectError(() => act(kernel, acc, ep.episode_id, 0, "use_item", { item_id: "excalibur" }), "INVALID_ACTION");
    const obs = kernel.call(acc, "observe", { episode_id: ep.episode_id }) as any;
    expect(obs.turn).toBe(0);
  });

  it("locked exits explain why", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const ep = start(kernel, acc, chr);
    act(kernel, acc, ep.episode_id, 0, "move", { to: "mine_entrance" });
    const e = expectError(() => act(kernel, acc, ep.episode_id, 1, "move", { to: "upper_gallery" }), "INVALID_ACTION");
    expect(e.message).toContain("見張り");
  });

  it("unsupported actions are rejected and recorded as a daily feature request (max 1/day)", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const ep = start(kernel, acc, chr);
    const e = expectError(() => act(kernel, acc, ep.episode_id, 0, "tame_monster", { intent: "ゴブリンを手懐ける" }), "UNSUPPORTED_ACTION");
    expect((e.details.feature_request as any).recorded).toBe(true);
    const e2 = expectError(() => act(kernel, acc, ep.episode_id, 0, "build_house"), "UNSUPPORTED_ACTION");
    expect((e2.details.feature_request as any).recorded).toBe(false);
    expect(kernel.featureRequests()).toHaveLength(1);
    expect((kernel.call(acc, "observe", { episode_id: ep.episode_id }) as any).turn).toBe(0);
  });

  it("withdraw concludes the episode with a withdrawn outcome and small capped reward", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const ep = start(kernel, acc, chr);
    const r = act(kernel, acc, ep.episode_id, 0, "withdraw");
    expect(r.progress.episode_complete).toBe(true);
    expect(r.conclusion.outcome).toBe("withdrawn");
    expectError(() => act(kernel, acc, ep.episode_id, 1, "withdraw"), "INVALID_ACTION");
    // withdrawn adventures can be retried later
    const adv = kernel.call(acc, "get_adventures", { character_id: chr }) as any;
    expect(adv.adventures[0].available).toBe(true);
  });

  it("concludes deterministically via the duel path and pays rewards exactly once", () => {
    const { kernel } = makeKernel({ seed: () => "fixed-seed-1" });
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc, "warrior");
    const ep = start(kernel, acc, chr);
    const id = ep.episode_id;
    let turn = 0;
    const go = (a: string, p: Record<string, string> = {}) => {
      const r = act(kernel, acc, id, turn, a, p);
      turn = r.turn;
      return r;
    };
    go("move", { to: "smithy" });
    go("investigate", { target_id: "old_pickaxe" });
    const names = go("interact", { target_id: "bran", option_id: "ask_names" });
    expect(names.revealed_clues.map((c: any) => c.id)).toContain("c_bran_knows");
    expect(names.changes.items.mine_map).toBe(1);
    go("move", { to: "mine_entrance" });
    go("use_item", { item_id: "mine_map" });
    go("move", { to: "upper_gallery" });
    let r = go("move", { to: "goblin_camp" });
    if (!r.combat.active) r = go("interact", { target_id: "grik", option_id: "challenge_chief" });
    let guard = 0;
    while (!r.progress.episode_complete && guard++ < 30) {
      const enemies = r.combat.enemies.map((e: any) => e.id);
      if (r.combat.active) r = go("attack", { target_id: enemies.includes("grik_enemy") ? "grik_enemy" : enemies[0] });
      else r = go("interact", { target_id: "grik", option_id: "challenge_chief" });
    }
    expect(r.progress.episode_complete).toBe(true);
    const resolution = kernel.sql.all<{ resolution_id: string }>("SELECT resolution_id FROM episodes")[0]?.resolution_id;
    expect(["r_victory", "r_down", "r_timeout"]).toContain(resolution);
    const sheet = (kernel.call(acc, "get_character", { character_id: chr }) as any).character;
    expect(sheet.xp).toBe(r.conclusion.rewards.xp);
    expect(sheet.hp).toBeGreaterThanOrEqual(1);
    const xpRows = kernel.sql.all("SELECT * FROM world_events WHERE type = 'episode.completed'");
    expect(xpRows).toHaveLength(1);
  });
});

describe("dependency loss", () => {
  it("concludes partially with the predefined fallback and queues a daily replan request", () => {
    const { kernel, sql } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const ep = start(kernel, acc, chr);
    act(kernel, acc, ep.episode_id, 0, "move", { to: "mine_entrance" });
    sql.run("UPDATE entities SET status = 'dead' WHERE id = 'npc_grik'");
    const r = act(kernel, acc, ep.episode_id, 1, "investigate", { target_id: "tracks" });
    expect(r.progress.episode_complete).toBe(true);
    expect(r.conclusion.outcome).toBe("partial");
    expect(r.conclusion.reason).toBe("dependency_lost");
    const reqs = kernel.featureRequests() as any[];
    expect(JSON.parse(reqs[0].structured_intent).kind).toBe("replan");
    // and the scenario is no longer offered
    const adv = kernel.call(acc, "get_adventures", { character_id: chr }) as any;
    expect(adv.adventures[0].available).toBe(false);
  });
});

describe("moderation", () => {
  it("suspension and restrictions apply immediately and are audited", () => {
    const { kernel } = makeKernel();
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc);
    const { restriction_id } = kernel.addRestriction("admin", { accountId: acc, scope: "game:play", reason: "spam" });
    expectError(() => start(kernel, acc, chr), "RESTRICTED");
    expect(() => kernel.call(acc, "get_character", { character_id: chr })).not.toThrow();
    kernel.liftRestriction("admin", restriction_id, "appeal accepted");
    expect(() => start(kernel, acc, chr)).not.toThrow();
    kernel.setAccountStatus("admin", acc, "suspended", "abuse");
    expectError(() => kernel.call(acc, "get_my_account", {}), "RESTRICTED");
    kernel.setAccountStatus("admin", acc, "active", "restored");
    expect(() => kernel.call(acc, "get_my_account", {})).not.toThrow();
    const actions = (kernel.auditLog() as any[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["restriction.add", "restriction.lift", "account.suspend", "account.restore"]));
  });

  it("expired restrictions no longer apply", () => {
    let now = new Date("2026-11-26T00:00:00Z");
    const { kernel } = makeKernel({ now: () => now });
    const acc = newPlayer(kernel);
    kernel.addRestriction("admin", { accountId: acc, scope: "all", reason: "cooldown", expiresAt: "2026-11-26T01:00:00.000Z" });
    expectError(() => kernel.call(acc, "get_my_account", {}), "RESTRICTED");
    now = new Date("2026-11-26T02:00:00Z");
    expect(() => kernel.call(acc, "get_my_account", {})).not.toThrow();
  });

  it("rate limits per account", () => {
    const { kernel } = makeKernel({ rateLimitPerMinute: 3 });
    const acc = newPlayer(kernel);
    for (let i = 0; i < 3; i++) kernel.call(acc, "get_play_budget", {});
    const e = expectError(() => kernel.call(acc, "get_play_budget", {}), "RATE_LIMITED");
    expect(e.details.retry_after).toBeGreaterThan(0);
  });
});

describe("identity linking (legacy access key → Google)", () => {
  it("moves the account to the new identity and retires the old one", () => {
    const { kernel } = makeKernel();
    const { code } = kernel.createInvite({ createdBy: "admin" });
    const { account_id } = kernel.redeemInvite({ code, displayName: "旧", issuer: "mcp-quest:key", subject: "keyhash" });
    const linked = kernel.linkIdentity({ fromIssuer: "mcp-quest:key", fromSubject: "keyhash", toIssuer: "https://accounts.google.com", toSubject: "g-123" });
    expect(linked.account_id).toBe(account_id);
    expect(kernel.resolveIdentity("https://accounts.google.com", "g-123")).toBe(account_id);
    expect(kernel.resolveIdentity("mcp-quest:key", "keyhash")).toBeUndefined();
    expect((kernel.auditLog() as any[]).some((a) => a.action === "identity.link")).toBe(true);
  });

  it("rejects unknown keys and identities already in use", () => {
    const { kernel } = makeKernel();
    expectError(() => kernel.linkIdentity({ fromIssuer: "mcp-quest:key", fromSubject: "nope", toIssuer: "g", toSubject: "1" }), "FORBIDDEN");
    const a = kernel.createInvite({ createdBy: "admin" });
    kernel.redeemInvite({ code: a.code, displayName: "A", issuer: "mcp-quest:key", subject: "k1" });
    const b = kernel.createInvite({ createdBy: "admin" });
    kernel.redeemInvite({ code: b.code, displayName: "B", issuer: "g", subject: "taken" });
    expectError(() => kernel.linkIdentity({ fromIssuer: "mcp-quest:key", fromSubject: "k1", toIssuer: "g", toSubject: "taken" }), "CONFLICT");
    expect(kernel.resolveIdentity("mcp-quest:key", "k1")).toBeDefined();
  });
});
