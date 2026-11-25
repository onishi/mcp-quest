import { Kernel, compileWorld } from "@mcp-quest/kernel";
import { eldiaWorld } from "@mcp-quest/world";
import { memorySql } from "./sqlite.js";

export const compiled = await compileWorld(eldiaWorld);

export function makeKernel(opts: { now?: () => Date; seed?: () => string; rateLimitPerMinute?: number } = {}) {
  const sql = memorySql();
  const kernel = new Kernel({ sql, world: eldiaWorld, scenarios: compiled.scenarios, ...opts });
  kernel.init();
  return { kernel, sql };
}

let n = 0;
export function newPlayer(kernel: Kernel, name = "テスター") {
  const { code } = kernel.createInvite({ createdBy: "admin" });
  const { account_id } = kernel.redeemInvite({ code, displayName: name, issuer: "test", subject: `sub-${n++}-${Math.random()}` });
  return account_id;
}

let r = 0;
export const rid = () => `req-${r++}-${Math.floor(Math.random() * 1e9)}`;

export function newCharacter(kernel: Kernel, accountId: string, cls = "warrior") {
  const res = kernel.call(accountId, "create_character", { name: "アリア", race: "human", class: cls, request_id: rid() }) as {
    character: { character_id: string };
  };
  return res.character.character_id;
}
