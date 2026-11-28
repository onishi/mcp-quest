/**
 * Scenario DSL schema (schemaVersion 1).
 *
 * The DSL is a constrained JSON format. It intentionally has no expressions,
 * no code, no network/file access and no loops. Conditions and effects are
 * closed, registered vocabularies that the interpreter executes with hard
 * limits. See spec §5.5.
 */
import { z } from "zod";

export const SCHEMA_VERSION = 1;

const Id = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "id must be snake_case ascii");
const Text = z.string().min(1).max(2000);
const ShortText = z.string().min(1).max(200);

export const SkillSchema = z.enum([
  "athletics", // str
  "stealth", // dex
  "acrobatics", // dex
  "lore", // int
  "arcana", // int
  "perception", // per
  "insight", // wil
  "medicine", // wil
  "persuasion", // cha
  "intimidation", // cha
  "deception", // cha
]);
export type Skill = z.infer<typeof SkillSchema>;

/** Closed condition vocabulary. Evaluated by the interpreter; never eval'd. */
export type Cond =
  | { flag: string }
  | { clue: string }
  | { node: string }
  | { clock: string; gte: number }
  | { defeated: string }
  | { hasItem: string }
  | { goldGte: number }
  | { turnGte: number }
  | { combat: boolean }
  | { not: Cond }
  | { all: Cond[] }
  | { any: Cond[] };

export const CondSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ flag: Id }).strict(),
    z.object({ clue: Id }).strict(),
    z.object({ node: Id }).strict(),
    z.object({ clock: Id, gte: z.number().int().min(0).max(100) }).strict(),
    z.object({ defeated: Id }).strict(),
    z.object({ hasItem: Id }).strict(),
    z.object({ goldGte: z.number().int().min(0).max(10000) }).strict(),
    z.object({ turnGte: z.number().int().min(0).max(200) }).strict(),
    z.object({ combat: z.boolean() }).strict(),
    z.object({ not: CondSchema }).strict(),
    z.object({ all: z.array(CondSchema).min(1).max(16) }).strict(),
    z.object({ any: z.array(CondSchema).min(1).max(16) }).strict(),
  ]),
);

const DiceExpr = z.string().regex(/^\d{1,2}d(2|3|4|6|8|10|12|20)([+-]\d{1,2})?$|^\d{1,3}$/, "dice like 1d6+1 or a constant");

/** Closed effect vocabulary. */
export const EffectSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("reveal_clue"), id: Id }).strict(),
  z.object({ op: z.literal("set_flag"), id: Id }).strict(),
  z.object({ op: z.literal("clear_flag"), id: Id }).strict(),
  z.object({ op: z.literal("advance_clock"), id: Id, amount: z.number().int().min(1).max(10).default(1) }).strict(),
  z.object({ op: z.literal("move_to"), node: Id }).strict(),
  z.object({ op: z.literal("damage"), amount: DiceExpr }).strict(),
  z.object({ op: z.literal("heal"), amount: DiceExpr }).strict(),
  z.object({ op: z.literal("give_item"), item: Id, qty: z.number().int().min(1).max(5).default(1) }).strict(),
  z.object({ op: z.literal("take_item"), item: Id, qty: z.number().int().min(1).max(5).default(1) }).strict(),
  z.object({ op: z.literal("gold"), amount: z.number().int().min(-100).max(100) }).strict(),
  z.object({ op: z.literal("start_combat"), enemies: z.array(Id).min(1).max(4) }).strict(),
  z.object({ op: z.literal("end_combat") }).strict(),
  z.object({ op: z.literal("defeat"), enemy: Id }).strict(),
  z.object({ op: z.literal("narrate"), text: Text }).strict(),
  z.object({ op: z.literal("relation"), npc: Id, delta: z.number().int().min(-20).max(20) }).strict(),
]);
export type Effect = z.infer<typeof EffectSchema>;

export const CheckSchema = z
  .object({ skill: SkillSchema, difficulty: z.number().int().min(5).max(25) })
  .strict();
export type Check = z.infer<typeof CheckSchema>;

/**
 * investigate / talk / interact / use_item / move: specific affordances.
 * attempt: a free-form attempt the GM maps to a skill. `accepts` lists every
 * skill (and its difficulty) that can overcome this obstacle, so the same
 * problem can be solved in several ways.
 */
