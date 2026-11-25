/**
 * Compile every shipped scenario and print a report. Fails on any error.
 *   npm run check:scenarios
 */
import { compileWorld } from "@mcp-quest/kernel";
import { eldiaWorld } from "@mcp-quest/world";

const { scenarios, warnings } = await compileWorld(eldiaWorld);
for (const s of scenarios) {
  const endings = s.resolutions.map((r) => `${r.id}(${r.outcome})`).join(", ");
  console.log(`✓ ${s.id}@${s.version} "${s.title}" nodes=${s.nodes.length} triggers=${s.triggers.length} turns=${s.targetTurns}/${s.maxTurns} digest=${s.digest.slice(0, 12)}`);
  console.log(`    endings: ${endings}`);
}
for (const w of warnings) for (const i of w.issues) console.log(`  ⚠ ${w.scenario} ${i.path}: ${i.message}`);
console.log(`${scenarios.length} scenario(s) compiled.`);
