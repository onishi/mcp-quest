/** Print ending distribution and turn counts from random-policy play (not a test). npx tsx tests/simulation/stats.ts */
import { hash53 } from "@mcp-quest/kernel";
import { compiled, makeKernel, newCharacter, newPlayer, rid } from "../helpers/world.js";

const CLASSES = ["warrior", "mage", "thief", "cleric"];
for (const s of compiled.scenarios) {
  const endings = new Map<string, number>();
  const turns: number[] = [];
  for (let seed = 1; seed <= 200; seed++) {
    let n = 0;
    const rnd = () => (hash53(`${seed}:${n++}`) % 10000) / 10000;
    const pick = (a: any[]) => a[Math.floor(rnd() * a.length) % a.length];
    const { kernel } = makeKernel({ seed: () => `st-${seed}` });
    const acc = newPlayer(kernel);
    const chr = newCharacter(kernel, acc, CLASSES[seed % 4]);
    const st = kernel.call(acc, "start_adventure", { character_id: chr, adventure_id: s.id, request_id: rid() }) as any;
    let turn = 0;
    for (let i = 0; i < 300; i++) {
      const { actions } = kernel.call(acc, "get_actions", { episode_id: st.episode_id }) as any;
      const a = pick(actions.filter((x: any) => x.action_id !== "withdraw"));
      const p: any = a.parameters;
      const params: Record<string, string> = {};
      if (a.action_id === "move") params.to = pick(p.to).id;
      if (["investigate", "attack"].includes(a.action_id)) params.target_id = pick(p.target_id).id;
      if (a.action_id === "talk") Object.assign(params, { target_id: pick(p.target_id).id, approach: pick(p.approach) });
      if (a.action_id === "interact") { const c = pick(p.choices); Object.assign(params, { target_id: c.target_id, option_id: c.option_id }); }
      if (a.action_id === "use_item") params.item_id = pick(p.item_id).id;
      if (a.action_id === "cast") { params.spell_id = pick(p.spell_id).id; if (p.target_id) params.target_id = pick(p.target_id).id; }
      try {
        const r = kernel.call(acc, "act", { episode_id: st.episode_id, action_id: a.action_id, parameters: params, expected_turn: turn, request_id: rid() }) as any;
        turn = r.turn;
        if (r.progress.episode_complete) { endings.set(r.conclusion.title, (endings.get(r.conclusion.title) ?? 0) + 1); turns.push(turn); break; }
      } catch {}
    }
  }
  turns.sort((a, b) => a - b);
  console.log(`${s.id}: median turns ${turns[Math.floor(turns.length / 2)]} (target ${s.targetTurns}, max ${s.maxTurns})`);
  for (const [k, v] of [...endings].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`);
}
