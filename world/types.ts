export type Ability = "str" | "dex" | "int" | "wil" | "cha" | "per";
export type Race = "human" | "elf" | "dwarf";
export type ClassId = "warrior" | "mage" | "thief" | "cleric";

export interface LocationDef {
  id: string;
  name: string;
  description: string;
  region: string;
}

export interface NpcDef {
  id: string;
  name: string;
  role: string;
  location: string;
  publicProfile: string;
  /** server-only; never returned to players */
  goals: string[];
  fears: string[];
  secrets: string[];
}

export interface ItemDef {
  id: string;
  name: string;
  kind: "weapon" | "armor" | "consumable" | "tool" | "treasure" | "quest";
  description: string;
  value: number;
  /** weapon damage dice, e.g. 1d8 */
  damage?: string;
  /** ability used for weapon attacks */
  attackAbility?: Ability;
  armor?: number;
  /** consumable effect */
  heal?: string;
}

export interface MonsterDef {
  id: string;
  name: string;
  hp: number;
  defense: number;
  attack: number;
  damage: string;
  description: string;
}

export interface SpellDef {
  id: string;
  name: string;
  classes: ClassId[];
  mpCost: number;
  kind: "attack" | "heal" | "utility";
  dice?: string;
  ability: Ability;
  description: string;
}

export interface FactDef {
  id: string;
  text: string;
  /** public: anyone may learn; secret: only via in-game discovery */
  visibility: "public" | "secret";
  /** initially true in the world */
  initial?: boolean;
}

export interface ClassDef {
  id: ClassId;
  name: string;
  abilities: Record<Ability, number>;
  hp: number;
  mp: number;
  trainedSkills: string[];
  startingItems: string[];
  equipped: { weapon: string; armor?: string };
  spells: string[];
}

export interface RaceDef {
  id: Race;
  name: string;
  bonus: Partial<Record<Ability, number>>;
  description: string;
}

export interface WorldDef {
  id: string;
  name: string;
  intro: string;
  startLocation: string;
  locations: LocationDef[];
  npcs: NpcDef[];
  items: ItemDef[];
  monsters: MonsterDef[];
  spells: SpellDef[];
  facts: FactDef[];
  classes: ClassDef[];
  races: RaceDef[];
  scenarios: unknown[];
}
