/** Game rules (spec §3.2). Pure functions over data; versioned. */
import type { Ability, ClassDef, ClassId, ItemDef, Race, RaceDef } from "@mcp-quest/world";

export const RULES_VERSION = "core-rules@0.1.0";
export const MAX_CREDITS = 3;
export const LEVEL_XP = 100;

export const SKILL_ABILITY: Record<string, Ability> = {
  athletics: "str",
  stealth: "dex",
  acrobatics: "dex",
  lore: "int",
  arcana: "int",
  perception: "per",
  insight: "wil",
  medicine: "wil",
  persuasion: "cha",
  intimidation: "cha",
  deception: "cha",
};

export const SKILL_NAMES: Record<string, string> = {
  athletics: "運動",
  stealth: "隠密",
  acrobatics: "軽業",
  lore: "伝承",
  arcana: "魔法学",
  perception: "知覚",
  insight: "洞察",
  medicine: "医術",
  persuasion: "説得",
  intimidation: "威圧",
  deception: "欺瞞",
};

export const ABILITY_NAMES: Record<Ability, string> = {
  str: "筋力",
  dex: "敏捷",
  int: "知力",
  wil: "意志",
  cha: "魅力",
  per: "知覚",
};

export interface CharacterSheet {
  character_id: string;
  account_id: string;
  name: string;
  race: Race;
  class: ClassId;
  background: string;
  abilities: Record<Ability, number>;
  trained_skills: string[];
  spells: string[];
  hp: number;
  max_hp: number;
  mp: number;
  max_mp: number;
  condition: "ok" | "wounded" | "down";
  items: Record<string, number>;
  equipped: { weapon: string; armor?: string };
  gold: number;
  xp: number;
  level: number;
  location: string;
  relations: Record<string, number>;
  revision: number;
}

export function buildCharacter(input: {
  characterId: string;
  accountId: string;
  name: string;
  race: RaceDef;
  cls: ClassDef;
  background: string;
  location: string;
}): CharacterSheet {
  const abilities = { ...input.cls.abilities };
  for (const [k, v] of Object.entries(input.race.bonus)) {
    const a = k as Ability;
    abilities[a] = Math.min(3, abilities[a] + (v ?? 0));
  }
  const items: Record<string, number> = {};
  for (const it of input.cls.startingItems) items[it] = (items[it] ?? 0) + 1;
  return {
    character_id: input.characterId,
    account_id: input.accountId,
    name: input.name,
    race: input.race.id,
    class: input.cls.id,
    background: input.background,
    abilities,
    trained_skills: [...input.cls.trainedSkills],
    spells: [...input.cls.spells],
    hp: input.cls.hp,
    max_hp: input.cls.hp,
    mp: input.cls.mp,
    max_mp: input.cls.mp,
    condition: "ok",
    items,
    equipped: { ...input.cls.equipped },
    gold: 10,
    xp: 0,
    level: 1,
    location: input.location,
    relations: {},
    revision: 0,
  };
}

export function skillModifier(c: CharacterSheet, skill: string): number {
  const ability = SKILL_ABILITY[skill] ?? "per";
  return c.abilities[ability] + (c.trained_skills.includes(skill) ? 2 : 0);
}

export function proficiency(c: CharacterSheet): number {
  return Math.floor((c.level - 1) / 2);
}

export function defense(c: CharacterSheet, itemsById: Map<string, ItemDef>, defending: boolean): number {
  const armor = c.equipped.armor ? (itemsById.get(c.equipped.armor)?.armor ?? 0) : 0;
  return 10 + c.abilities.dex + armor + (defending ? 4 : 0);
}

export function levelForXp(xp: number): number {
  return 1 + Math.floor(xp / LEVEL_XP);
}

export function difficultyLabel(dc: number): string {
  if (dc <= 8) return "容易";
  if (dc <= 12) return "普通";
  if (dc <= 16) return "困難";
  return "非常に困難";
}

export const RULE_TOPICS: Record<string, string> = {
  overview:
    "MCP Quest は、サーバーが事実・ダイス・報酬を確定し、あなたのAIがGMとして描写する短編TRPGです。1話は約10〜15回の意思決定で一区切りになります。",
  checks:
    "行動判定は d20 + 修正値 >= 難易度 で成功。修正値は能力値（-1〜+3）に、訓練済み技能なら +2。難易度の目安は 8 容易 / 12 普通 / 16 困難 / 20 非常に困難。判定の失敗も物語の一部で、振り直しはできません。",
  combat:
    "戦闘中は attack / cast / defend / flee / use_item / talk / withdraw が使えます。攻撃は d20 + 武器の能力値 + 習熟 >= 敵の防御で命中。あなたの行動後に敵が行動します。HPが0になると戦闘不能となり、冒険は救助で終わります（永久死亡はありません）。",
  magic:
    "呪文は職業ごとに習得済みのものだけ使えます。MPを消費します。火矢・聖撃は攻撃、癒しの祈りは回復、灯火は暗所を照らします。",
  credits:
    "冒険権は1日1回（日本時間午前4時）付与され、最大3回分まで貯まります。冒険の開始時に1消費し、中断からの再開では消費しません。閲覧や履歴の確認は冒険権を消費しません。",
  actions:
    "行動は get_actions で取得できる行動IDとパラメータで act に渡します。自由な発想はGMが既存の行動に対応付けてください。対応する行動がなければ UNSUPPORTED_ACTION となり、機能提案として記録されます。",
  growth: "経験値100ごとにレベルが上がり、最大HPが2増えます。2レベルごとに攻撃の習熟が+1されます。",
};
