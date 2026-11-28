import * as eldia from "./initial/eldia.js";
import glowingWell from "./scenarios/glowing_well.json" with { type: "json" };
import goblinVillage from "./scenarios/goblin_village.json" with { type: "json" };
import lastDrink from "./scenarios/last_drink.json" with { type: "json" };
import lyingMerchant from "./scenarios/lying_merchant.json" with { type: "json" };
import missingHerbalist from "./scenarios/missing_herbalist.json" with { type: "json" };
import type { WorldDef } from "./types.js";

export * from "./types.js";

export const scenarioSources: unknown[] = [goblinVillage, missingHerbalist, lastDrink, glowingWell, lyingMerchant];

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