export const ActionKindSchema = z.enum(["investigate", "talk", "interact", "use_item", "move", "attempt"]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const ApproachSchema = z.enum(["friendly", "persuade", "intimidate", "deceive"]);
export type Approach = z.infer<typeof ApproachSchema>;

export const TriggerSchema = z
  .object({
    id: Id,
    action: ActionKindSchema,
    /** target id within the scene (for investigate/talk/interact/use_item) */
    target: Id.optional(),
    /** for interact: option id offered to the player */
    option: Id.optional(),
    /** label shown in get_actions for interact options */
    label: ShortText.optional(),
    /** for talk: restrict to an approach */
    approach: ApproachSchema.optional(),
    /** for use_item: the item that must be used */
    item: Id.optional(),
    /** nodes where the trigger is available (default: any node where target is present) */
    nodes: z.array(Id).max(16).optional(),
    when: CondSchema.optional(),
    once: z.boolean().default(false),
    check: CheckSchema.optional(),
    /** attempt only: skills that can overcome this obstacle, each with its own difficulty */
    accepts: z.array(CheckSchema).min(1).max(8).optional(),
    /** GM-only description of what this affordance represents (never shown as a menu) */
    gmHint: ShortText.optional(),
    text: Text.optional(),
    effects: z.array(EffectSchema).max(16).default([]),
    onSuccess: z.array(EffectSchema).max(16).default([]),
    onFailure: z.array(EffectSchema).max(16).default([]),
    successText: Text.optional(),
    failureText: Text.optional(),
  })
  .strict();
export type Trigger = z.infer<typeof TriggerSchema>;

export const TargetSchema = z
  .object({
    id: Id,
    name: ShortText,
    kind: z.enum(["npc", "object", "feature", "enemy"]),
    /** world entity this target refers to (e.g. npc_elena) */
    entity: Id.optional(),
    description: Text,
    visibleWhen: CondSchema.optional(),
  })
  .strict();

export const ExitSchema = z
  .object({ to: Id, label: ShortText, requires: CondSchema.optional(), lockedText: Text.optional() })
  .strict();

export const NodeSchema = z
  .object({
    id: Id,
    name: ShortText,
    location: Id,
    description: Text,
    targets: z.array(TargetSchema).max(16).default([]),
    exits: z.array(ExitSchema).max(8).default([]),
    onEnter: z.array(EffectSchema).max(8).default([]),
  })
  .strict();
export type SceneNode = z.infer<typeof NodeSchema>;

export const ClueSchema = z
  .object({
    id: Id,
    text: Text,
    /** a world fact this clue reveals to the character (knowledge) */
    fact: Id.optional(),
  })
  .strict();

export const ClockSchema = z
  .object({
    id: Id,
    name: ShortText,
    max: z.number().int().min(1).max(12),
    onFull: z.array(EffectSchema).max(8).default([]),
  })
  .strict();

export const EnemySchema = z
  .object({
    id: Id,
    name: ShortText,
    monster: Id,
  })
  .strict();

export const ObjectiveSchema = z
  .object({ id: Id, text: ShortText, required: z.boolean().default(false), doneWhen: CondSchema })
  .strict();

export const WorldEffectSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_fact"), fact: Id, visibility: z.enum(["public", "private"]).default("public") }).strict(),
  z.object({ op: z.literal("set_entity_status"), entity: Id, status: z.enum(["alive", "dead", "missing", "departed"]) }).strict(),
]);
export type WorldEffect = z.infer<typeof WorldEffectSchema>;

export const ResolutionSchema = z
  .object({
    id: Id,
    when: CondSchema,
    outcome: z.enum(["success", "partial", "failure", "withdrawn"]),
    title: ShortText,
    epilogue: Text,
    rewards: z
      .object({
        xp: z.number().int().min(0).max(200).default(0),
        gold: z.number().int().min(0).max(200).default(0),
        items: z.array(Id).max(4).default([]),
      })
      .strict()
      .default({ xp: 0, gold: 0, items: [] }),
    worldEffects: z.array(WorldEffectSchema).max(8).default([]),
  })
  .strict();
export type Resolution = z.infer<typeof ResolutionSchema>;

export const DependencySchema = z
  .object({ entity: Id, predicate: z.enum(["alive", "present"]) })
  .strict();

export const FallbackSchema = z
  .object({
    when: z.enum(["dependency_lost", "turn_limit", "character_down"]),
    mode: z.enum(["conclude", "offer_withdraw"]),
    /** resolution id used when mode=conclude */
    resolution: Id.optional(),
    followup: z.enum(["none", "daily_request"]).default("none"),
  })
  .strict();

/** Subtle nudges for the GM when the player seems stuck (spec §4.2 Pacing Director). */
export const HintSchema = z
  .object({
    id: Id,
    text: Text,
    /** offered only while this holds */
    when: CondSchema.optional(),
    /** stop offering once this holds */
    until: CondSchema.optional(),
  })
  .strict();

export const ScenarioSourceSchema = z
  .object({
    id: Id,
    version: z.number().int().min(1),
    schemaVersion: z.literal(SCHEMA_VERSION),
    title: ShortText,
    kind: z.enum(["combat", "investigation", "negotiation", "drama", "exploration", "mixed"]),
    difficulty: z.number().int().min(1).max(5),
    targetTurns: z.number().int().min(4).max(30),
    maxTurns: z.number().int().min(6).max(40),
    region: Id,
    hook: Text,
    publicSummary: Text,
    gmNotes: Text.optional(),
    tags: z.array(Id).max(12).default([]),
    eligibility: z
      .object({
        minLevel: z.number().int().min(1).max(20).default(1),
        requiresFacts: z.array(Id).max(8).default([]),
        forbidsFacts: z.array(Id).max(8).default([]),
      })
      .strict()
      .default({ minLevel: 1, requiresFacts: [], forbidsFacts: [] }),
    uniqueness: z.enum(["repeatable", "unique_per_character", "unique_world"]).default("unique_per_character"),
    dependencies: z.array(DependencySchema).max(8).default([]),
    objectives: z.array(ObjectiveSchema).min(1).max(8),
    initialNode: Id,
    nodes: z.array(NodeSchema).min(1).max(16),
    clues: z.array(ClueSchema).max(24).default([]),
    clocks: z.array(ClockSchema).max(4).default([]),
    enemies: z.array(EnemySchema).max(8).default([]),
    triggers: z.array(TriggerSchema).min(1).max(64),
    hints: z.array(HintSchema).max(16).default([]),
    resolutions: z.array(ResolutionSchema).min(1).max(12),
    fallbackPolicy: z.array(FallbackSchema).max(4).default([]),
    impactLimits: z
      .object({ maxXp: z.number().int().min(0).max(200), maxGold: z.number().int().min(0).max(200) })
      .strict(),
    sourceEventIds: z.array(z.string().max(64)).max(16).default([]),
  })
  .strict();

export type ScenarioSource = z.input<typeof ScenarioSourceSchema>;
export type Scenario = z.infer<typeof ScenarioSourceSchema>;

export interface CompiledScenario extends Scenario {
  digest: string;
  ruleVersions: Record<string, string>;
}
