import * as eldia from "./initial/eldia.js";
import goblinVillage from "./scenarios/goblin_village.json" with { type: "json" };
import type { WorldDef } from "./types.js";

export * from "./types.js";

export const scenarioSources: unknown[] = [goblinVillage];

export const eldiaWorld: WorldDef = {
  id: eldia.WORLD_ID,
  name: eldia.WORLD_NAME,
  intro: eldia.INTRO,
  startLocation: "loc_riefen",
  locations: eldia.locations,
  npcs: eldia.npcs,
  items: eldia.items,
  monsters: eldia.monsters,
  spells: eldia.spells,
  facts: eldia.facts,
  classes: eldia.classes,
  races: eldia.races,
  scenarios: scenarioSources,
};
