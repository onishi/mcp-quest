/**
 * World Kernel: the single authority over game state (spec §1.4, §13).
 *
 * - No LLM calls, no network. Everything here is deterministic program logic.
 * - Every state-changing command runs in one SQLite transaction that writes
 *   state, world_events, command_receipts and outbox together.
 */
import {
  type CompiledScenario,
  type EffectOutput,
  type EpisodeState,
  type Host,
  type Resolution,
  type Trigger,
  applyEffects,
  availableExits,
  currentNode,
  eligibleTriggers,
  emptyOutput,
  evalCond,
  findResolution,
  initialState,
  markDefeated,
  objectiveStatus,
  visibleTargets,
} from "@mcp-quest/scenario-dsl";
import type { ClassId, ItemDef, MonsterDef, Race, SpellDef, WorldDef } from "@mcp-quest/world";
import { z } from "zod";
import { KERNEL_VERSION, type Sql, migrate, one } from "./db.js";
import { GameError } from "./errors.js";
import {
  type CharacterSheet,
  MAX_CREDITS,
  RULES_VERSION,
  RULE_TOPICS,
  SKILL_ABILITY,
  SKILL_NAMES,
  buildCharacter,
  defense,
  difficultyLabel,
  levelForXp,
  proficiency,
  skillModifier,
} from "./rules.js";
import { GM_INSTRUCTIONS, TOOL_BY_NAME } from "./tools.js";
import { DiceStream, daysBetween, nextDayBoundary, payloadHash, randomId, randomSeed, worldDay } from "./util.js";

export interface KernelOptions {
  sql: Sql;
  world: WorldDef;
  scenarios: CompiledScenario[];
  now?: () => Date;
  /** per-account tool calls per minute (technical rate limit, not game credits) */
  rateLimitPerMinute?: number;
  /** RNG seed source for new episodes (tests/simulation inject a fixed source). */
  seed?: () => string;
}

interface AccountRow {
  account_id: string;
  display_name: string;
  role: string;
  status: string;
  trust_level: string;
  created_at: string;
}

interface EpisodeRow {
  episode_id: string;
  character_id: string;
  account_id: string;
  scenario_id: string;
  scenario_version: number;
  scenario_digest: string;
  status: "active" | "paused" | "completed";
  phase: string;
  turn: number;
  state: string;
  rng_seed: string;
  rule_versions: string;
  outcome: string | null;
  resolution_id: string | null;
  summary: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CombatExtra {
  defending?: boolean;
}

type Json = Record<string, unknown>;

const COMPONENTS = [
  "owner",
  "profile",
  "abilities",
  "skills",
  "vitals",
  "inventory",
  "wallet",
  "progress",
  "location",
  "relations",
] as const;

const ComponentSchemas: Record<(typeof COMPONENTS)[number], z.ZodType> = {
  owner: z.object({ account_id: z.string() }),
  profile: z.object({ name: z.string().max(24), race: z.string(), class: z.string(), background: z.string().max(300) }),
  abilities: z.record(z.string(), z.number().int().min(-3).max(5)),
  skills: z.object({ trained: z.array(z.string()), spells: z.array(z.string()) }),
  vitals: z.object({
    hp: z.number().int().min(0),
    max_hp: z.number().int().min(1),
    mp: z.number().int().min(0),
    max_mp: z.number().int().min(0),
    condition: z.enum(["ok", "wounded", "down"]),
  }),
  inventory: z.object({
    items: z.record(z.string(), z.number().int().min(1).max(99)),
    equipped: z.object({ weapon: z.string(), armor: z.string().optional() }),
  }),
  wallet: z.object({ gold: z.number().int().min(0).max(1_000_000) }),
  progress: z.object({ xp: z.number().int().min(0), level: z.number().int().min(1) }),
  location: z.object({ id: z.string() }),
  relations: z.record(z.string(), z.number().int().min(-100).max(100)),
};

const ACTION_IDS = ["attempt", "talk", "move", "investigate", "interact", "use_item", "attack", "cast", "defend", "flee", "withdraw"] as const;
type ActionId = (typeof ACTION_IDS)[number];
const APPROACHES = ["friendly", "persuade", "intimidate", "deceive"] as const;
const LIGHT_ITEMS = new Set(["torch", "lantern"]);
const SOCIAL_APPROACH: Record<string, string> = { persuasion: "persuade", intimidation: "intimidate", deception: "deceive", insight: "friendly" };
const INVESTIGATIVE = new Set(["perception", "lore", "arcana", "insight", "medicine"]);
const DIFFICULTY: Record<string, number> = { trivial: 0, easy: 8, normal: 12, hard: 16, very_hard: 20 };
/** turns without story progress before the GM receives a subtle nudge */
const STALL_TURNS = 2;

/** What the client AI may and may not invent when narrating a result. */
const LICENSE = {
  embellish: {
    level: "embellish",
    may: ["確定した結果の情景・台詞・感情を脚色する", "NPCの口調や仕草を演じる"],
    must_not: ["結果（成否・ダメージ・入手物）を変える", "サーバーが返していない手がかり・秘密・報酬・約束を作る"],
  },
  free: {
    level: "free",
    may: [
      "試みの過程と結果を自由に描写する（成否はサーバーの判定に従う）",
      "場面に自然に存在する小物・風景・群衆・その場限りの会話を創作する",
      "NPCを publicProfile と manner に沿って演じる",
    ],
    must_not: [
      "新しい手がかり・世界の事実・NPCの秘密を確定させる",
      "アイテム・お金・経験値・関係の変化を与える",
      "敵を倒す、出口を開く、冒険を決着させる",
    ],
  },
} as const;

export class Kernel {
  readonly sql: Sql;
  readonly world: WorldDef;
  private readonly now: () => Date;
  private readonly scenarios = new Map<string, CompiledScenario>();
  private readonly items: Map<string, ItemDef>;
  private readonly monsters: Map<string, MonsterDef>;
  private readonly spells: Map<string, SpellDef>;
  private readonly rate = new Map<string, { windowStart: number; count: number }>();
  private readonly rateLimit: number;
  private readonly seedSource: () => string;

  constructor(opts: KernelOptions) {
    this.sql = opts.sql;
    this.world = opts.world;
    this.now = opts.now ?? (() => new Date());
    this.rateLimit = opts.rateLimitPerMinute ?? 120;
    this.seedSource = opts.seed ?? randomSeed;
    for (const s of opts.scenarios) this.scenarios.set(`${s.id}@${s.version}`, s);
    this.items = new Map(opts.world.items.map((i) => [i.id, i]));
    this.monsters = new Map(opts.world.monsters.map((m) => [m.id, m]));
    this.spells = new Map(opts.world.spells.map((s) => [s.id, s]));
  }

  // ---------------------------------------------------------------- setup

  /** Idempotent: migrate schema, seed the world and register compiled scenarios. */
  init(): void {
    migrate(this.sql);
    const nowIso = this.iso();
    this.sql.transaction(() => {
      if (!one(this.sql, "SELECT value FROM meta WHERE key = 'world_id'")) {
        this.sql.run("INSERT INTO meta (key, value) VALUES ('world_id', ?)", this.world.id);
        this.sql.run("INSERT INTO meta (key, value) VALUES ('kernel_version', ?)", KERNEL_VERSION);
        this.sql.run("INSERT INTO meta (key, value) VALUES ('created_at', ?)", nowIso);
      } else {
        const wid = one<{ value: string }>(this.sql, "SELECT value FROM meta WHERE key = 'world_id'");
        if (wid?.value !== this.world.id) throw new Error(`world id mismatch: db=${wid?.value} code=${this.world.id}`);
      }
      for (const l of this.world.locations)
        this.sql.run("INSERT OR IGNORE INTO entities (id, type, name, status, created_at) VALUES (?, 'location', ?, 'present', ?)", l.id, l.name, nowIso);
      for (const n of this.world.npcs)
        this.sql.run("INSERT OR IGNORE INTO entities (id, type, name, status, created_at) VALUES (?, 'npc', ?, 'alive', ?)", n.id, n.name, nowIso);
      for (const f of this.world.facts.filter((x) => x.initial))
        this.sql.run(
          "INSERT OR IGNORE INTO facts (id, text, status, visibility, established_at) VALUES (?, ?, 'established', ?, ?)",
          f.id,
          f.text,
          f.visibility,
          nowIso,
        );
      for (const s of this.scenarios.values()) {
        const existing = one<{ digest: string }>(this.sql, "SELECT digest FROM scenarios WHERE id = ? AND version = ?", s.id, s.version);
        if (existing && existing.digest !== s.digest)
          throw new Error(`scenario ${s.id}@${s.version} changed without a version bump (digest mismatch)`);
        if (!existing)
          this.sql.run(
            "INSERT INTO scenarios (id, version, schema_version, digest, compiled, status, registered_at) VALUES (?, ?, ?, ?, ?, 'published', ?)",
            s.id,
            s.version,
            s.schemaVersion,
            s.digest,
            JSON.stringify(s),
            nowIso,
          );
      }
    });
  }

  // ------------------------------------------------------------ accounts

  resolveIdentity(issuer: string, subject: string): string | undefined {
    return one<{ account_id: string }>(this.sql, "SELECT account_id FROM identities WHERE issuer = ? AND subject = ?", issuer, subject)
      ?.account_id;
  }

  createInvite(input: { createdBy: string; maxUses?: number; expiresAt?: string; code?: string }): { code: string } {
    const code = input.code ?? randomId("inv").replace("inv_", "").toUpperCase();
    this.sql.transaction(() => {
      this.sql.run(
        "INSERT INTO invites (code, max_uses, uses, expires_at, created_by, created_at) VALUES (?, ?, 0, ?, ?, ?)",
        code,
        input.maxUses ?? 1,
        input.expiresAt ?? null,
        input.createdBy,
        this.iso(),
      );
      this.audit(input.createdBy, "invite.create", code, null, { maxUses: input.maxUses ?? 1 });
    });
    return { code };
  }

  /** Redeem an invite and bind a new account to (issuer, subject). */
  redeemInvite(input: { code: string; displayName: string; issuer: string; subject: string; role?: string }): { account_id: string } {
    const name = sanitizeName(input.displayName, 32);
    return this.sql.transaction(() => {
      if (this.resolveIdentity(input.issuer, input.subject)) throw new GameError("CONFLICT", "この認証情報は既にアカウントに紐付いています。");
      const inv = one<{ code: string; max_uses: number; uses: number; expires_at: string | null }>(
        this.sql,
        "SELECT * FROM invites WHERE code = ?",
        input.code,
      );
      if (!inv) throw new GameError("FORBIDDEN", "招待コードが無効です。");
      if (inv.uses >= inv.max_uses) throw new GameError("FORBIDDEN", "招待コードは使用済みです。");
      if (inv.expires_at && inv.expires_at < this.iso()) throw new GameError("FORBIDDEN", "招待コードの期限が切れています。");
      const accountId = randomId("acc");
      this.sql.run("UPDATE invites SET uses = uses + 1 WHERE code = ?", input.code);
      this.sql.run(
        "INSERT INTO accounts (account_id, display_name, role, status, trust_level, created_at) VALUES (?, ?, ?, 'active', 'newcomer', ?)",
        accountId,
        name,
        input.role ?? "player",
        this.iso(),
      );
      this.sql.run(
        "INSERT INTO identities (issuer, subject, account_id, created_at) VALUES (?, ?, ?, ?)",
        input.issuer,
        input.subject,
        accountId,
        this.iso(),
      );
      this.sql.run(
        "INSERT INTO adventure_credits (account_id, balance, last_granted_day, version) VALUES (?, 1, ?, 0)",
        accountId,
        this.today(),
      );
      this.audit(accountId, "account.create", accountId, null, { invite: input.code });
      return { account_id: accountId };
    });
  }

  /**
   * Move an account from one identity to another (e.g. legacy access key →
   * Google). Both identities must have been verified by the caller; the old
   * identity is removed so it can no longer sign in.
   */
  linkIdentity(input: { fromIssuer: string; fromSubject: string; toIssuer: string; toSubject: string }): { account_id: string } {
    return this.sql.transaction(() => {
      const accountId = this.resolveIdentity(input.fromIssuer, input.fromSubject);
      if (!accountId) throw new GameError("FORBIDDEN", "引き継ぎ元のアカウントが見つかりません。");
      if (this.resolveIdentity(input.toIssuer, input.toSubject))
        throw new GameError("CONFLICT", "このログイン手段は既に別のアカウントに紐付いています。");
      this.sql.run(
        "INSERT INTO identities (issuer, subject, account_id, created_at) VALUES (?, ?, ?, ?)",
        input.toIssuer,
        input.toSubject,
        accountId,
        this.iso(),
      );
      this.sql.run("DELETE FROM identities WHERE issuer = ? AND subject = ?", input.fromIssuer, input.fromSubject);
      this.audit(accountId, "identity.link", accountId, null, { from: input.fromIssuer, to: input.toIssuer });
      return { account_id: accountId };
    });
  }

  // --------------------------------------------------------------- admin

  setAccountStatus(actor: string, accountId: string, status: "active" | "suspended", reason: string) {
    this.sql.transaction(() => {
      this.mustAccount(accountId);
      this.sql.run("UPDATE accounts SET status = ? WHERE account_id = ?", status, accountId);
      this.audit(actor, `account.${status === "active" ? "restore" : "suspend"}`, accountId, reason);
    });
  }

  addRestriction(actor: string, input: { accountId: string; scope: string; reason: string; expiresAt?: string }) {
    const id = randomId("rst");
    this.sql.transaction(() => {
      this.mustAccount(input.accountId);
      this.sql.run(
        "INSERT INTO restrictions (id, account_id, scope, reason, expires_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        input.accountId,
        input.scope,
        input.reason,
        input.expiresAt ?? null,
        this.iso(),
        actor,
      );
      this.audit(actor, "restriction.add", input.accountId, input.reason, { id, scope: input.scope, expiresAt: input.expiresAt });
    });
    return { restriction_id: id };
  }

  liftRestriction(actor: string, restrictionId: string, reason: string) {
    this.sql.transaction(() => {
      const r = one<{ account_id: string }>(this.sql, "SELECT account_id FROM restrictions WHERE id = ?", restrictionId);
      if (!r) throw new GameError("NOT_FOUND", "制限が見つかりません。");
      this.sql.run("UPDATE restrictions SET lifted_at = ? WHERE id = ?", this.iso(), restrictionId);
      this.audit(actor, "restriction.lift", r.account_id, reason, { id: restrictionId });
    });
  }

  /** Refund one credit for an administrative reason (server failure etc.), audited. */
  refundCredit(actor: string, accountId: string, reason: string) {
    this.sql.transaction(() => {
      const c = this.credits(accountId, true);
      this.sql.run(
        "UPDATE adventure_credits SET balance = ?, version = version + 1 WHERE account_id = ?",
        Math.min(MAX_CREDITS, c.balance + 1),
        accountId,
      );
      this.audit(actor, "credit.refund", accountId, reason);
    });
  }

  listAccounts() {
    return this.sql.all<AccountRow>("SELECT * FROM accounts ORDER BY created_at");
  }

  getAccountActivity(accountId: string, limit = 50) {
    return {
      account: this.mustAccount(accountId),
      restrictions: this.sql.all("SELECT * FROM restrictions WHERE account_id = ? ORDER BY created_at DESC", accountId),
      events: this.sql.all(
        "SELECT seq, event_id, type, episode_id, world_day, created_at FROM world_events WHERE account_id = ? ORDER BY seq DESC LIMIT ?",
        accountId,
        limit,
      ),
    };
  }

  auditLog(limit = 100) {
    return this.sql.all("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?", limit);
  }

  featureRequests(limit = 100) {
    return this.sql.all("SELECT * FROM feature_requests ORDER BY created_at DESC LIMIT ?", limit);
  }

  /** Events waiting for public projection (consumed by chronicle in later phases). */
  pendingOutbox(limit = 100) {
    return this.sql.all(
      "SELECT o.event_id, o.destination, e.type, e.payload, e.world_day FROM outbox o JOIN world_events e ON e.event_id = o.event_id WHERE o.status = 'pending' ORDER BY e.seq LIMIT ?",
      limit,
    );
  }

  publicSnapshot() {
    return {
      world: { id: this.world.id, name: this.world.name, intro: this.world.intro, day: this.today() },
      facts: this.sql.all<{ id: string; text: string; established_at: string }>(
        "SELECT id, text, established_at FROM facts WHERE visibility = 'public' ORDER BY established_at DESC",
      ),
      recent: this.sql
        .all<{ payload: string; world_day: string; type: string }>(
          "SELECT payload, world_day, type FROM world_events WHERE visibility = 'public' ORDER BY seq DESC LIMIT 20",
        )
        .map((r) => ({ type: r.type, world_day: r.world_day, summary: (JSON.parse(r.payload) as Json).summary })),
      stats: {
        accounts: one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM accounts")?.n ?? 0,
        completed_adventures: one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM episodes WHERE status = 'completed'")?.n ?? 0,
      },
    };
  }

  // ----------------------------------------------------------- dispatch

  /**
   * Entry point for Player MCP tools. `accountId` must come from verified
   * auth (OAuth props), never from tool input.
   */
  call(accountId: string, tool: string, rawInput: unknown): Json {
    const def = TOOL_BY_NAME.get(tool);
    if (!def) throw new GameError("NOT_FOUND", `unknown tool ${tool}`);
    const parsed = z.object(def.input).strict().safeParse(rawInput ?? {});
    if (!parsed.success)
      throw new GameError("INVALID_INPUT", "入力が不正です。", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    this.checkRate(accountId);
    const input = parsed.data as Json;
    this.requireAccess(accountId, def.write ? "game:play" : "game:read");
    switch (tool) {
      case "get_my_account":
        return this.getMyAccount(accountId);
      case "list_characters":
        return this.listCharacters(accountId);
      case "create_character":
        return this.idempotent(accountId, tool, input, () => this.createCharacter(accountId, input));
      case "resume_game":
        return this.resumeGame(accountId, String(input.character_id));
      case "get_adventures":
        return this.getAdventures(accountId, String(input.character_id));
      case "start_adventure":
        return this.idempotent(accountId, tool, input, () =>
          this.startAdventure(accountId, String(input.character_id), String(input.adventure_id)),
        );
      case "observe":
        return this.observe(accountId, String(input.episode_id));
      case "inspect":
        return this.inspect(accountId, String(input.episode_id), String(input.target_id));
      case "get_actions":
        return this.getActions(accountId, String(input.episode_id));
      case "act":
        return this.act(accountId, input as unknown as ActInput);
      case "pause_adventure":
        return this.idempotent(accountId, tool, input, () => this.pauseAdventure(accountId, String(input.episode_id)));
      case "get_character":
        return { character: this.publicSheet(this.ownedCharacter(accountId, String(input.character_id))) };
      case "get_history":
        return this.getHistory(accountId, String(input.character_id), input.cursor as number | undefined, input.limit as number | undefined);
      case "get_play_budget":
        return { play_budget: this.playBudget(accountId) };
      case "get_rules":
        return this.getRules(input.topic as string | undefined);
      case "rate_adventure":
        return this.rateAdventure(accountId, input);
      default:
        throw new GameError("NOT_FOUND", `unknown tool ${tool}`);
    }
  }

  // ------------------------------------------------------- access control

  private checkRate(accountId: string) {
    const nowMs = this.now().getTime();
    const r = this.rate.get(accountId);
    if (!r || nowMs - r.windowStart >= 60_000) {
      this.rate.set(accountId, { windowStart: nowMs, count: 1 });
      return;
    }
    r.count++;
    if (r.count > this.rateLimit)
      throw new GameError("RATE_LIMITED", "短時間に呼び出しが多すぎます。", {
        retry_after: Math.ceil((r.windowStart + 60_000 - nowMs) / 1000),
      });
  }

  private mustAccount(accountId: string): AccountRow {
    const a = one<AccountRow>(this.sql, "SELECT * FROM accounts WHERE account_id = ?", accountId);
    if (!a) throw new GameError("AUTH_REQUIRED", "アカウントが見つかりません。");
    return a;
  }

  private activeRestrictions(accountId: string) {
    const nowIso = this.iso();
    return this.sql.all<{ id: string; scope: string; reason: string; expires_at: string | null }>(
      "SELECT id, scope, reason, expires_at FROM restrictions WHERE account_id = ? AND lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
      accountId,
      nowIso,
    );
  }

  /** Checked on every call so suspensions/restrictions apply immediately (spec §15). */
  private requireAccess(accountId: string, scope: "game:read" | "game:play") {
    const a = this.mustAccount(accountId);
    if (a.status !== "active") throw new GameError("RESTRICTED", "アカウントは停止されています。", { status: a.status });
    const write = scope === "game:play";
    const r = this.activeRestrictions(accountId).find(
      (x) => x.scope === "all" || (write && (x.scope === "game:play" || x.scope === "read_only")),
    );
    if (r)
      throw new GameError("RESTRICTED", "この操作は制限されています。", {
        restriction: { scope: r.scope, reason: r.reason, expires_at: r.expires_at },
        appeal: "運営への問い合わせで異議申し立てができます。",
      });
  }

  // --------------------------------------------------------- idempotency

  private idempotent(accountId: string, tool: string, input: Json, fn: () => Json): Json {
    const { request_id, ...payload } = input;
    const key = String(request_id);
    const hash = payloadHash({ tool, payload });
    return this.sql.transaction(() => {
      const receipt = one<{ payload_hash: string; result: string; tool: string }>(
        this.sql,
        "SELECT payload_hash, result, tool FROM command_receipts WHERE account_id = ? AND idempotency_key = ?",
        accountId,
        key,
      );
      if (receipt) {
        if (receipt.payload_hash !== hash || receipt.tool !== tool)
          throw new GameError("IDEMPOTENCY_CONFLICT", "同じ request_id が別の内容で使われています。");
        return { ...(JSON.parse(receipt.result) as Json), replayed: true };
      }
      const result = fn();
      this.sql.run(
        "INSERT INTO command_receipts (account_id, idempotency_key, tool, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        accountId,
        key,
        tool,
        hash,
        JSON.stringify(result),
        this.iso(),
      );
      return result;
    });
  }

  // --------------------------------------------------------- credits

  private credits(accountId: string, persist: boolean): { balance: number; last_granted_day: string } {
    const today = this.today();
    let row = one<{ balance: number; last_granted_day: string }>(
      this.sql,
      "SELECT balance, last_granted_day FROM adventure_credits WHERE account_id = ?",
      accountId,
    );
    if (!row) {
      row = { balance: 1, last_granted_day: today };
      if (persist)
        this.sql.run("INSERT INTO adventure_credits (account_id, balance, last_granted_day) VALUES (?, 1, ?)", accountId, today);
      return row;
    }
    const days = daysBetween(row.last_granted_day, today);
    if (days > 0) {
      row = { balance: Math.min(MAX_CREDITS, row.balance + days), last_granted_day: today };
      if (persist)
        this.sql.run(
          "UPDATE adventure_credits SET balance = ?, last_granted_day = ?, version = version + 1 WHERE account_id = ?",
          row.balance,
          today,
          accountId,
        );
    }
    return row;
  }

  playBudget(accountId: string) {
    const c = this.credits(accountId, false);
    return {
      adventure_credits: c.balance,
      max_credits: MAX_CREDITS,
      next_grant_at: nextDayBoundary(this.now()),
      world_day: this.today(),
      note: "冒険権は日本時間午前4時に1回分付与され、最大3回分まで貯まります。再開・閲覧は消費しません。",
    };
  }

  // -------------------------------------------------------- characters

  private getMyAccount(accountId: string) {
    const a = this.mustAccount(accountId);
    return {
      account: {
        account_id: a.account_id,
        display_name: a.display_name,
        role: a.role,
        status: a.status,
        trust_level: a.trust_level,
        created_at: a.created_at,
      },
      restrictions: this.activeRestrictions(accountId),
      play_budget: this.playBudget(accountId),
    };
  }

  private listCharacters(accountId: string) {
    const ids = this.sql.all<{ entity_id: string }>(
      "SELECT entity_id FROM components WHERE component_type = 'owner' AND json_extract(value, '$.account_id') = ?",
      accountId,
    );
    return {
      characters: ids.map(({ entity_id }) => {
        const c = this.loadCharacter(entity_id);
        const ep = this.openEpisode(entity_id);
        return {
          character_id: c.character_id,
          name: c.name,
          race: c.race,
          class: c.class,
          level: c.level,
          hp: `${c.hp}/${c.max_hp}`,
          active_episode_id: ep?.episode_id ?? null,
        };
      }),
      next_step: ids.length === 0 ? "create_character でキャラクターを作成してください。" : "resume_game で再開してください。",
    };
  }

  private createCharacter(accountId: string, input: Json) {
    const existing = this.listCharacters(accountId).characters;
    if (existing.length >= 1)
      throw new GameError("CONFLICT", "MVPでは1アカウントにつき1キャラクターです。", { character_id: existing[0]?.character_id });
    const name = sanitizeName(String(input.name), 24);
    const race = this.world.races.find((r) => r.id === input.race);
    const cls = this.world.classes.find((c) => c.id === input.class);
    if (!race || !cls) throw new GameError("INVALID_INPUT", "種族または職業が不正です。");
    const sheet = buildCharacter({
      characterId: randomId("chr"),
      accountId,
      name,
      race,
      cls,
      background: sanitizeText(String(input.background ?? ""), 300),
      location: this.world.startLocation,
    });
    this.sql.run(
      "INSERT INTO entities (id, type, name, status, revision, created_at) VALUES (?, 'character', ?, 'alive', 0, ?)",
      sheet.character_id,
      sheet.name,
      this.iso(),
    );
    this.saveCharacter(sheet, true);
    const ev = this.emit({
      type: "character.created",
      accountId,
      characterId: sheet.character_id,
      visibility: "participants",
      payload: { summary: `${sheet.name}（${raceName(this.world, race.id)}の${cls.name}）が冒険者として登録された。` },
    });
    return {
      status: "created",
      character: this.publicSheet(sheet),
      event_ids: [ev],
      world_intro: this.world.intro,
      next_step: "get_adventures で冒険の候補を確認し、プレイヤーに選んでもらってください。",
    };
  }

  private loadCharacter(characterId: string): CharacterSheet {
    const rows = this.sql.all<{ component_type: string; value: string }>(
      "SELECT component_type, value FROM components WHERE entity_id = ?",
      characterId,
    );
    if (rows.length === 0) throw new GameError("NOT_FOUND", "キャラクターが見つかりません。");
    const c = Object.fromEntries(rows.map((r) => [r.component_type, JSON.parse(r.value)])) as Record<string, any>;
    const ent = one<{ revision: number }>(this.sql, "SELECT revision FROM entities WHERE id = ?", characterId);
    return {
      character_id: characterId,
      account_id: c.owner.account_id,
      name: c.profile.name,
      race: c.profile.race as Race,
      class: c.profile.class as ClassId,
      background: c.profile.background,
      abilities: c.abilities,
      trained_skills: c.skills.trained,
      spells: c.skills.spells,
      hp: c.vitals.hp,
      max_hp: c.vitals.max_hp,
      mp: c.vitals.mp,
      max_mp: c.vitals.max_mp,
      condition: c.vitals.condition,
      items: c.inventory.items,
      equipped: c.inventory.equipped,
      gold: c.wallet.gold,
      xp: c.progress.xp,
      level: c.progress.level,
      location: c.location.id,
      relations: c.relations,
      revision: ent?.revision ?? 0,
    };
  }

  private saveCharacter(c: CharacterSheet, insert = false) {
    const values: Record<(typeof COMPONENTS)[number], unknown> = {
      owner: { account_id: c.account_id },
      profile: { name: c.name, race: c.race, class: c.class, background: c.background },
      abilities: c.abilities,
      skills: { trained: c.trained_skills, spells: c.spells },
      vitals: { hp: c.hp, max_hp: c.max_hp, mp: c.mp, max_mp: c.max_mp, condition: c.condition },
      inventory: { items: c.items, equipped: c.equipped },
      wallet: { gold: c.gold },
      progress: { xp: c.xp, level: c.level },
      location: { id: c.location },
      relations: c.relations,
    };
    for (const type of COMPONENTS) {
      const parsed = ComponentSchemas[type].safeParse(values[type]);
      if (!parsed.success) throw new Error(`invariant violation in component ${type}: ${parsed.error.message}`);
      const json = JSON.stringify(parsed.data);
      if (json.length > 8192) throw new Error(`component ${type} too large`);
      if (insert)
        this.sql.run(
          "INSERT INTO components (entity_id, component_type, schema_version, value, revision) VALUES (?, ?, 1, ?, 0)",
          c.character_id,
          type,
          json,
        );
      else
        this.sql.run(
          "UPDATE components SET value = ?, revision = revision + 1 WHERE entity_id = ? AND component_type = ?",
          json,
          c.character_id,
          type,
        );
    }
    if (!insert) this.sql.run("UPDATE entities SET revision = revision + 1 WHERE id = ?", c.character_id);
  }

  private ownedCharacter(accountId: string, characterId: string): CharacterSheet {
    const c = this.loadCharacter(characterId);
    if (c.account_id !== accountId) throw new GameError("FORBIDDEN", "このキャラクターを操作する権限がありません。");
    return c;
  }

  private publicSheet(c: CharacterSheet) {
    const cls = this.world.classes.find((x) => x.id === c.class);
    return {
      character_id: c.character_id,
      name: c.name,
      race: c.race,
      race_name: raceName(this.world, c.race),
      class: c.class,
      class_name: cls?.name,
      background: c.background,
      level: c.level,
      xp: c.xp,
      hp: c.hp,
      max_hp: c.max_hp,
      mp: c.mp,
      max_mp: c.max_mp,
      condition: c.condition,
      abilities: c.abilities,
      skills: Object.keys(SKILL_NAMES).map((s) => ({
        id: s,
        name: SKILL_NAMES[s],
        modifier: skillModifier(c, s),
        trained: c.trained_skills.includes(s),
      })),
      spells: c.spells.map((s) => {
        const sp = this.spells.get(s);
        return { id: s, name: sp?.name, mp_cost: sp?.mpCost, description: sp?.description };
      }),
      items: Object.entries(c.items).map(([id, qty]) => ({ id, name: this.items.get(id)?.name ?? id, qty })),
      equipped: {
        weapon: this.items.get(c.equipped.weapon)?.name,
        armor: c.equipped.armor ? this.items.get(c.equipped.armor)?.name : undefined,
      },
      defense: defense(c, this.items, false),
      gold: c.gold,
      relations: Object.entries(c.relations).map(([npc, v]) => ({
        npc,
        name: this.world.npcs.find((n) => n.id === npc)?.name ?? npc,
        value: v,
      })),
      known_facts: this.sql.all<{ id: string; text: string }>(
        "SELECT f.id AS id, f.text AS text FROM knowledge k JOIN facts f ON f.id = k.fact_id WHERE k.character_id = ?",
        c.character_id,
      ),
    };
  }

  // ---------------------------------------------------------- adventures

  private openEpisode(characterId: string): EpisodeRow | undefined {
    return one<EpisodeRow>(
      this.sql,
      "SELECT * FROM episodes WHERE character_id = ? AND status IN ('active', 'paused') ORDER BY started_at DESC LIMIT 1",
      characterId,
    );
  }

  private latestScenario(id: string): CompiledScenario | undefined {
    let best: CompiledScenario | undefined;
    for (const s of this.scenarios.values()) if (s.id === id && (!best || s.version > best.version)) best = s;
    return best;
  }

  private scenarioFor(ep: EpisodeRow): CompiledScenario {
    const s = this.scenarios.get(`${ep.scenario_id}@${ep.scenario_version}`);
    if (s) return s;
    // Fallback to the registered compiled artifact (old versions stay playable).
    const row = one<{ compiled: string }>(
      this.sql,
      "SELECT compiled FROM scenarios WHERE id = ? AND version = ?",
      ep.scenario_id,
      ep.scenario_version,
    );
    if (!row) throw new GameError("TEMPORARY_UNAVAILABLE", "シナリオ定義が見つかりません。");
    const parsed = JSON.parse(row.compiled) as CompiledScenario;
    this.scenarios.set(`${parsed.id}@${parsed.version}`, parsed);
    return parsed;
  }

  private factEstablished(id: string): boolean {
    return !!one(this.sql, "SELECT 1 FROM facts WHERE id = ? AND status = 'established'", id);
  }

  private entityStatus(id: string): string | undefined {
    return one<{ status: string }>(this.sql, "SELECT status FROM entities WHERE id = ?", id)?.status;
  }

  private dependencyOk(dep: { entity: string; predicate: string }): boolean {
    const st = this.entityStatus(dep.entity);
    if (dep.predicate === "alive") return st === "alive";
    return st === "alive" || st === "present";
  }

  private eligibility(c: CharacterSheet, s: CompiledScenario): { available: boolean; reason?: string } {
    if (c.level < s.eligibility.minLevel) return { available: false, reason: `レベル${s.eligibility.minLevel}以上が必要` };
    for (const f of s.eligibility.requiresFacts) if (!this.factEstablished(f)) return { available: false, reason: "前提となる出来事が起きていない" };
    for (const f of s.eligibility.forbidsFacts) if (this.factEstablished(f)) return { available: false, reason: "世界の状況が変わり、この事件は既に決着している" };
    for (const d of s.dependencies) if (!this.dependencyOk(d)) return { available: false, reason: "関係者が不在のため、この事件は成立しない" };
    if (s.uniqueness !== "repeatable") {
      const done = one(
        this.sql,
        `SELECT 1 FROM episodes WHERE scenario_id = ? AND status = 'completed' AND outcome IN ('success', 'partial')${
          s.uniqueness === "unique_per_character" ? " AND character_id = ?" : ""
        } LIMIT 1`,
        ...(s.uniqueness === "unique_per_character" ? [s.id, c.character_id] : [s.id]),
      );
      if (done) return { available: false, reason: "既に決着した冒険" };
    }
    return { available: true };
  }

  private getAdventures(accountId: string, characterId: string) {
    const c = this.ownedCharacter(accountId, characterId);
    const open = this.openEpisode(characterId);
    const latest = new Map<string, CompiledScenario>();
    for (const s of this.scenarios.values()) {
      const cur = latest.get(s.id);
      if (!cur || s.version > cur.version) latest.set(s.id, s);
    }
    const adventures = [...latest.values()].map((s) => {
      const e = this.eligibility(c, s);
      return {
        adventure_id: s.id,
        title: s.title,
        kind: s.kind,
        difficulty: s.difficulty,
        target_turns: s.targetTurns,
        hook: s.hook,
        summary: s.publicSummary,
        available: e.available,
        unavailable_reason: e.reason,
      };
    });
    const budget = this.playBudget(accountId);
    return {
      adventures,
      play_budget: budget,
      active_episode_id: open?.episode_id ?? null,
      next_step: open
        ? "進行中の冒険があります。resume_game で再開してください（新しい冒険は開始できません）。"
        : adventures.some((a) => a.available)
          ? budget.adventure_credits > 0
            ? "プレイヤーに冒険を選んでもらい、start_adventure を呼んでください。"
            : "冒険権がありません。次回付与時刻を案内してください。"
          : "現在参加できる冒険がありません。休息して次回の候補を待つよう案内してください。",
    };
  }

  private startAdventure(accountId: string, characterId: string, adventureId: string) {
    const c = this.ownedCharacter(accountId, characterId);
    const open = this.openEpisode(characterId);
    if (open)
      throw new GameError("CONFLICT", "進行中の冒険があります。同時に進行できる冒険は1つです。", { episode_id: open.episode_id });
    const s = this.latestScenario(adventureId);
    if (!s) throw new GameError("NOT_FOUND", "冒険が見つかりません。");
    const e = this.eligibility(c, s);
    if (!e.available) throw new GameError("INVALID_ACTION", `この冒険は開始できません: ${e.reason}`);
    const credits = this.credits(accountId, true);
    if (credits.balance < 1)
      throw new GameError("NO_ADVENTURE_CREDIT", "冒険権がありません。", { next_grant_at: nextDayBoundary(this.now()) });
    if (c.condition === "down") c.condition = "wounded";
    if (c.hp < 1) c.hp = 1;

    this.sql.run("UPDATE adventure_credits SET balance = balance - 1, version = version + 1 WHERE account_id = ?", accountId);
    const episodeId = randomId("ep");
    const st = initialState(s);
    const seed = this.seedSource();
    const dice = new DiceStream(seed, 0);
    const out = emptyOutput();
    const host = this.host(c, st, s, dice, 0);
    applyEffects(s, st, host, currentNode(s, st).onEnter, out);
    const nowIso = this.iso();
    this.sql.run(
      `INSERT INTO episodes (episode_id, character_id, account_id, scenario_id, scenario_version, scenario_digest, status, phase, turn, state, rng_seed, rule_versions, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 'intro', 0, ?, ?, ?, ?, ?)`,
      episodeId,
      characterId,
      accountId,
      s.id,
      s.version,
      s.digest,
      JSON.stringify(st),
      seed,
      JSON.stringify({ ...s.ruleVersions, rules: RULES_VERSION, kernel: KERNEL_VERSION }),
      nowIso,
      nowIso,
    );
    for (const d of s.dependencies)
      this.sql.run(
        "INSERT INTO dependencies (episode_id, entity_id, predicate, expected_value) VALUES (?, ?, ?, 'true')",
        episodeId,
        d.entity,
        d.predicate,
      );
    this.saveCharacter(c);
    const ev = this.emit({
      type: "episode.started",
      accountId,
      characterId,
      episodeId,
      visibility: "participants",
      payload: { scenario: `${s.id}@${s.version}`, summary: `${c.name}は冒険「${s.title}」に出発した。` },
    });
    return {
      status: "started",
      event_ids: [ev],
      hook: s.hook,
      credits_remaining: credits.balance - 1,
      ...this.sceneView(c, s, st, episodeId, 0, "active"),
      narration_guidance: `導入を短く描写し（${s.hook.slice(0, 40)}…）、プレイヤーに最初の行動を尋ねる。${s.gmNotes ?? ""}`,
    };
  }

  private loadEpisode(accountId: string, episodeId: string): EpisodeRow {
    const ep = one<EpisodeRow>(this.sql, "SELECT * FROM episodes WHERE episode_id = ?", episodeId);
    if (!ep) throw new GameError("NOT_FOUND", "エピソードが見つかりません。");
    if (ep.account_id !== accountId) throw new GameError("FORBIDDEN", "このエピソードを操作する権限がありません。");
    return ep;
  }

  private sceneView(c: CharacterSheet, s: CompiledScenario, st: EpisodeState, episodeId: string, turn: number, status: string) {
    const hostR = this.readHost(c, turn);
    const node = currentNode(s, st);
    const location = this.world.locations.find((l) => l.id === node.location);
    return {
      episode_id: episodeId,
      adventure: { id: s.id, title: s.title },
      episode_status: status,
      turn,
      expected_turn: turn,
      scene: {
        node: node.id,
        name: node.name,
        location: location?.name ?? node.location,
        description: node.description,
        targets: visibleTargets(s, st, hostR).map((t) => ({ id: t.id, name: t.name, kind: t.kind, description: t.description })),
        exits: availableExits(s, st, hostR).map((x) => ({ to: x.to, label: x.label, open: x.open })),
      },
      combat: st.combat.active
        ? {
            active: true,
            enemies: Object.entries(st.combat.enemies).map(([id, e]) => ({
              id,
              name: s.enemies.find((x) => x.id === id)?.name ?? id,
              hp: e.hp,
              max_hp: e.maxHp,
            })),
          }
        : { active: false, enemies: [] },
      objectives: objectiveStatus(s, st, hostR).map((o) => ({ text: o.text, required: o.required, done: o.done })),
      known_clues: st.clues.map((id) => ({ id, text: s.clues.find((x) => x.id === id)?.text ?? id })),
      character: { name: c.name, hp: c.hp, max_hp: c.max_hp, mp: c.mp, max_mp: c.max_mp, condition: c.condition },
      progress: {
        turn,
        story_turn: turn - (st.freeActions ?? 0),
        target_turns: s.targetTurns,
        max_turns: s.maxTurns,
        phase: phaseFor(turn - (st.freeActions ?? 0), s.targetTurns, status),
        episode_complete: status === "completed",
      },
    };
  }

  private observe(accountId: string, episodeId: string) {
    const ep = this.loadEpisode(accountId, episodeId);
    const s = this.scenarioFor(ep);
    const st = JSON.parse(ep.state) as EpisodeState;
    const c = this.loadCharacter(ep.character_id);
    const view = this.sceneView(c, s, st, ep.episode_id, ep.turn, ep.status);
    if (ep.status === "completed")
      return { ...view, conclusion: { outcome: ep.outcome, summary: ep.summary }, narration_guidance: "この冒険は終了している。結果を振り返り、次の冒険は get_adventures で確認する。" };
    return { ...view, narration_guidance: this.guidance(s, st, c, ep.turn) };
  }

  private guidance(s: CompiledScenario, st: EpisodeState, c: CharacterSheet, turn: number): string {
    const parts: string[] = [];
    if (st.combat.active) parts.push("戦闘中。敵の様子とHPを簡潔に描写し、プレイヤーの次の行動を尋ねる。");
    if (c.hp <= Math.ceil(c.max_hp / 3)) parts.push("キャラクターは深手を負っている。撤退や回復の選択肢があることを示してよい。");
    if (turn >= s.targetTurns) parts.push("物語は終盤。決着に向けた選択を促す。");
    else if (turn >= Math.floor(s.targetTurns * 0.6)) parts.push("中盤を過ぎた。得た手がかりを整理する機会を与える。");
    parts.push("未確認の情報は断定しない。判定結果を変えない。");
    return parts.join(" ");
  }

  private inspect(accountId: string, episodeId: string, targetId: string) {
    const ep = this.loadEpisode(accountId, episodeId);
    const s = this.scenarioFor(ep);
    const st = JSON.parse(ep.state) as EpisodeState;
    const c = this.loadCharacter(ep.character_id);
    const target = visibleTargets(s, st, this.readHost(c, ep.turn)).find((t) => t.id === targetId);
    if (target) {
      const npc = target.entity ? this.world.npcs.find((n) => n.id === target.entity) : undefined;
      return {
        kind: "target",
        id: target.id,
        name: target.name,
        description: target.description,
        public_profile: npc?.publicProfile,
        relation: npc ? (c.relations[npc.id] ?? 0) : undefined,
        hint: "新しい情報を得るにはプレイヤーの行動を act（investigate / talk / attempt）で送る。",
      };
    }
    const clue = st.clues.includes(targetId) ? s.clues.find((x) => x.id === targetId) : undefined;
    if (clue) return { kind: "clue", id: clue.id, text: clue.text };
    if (c.items[targetId]) {
      const it = this.items.get(targetId);
      return { kind: "item", id: targetId, name: it?.name, description: it?.description, qty: c.items[targetId] };
    }
    throw new GameError("NOT_FOUND", "その対象は見えていないか、まだ知らない。", { hint: "observe で見えている対象を確認する。" });
  }

  private getActions(accountId: string, episodeId: string) {
    const ep = this.loadEpisode(accountId, episodeId);
    if (ep.status === "completed") return { episode_id: episodeId, actions: [], note: "冒険は終了しています。" };
    const s = this.scenarioFor(ep);
    const st = JSON.parse(ep.state) as EpisodeState;
    const c = this.loadCharacter(ep.character_id);
    return {
      episode_id: episodeId,
      turn: ep.turn,
      expected_turn: ep.turn,
      ...this.actionCatalog(s, st, c, ep.turn),
      gm_note:
        "これはGM用の資料。プレイヤーに行動や選択肢の一覧を見せない。プレイヤーの発言・行動はすべて act に変換する。affordances は場面が反応する仕掛けで、プレイヤーの自由な行動がそれに近ければ対応付け、近くなければ attempt で送る。",
    };
  }

  /**
   * Action catalog for the GM. `actions` are the verbs; `affordances` are
   * GM-only knowledge of what this scene can react to. Neither is meant to be
   * shown to the player as a menu.
   */
  private actionCatalog(s: CompiledScenario, st: EpisodeState, c: CharacterSheet, turn: number) {
    const hostR = this.readHost(c, turn);
    const targets = visibleTargets(s, st, hostR).filter((t) => t.kind !== "enemy");
    const triggers = eligibleTriggers(s, st, hostR);
    const items = Object.keys(c.items).map((id) => ({ id, name: this.items.get(id)?.name ?? id }));
    const targetList = targets.map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
    const enemies = Object.keys(st.combat.enemies).map((id) => ({ id, name: s.enemies.find((e) => e.id === id)?.name }));
    const actions: Json[] = [];
    actions.push({
      action_id: "attempt",
      description:
        "どんな行動でも送れる汎用の行動。プレイヤーの意図を intent に書き、最も自然な技能を skill に、対象があれば target_id に入れる。場面に仕掛けがあればそれが反応し、なければサーバーが判定だけ行い、描写は narrative_license の範囲で自由。判定不要な行動は skill を省略。戦闘中に敵を target_id にすると即興の攻撃になる。",
      parameters: {
        intent: "自由記述（必須ではないが推奨）",
        skill: Object.keys(SKILL_NAMES).map((k) => ({ id: k, name: SKILL_NAMES[k], modifier: skillModifier(c, k) })),
        target_id: st.combat.active ? [...enemies, ...targetList] : targetList,
        difficulty: Object.keys(DIFFICULTY),
      },
    });
    const npcs = targets.filter((t) => t.kind === "npc");
    if (npcs.length)
      actions.push({
        action_id: "talk",
        description: "人物との会話（雑談・質問・交渉すべて）。approach は話し方（既定 friendly）、topic に話題や台詞の要旨。",
        parameters: { target_id: npcs.map((t) => ({ id: t.id, name: t.name })), approach: [...APPROACHES], topic: "自由記述" },
      });
    if (st.combat.active) {
      actions.push({ action_id: "attack", description: "装備中の武器で攻撃する", parameters: { target_id: enemies } });
      actions.push({ action_id: "defend", description: "身を守る（このラウンドの防御+4）", parameters: {} });
      actions.push({ action_id: "flee", description: "戦闘から逃げる（軽業 難易度12）", parameters: {} });
    } else {
      const exits = availableExits(s, st, hostR);
      if (exits.length)
        actions.push({ action_id: "move", description: "別の場所へ移動する", parameters: { to: exits.map((x) => ({ id: x.to, label: x.label, open: x.open })) } });
      if (targets.length) actions.push({ action_id: "investigate", description: "対象を詳しく調べる", parameters: { target_id: targetList } });
    }
    const spells = c.spells
      .map((id) => this.spells.get(id))
      .filter((sp): sp is SpellDef => !!sp && sp.mpCost <= c.mp && (st.combat.active || sp.kind !== "attack"));
    if (spells.length)
      actions.push({
        action_id: "cast",
        description: "呪文を唱える（MP消費）",
        parameters: { spell_id: spells.map((sp) => ({ id: sp.id, name: sp.name, mp_cost: sp.mpCost, kind: sp.kind })), ...(st.combat.active ? { target_id: enemies } : {}) },
      });
    if (items.length) actions.push({ action_id: "use_item", description: "所持品を使う（対象を指定できる）", parameters: { item_id: items, target_id: "任意" } });
    if (triggers.some((t) => t.action === "interact"))
      actions.push({ action_id: "interact", description: "affordances にある場面固有の行動（target_id と option_id）", parameters: {} });
    actions.push({ action_id: "withdraw", description: "冒険から撤退して決着とする（冒険権は戻らない）", parameters: {} });

    const affordances = triggers
      .filter((t) => t.action === "interact" || t.action === "attempt")
      .filter((t) => !st.combat.active || t.action === "interact")
      .map((t) =>
        t.action === "interact"
          ? { via: "interact", target_id: t.target, option_id: t.option, idea: t.label }
          : {
              via: "attempt",
              target_id: t.target,
              idea: t.gmHint ?? t.label ?? "この対象への工夫した働きかけ",
              skills: t.accepts?.map((x) => x.skill),
            },
      );
    return { actions, affordances };
  }

  private pickHint(s: CompiledScenario, st: EpisodeState, c: CharacterSheet, turn: number) {
    const hostR = this.readHost(c, turn);
    const open = (s.hints ?? []).filter((h) => (!h.when || evalCond(h.when, st, hostR)) && !(h.until && evalCond(h.until, st, hostR)));
    if (open.length === 0) return undefined;
    const given = st.hintsGiven ?? [];
    return open.find((h) => !given.includes(h.id)) ?? open.sort((a, b) => given.indexOf(a.id) - given.indexOf(b.id))[0];
  }

  // ------------------------------------------------------------------ act

  private act(accountId: string, input: ActInput): Json {
    const { request_id, ...payload } = input;
    const hash = payloadHash({ tool: "act", payload });
    const unsupported: { error?: GameError } = {};
    const result = this.sql.transaction(() => {
      const receipt = one<{ payload_hash: string; result: string; tool: string }>(
        this.sql,
        "SELECT payload_hash, result, tool FROM command_receipts WHERE account_id = ? AND idempotency_key = ?",
        accountId,
        request_id,
      );
      if (receipt) {
        if (receipt.payload_hash !== hash || receipt.tool !== "act")
          throw new GameError("IDEMPOTENCY_CONFLICT", "同じ request_id が別の内容で使われています。");
        return { ...(JSON.parse(receipt.result) as Json), replayed: true };
      }
      let res: Json;
      try {
        res = this.resolveAct(accountId, input);
      } catch (e) {
        if (e instanceof GameError && e.code === "UNSUPPORTED_ACTION") {
          unsupported.error = e;
          return undefined;
        }
        throw e;
      }
      this.sql.run(
        "INSERT INTO command_receipts (account_id, idempotency_key, tool, payload_hash, result, created_at) VALUES (?, ?, 'act', ?, ?, ?)",
        accountId,
        request_id,
        hash,
        JSON.stringify(res),
        this.iso(),
      );
      return res;
    });
    if (unsupported.error) {
      const recorded = this.recordFeatureRequest(accountId, input);
      throw new GameError("UNSUPPORTED_ACTION", unsupported.error.message, { ...unsupported.error.details, feature_request: recorded });
    }
    return result as Json;
  }

  /** R-LLM-06: unsupported actions are recorded for the daily cycle, never generated synchronously. */
  private recordFeatureRequest(accountId: string, input: ActInput) {
    return this.sql.transaction(() => {
      const today = this.today();
      const n = one<{ n: number }>(
        this.sql,
        "SELECT COUNT(*) AS n FROM feature_requests WHERE account_id = ? AND world_day = ?",
        accountId,
        today,
      )?.n ?? 0;
      if (n >= 1) return { recorded: false, reason: "機能提案は1日1件までです（本日分は記録済み）。" };
      const id = randomId("frq");
      this.sql.run(
        "INSERT INTO feature_requests (id, account_id, episode_id, world_day, structured_intent, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
        id,
        accountId,
        input.episode_id,
        today,
        JSON.stringify({ action_id: input.action_id, parameters: input.parameters ?? {} }),
        this.iso(),
      );
      return { recorded: true, id, note: "日次処理で検討されます。採用は保証されません。" };
    });
  }

  private resolveAct(accountId: string, input: ActInput): Json {
    const ep = this.loadEpisode(accountId, input.episode_id);
    if (ep.status === "completed") throw new GameError("INVALID_ACTION", "この冒険は既に終了しています。", { outcome: ep.outcome });
    if (input.expected_turn !== ep.turn)
      throw new GameError("STALE_STATE", "ターンが一致しません。最新の状態を取得してください。", { current_turn: ep.turn });
    const s = this.scenarioFor(ep);
    const st = JSON.parse(ep.state) as EpisodeState;
    const c = this.ownedCharacter(accountId, ep.character_id);
    const turn = ep.turn + 1;
    const dice = new DiceStream(ep.rng_seed, turn);
    const host = this.host(c, st, s, dice, turn);
    const params = input.parameters ?? {};
    const actionId = input.action_id as ActionId;
    const resumed = ep.status === "paused";

    // Dependency check before the next operation (spec §7.2).
    const lost = this.sql
      .all<{ entity_id: string; predicate: string }>("SELECT entity_id, predicate FROM dependencies WHERE episode_id = ?", ep.episode_id)
      .filter((d) => !this.dependencyOk({ entity: d.entity_id, predicate: d.predicate }));
    if (lost.length > 0) {
      const fb = s.fallbackPolicy.find((f) => f.when === "dependency_lost");
      if (fb?.mode === "conclude" && fb.resolution && actionId !== "withdraw") {
        const res = s.resolutions.find((r) => r.id === fb.resolution);
        if (res) {
          const out = emptyOutput();
          out.texts.push("状況が変わった。この冒険の前提となる人物や物事が失われている。");
          if (fb.followup === "daily_request") this.insertReplanRequest(accountId, ep, lost.map((l) => l.entity_id));
          return this.finishAct({ ep, s, st, c, dice, turn, actionId, params, out, check: [], combatLog: [], resolution: res, reason: "dependency_lost" });
        }
      }
      if (actionId !== "withdraw")
        throw new GameError("NEEDS_REPLAN", "冒険の前提が失われました。撤退（withdraw）を選べます。", { lost: lost.map((l) => l.entity_id) });
    }

    if (!ACTION_IDS.includes(actionId))
      throw new GameError("UNSUPPORTED_ACTION", `行動 ${input.action_id} は未実装です。`, {
        alternatives: ["attempt"],
        hint: "自由な行動は action_id=attempt（skill と intent）で送る。",
      });

    const out = emptyOutput();
    const checks: Json[] = [];
    const combatLog: Json[] = [];
    const combat: CombatExtra = {};
    const hostR = this.readHost(c, ep.turn);
    const targets = visibleTargets(s, st, hostR);
    const findTarget = (id: string | undefined) => {
      const t = targets.find((x) => x.id === id && x.kind !== "enemy");
      if (!t) throw new GameError("INVALID_ACTION", "その対象はここにはいない、または見えていない。", { visible_targets: targets.filter((x) => x.kind !== "enemy").map((x) => x.id) });
      return t;
    };
    const combatOnly = ["attack", "defend", "flee"].includes(actionId);
    if (combatOnly && !st.combat.active) throw new GameError("INVALID_ACTION", "戦闘中ではありません。");
    if (st.combat.active && ["move", "investigate"].includes(actionId))
      throw new GameError("INVALID_ACTION", "戦闘中はその行動を取れません。attack / cast / defend / flee / use_item / talk / withdraw を選んでください。");

    let license: (typeof LICENSE)[keyof typeof LICENSE] = LICENSE.embellish;
    let improvised: Json | undefined;
    let npcReaction: Json | undefined;
    let free = false;
    const runTrigger = (t: Trigger, skill?: string) => {
      if (t.text) out.texts.push(t.text);
      applyEffects(s, st, host, t.effects, out);
      const check = t.accepts ? (t.accepts.find((a) => a.skill === skill) ?? t.accepts[0]) : t.check;
      if (check) {
        const r = this.skillCheck(c, check.skill, check.difficulty, dice);
        checks.push(r);
        if (r.outcome === "success") {
          if (t.successText) out.texts.push(t.successText);
          applyEffects(s, st, host, t.onSuccess, out);
        } else {
          if (t.failureText) out.texts.push(t.failureText);
          applyEffects(s, st, host, t.onFailure, out);
        }
      }
      if (!st.usedTriggers.includes(t.id)) st.usedTriggers.push(t.id);
    };
    const triggers = eligibleTriggers(s, st, hostR);

    switch (actionId) {
      case "move": {
        const exit = availableExits(s, st, hostR).find((x) => x.to === params.to);
        if (!exit) throw new GameError("INVALID_ACTION", "その方向には移動できない。", { exits: availableExits(s, st, hostR).map((x) => x.to) });
        if (!exit.open) throw new GameError("INVALID_ACTION", exit.lockedText ?? "今はそこへ進めない。", { locked: true });
        applyEffects(s, st, host, [{ op: "move_to", node: exit.to }], out);
        out.texts.unshift(`${exit.label}。`);
        const trig = triggers.find((t) => t.action === "move" && t.target === exit.to);
        if (trig) runTrigger(trig);
        break;
      }
      case "investigate": {
        const target = findTarget(params.target_id);
        const trig = triggers.find((t) => t.action === "investigate" && t.target === target.id);
        if (trig) runTrigger(trig);
        else out.texts.push(`${target.name}を調べたが、新しい発見はなかった。${target.description}`);
        break;
      }
      case "talk": {
        const target = findTarget(params.target_id);
        if (target.kind !== "npc") throw new GameError("INVALID_ACTION", "話しかけられる相手ではない。");
        const approach = params.approach ?? "friendly";
        if (!(APPROACHES as readonly string[]).includes(approach))
          throw new GameError("INVALID_INPUT", "approach は friendly / persuade / intimidate / deceive のいずれか。");
        const trig =
          triggers.find((t) => t.action === "talk" && t.target === target.id && t.approach === approach) ??
          triggers.find((t) => t.action === "talk" && t.target === target.id && !t.approach);
        if (trig) runTrigger(trig);
        else {
          npcReaction = this.npcReaction(c, target, turn);
          license = LICENSE.free;
          free = true;
        }
        break;
      }
      case "attempt": {
        const skill = params.skill;
        if (skill !== undefined && !SKILL_NAMES[skill])
          throw new GameError("INVALID_INPUT", "skill が不正です。", { skills: Object.keys(SKILL_NAMES) });
        const targetId = params.target_id;
        // Improvised combat move against an enemy (throwing a chair, a shield bash, ...).
        if (st.combat.active && targetId && st.combat.enemies[targetId]) {
          const sk = skill ?? "athletics";
          combatLog.push(
            this.playerAttack(c, s, st, targetId, dice, out, { ability: SKILL_ABILITY[sk] ?? "str", damage: "1d6", label: "即興の一手", bonus: proficiency(c) }),
          );
          improvised = { intent: params.intent, skill: sk, kind: "combat" };
          break;
        }
        const target = targetId ? findTarget(targetId) : undefined;
        let trig: Trigger | undefined;
        if (target && skill) {
          trig =
            triggers.find((t) => t.action === "attempt" && t.target === target.id && t.accepts?.some((a) => a.skill === skill)) ??
            (target.kind === "npc" && SOCIAL_APPROACH[skill]
              ? (triggers.find((t) => t.action === "talk" && t.target === target.id && t.approach === SOCIAL_APPROACH[skill] && (!t.check || t.check.skill === skill)) ??
                triggers.find((t) => t.action === "talk" && t.target === target.id && !t.approach && t.check?.skill === skill))
              : undefined) ??
            (target.kind !== "npc" && INVESTIGATIVE.has(skill)
              ? triggers.find((t) => t.action === "investigate" && t.target === target.id)
              : undefined);
        }
        if (trig) {
          runTrigger(trig, skill);
          break;
        }
        // Generic attempt: the server rolls (or not), the GM narrates within the license.
        license = LICENSE.free;
        const dc = DIFFICULTY[params.difficulty ?? "normal"] ?? 12;
        let outcome = "automatic";
        if (skill && dc > 0) {
          const r = this.skillCheck(c, skill, dc, dice);
          checks.push(r);
          outcome = r.outcome;
          if (target?.entity && target.kind === "npc") {
            const delta = r.outcome === "success" ? (skill === "intimidation" || skill === "deception" ? 0 : 2) : skill === "intimidation" || skill === "deception" ? -3 : 0;
            if (delta) c.relations[target.entity] = Math.max(-100, Math.min(100, (c.relations[target.entity] ?? 0) + delta));
          }
        } else free = true;
        improvised = {
          intent: params.intent,
          skill: skill ?? null,
          target: target ? { id: target.id, name: target.name } : null,
          outcome,
          note: "この試みは物語の確定事項を変えない。結果は narrative_license の範囲で描写する。",
        };
        if (target?.kind === "npc") npcReaction = this.npcReaction(c, target, turn);
        break;
      }
      case "interact": {
        const trig = triggers.find((t) => t.action === "interact" && t.target === params.target_id && t.option === params.option_id);
        if (!trig)
          throw new GameError("INVALID_ACTION", "その行動は今は選べない。", {
            choices: triggers.filter((t) => t.action === "interact").map((t) => ({ target_id: t.target, option_id: t.option })),
          });
        runTrigger(trig);
        break;
      }
      case "use_item": {
        const itemId = params.item_id;
        if (!itemId || !c.items[itemId]) throw new GameError("INVALID_ACTION", "その道具を持っていない。");
        const item = this.items.get(itemId);
        const trig =
          triggers.find((t) => t.action === "use_item" && t.item === itemId && t.target !== undefined && t.target === params.target_id) ??
          triggers.find((t) => t.action === "use_item" && t.item === itemId && !t.target);
        if (trig) runTrigger(trig);
        else if (item?.kind === "consumable" && item.heal) {
          const before = c.hp;
          c.hp = Math.min(c.max_hp, c.hp + dice.roll(item.heal));
          removeItem(c, itemId, 1);
          if (c.condition !== "down" && c.hp > 0) c.condition = c.hp < c.max_hp ? "wounded" : "ok";
          out.texts.push(`${item.name}を使い、HPが${c.hp - before}回復した。`);
        } else if (LIGHT_ITEMS.has(itemId)) {
          if (!st.flags.includes("light")) st.flags.push("light");
          out.texts.push(`${item?.name}に火を灯した。辺りが照らされる。`);
        } else throw new GameError("INVALID_ACTION", "今それを使っても何も起きない。", { hint: "対象を指定するか、別の行動を試す。" });
        break;
      }
      case "cast": {
        const sp = this.spells.get(params.spell_id ?? "");
        if (!sp || !c.spells.includes(sp.id)) throw new GameError("INVALID_ACTION", "その呪文は使えない。", { known: c.spells });
        if (c.mp < sp.mpCost) throw new GameError("INVALID_ACTION", "MPが足りない。");
        c.mp -= sp.mpCost;
        if (sp.kind === "attack") {
          if (!st.combat.active) throw new GameError("INVALID_ACTION", "攻撃呪文は戦闘中のみ使える。");
          const enemyId = this.pickEnemy(st, params.target_id);
          combatLog.push(this.playerAttack(c, s, st, enemyId, dice, out, { ability: sp.ability, damage: sp.dice ?? "1d6", label: sp.name, bonus: 0 }));
        } else if (sp.kind === "heal") {
          const before = c.hp;
          c.hp = Math.min(c.max_hp, c.hp + dice.roll(sp.dice ?? "1d4") + Math.max(0, c.abilities[sp.ability]));
          if (c.hp > 0 && c.condition !== "down") c.condition = c.hp < c.max_hp ? "wounded" : "ok";
          out.texts.push(`${sp.name}を唱え、HPが${c.hp - before}回復した。`);
        } else {
          if (sp.id === "light" && !st.flags.includes("light")) st.flags.push("light");
          out.texts.push(`${sp.name}を唱えた。柔らかな光が辺りを照らす。`);
        }
        break;
      }
      case "attack": {
        const enemyId = this.pickEnemy(st, params.target_id);
        const weapon = this.items.get(c.equipped.weapon);
        combatLog.push(
          this.playerAttack(c, s, st, enemyId, dice, out, {
            ability: weapon?.attackAbility ?? "str",
            damage: weapon?.damage ?? "1d4",
            label: weapon?.name ?? "素手",
            bonus: proficiency(c),
          }),
        );
        break;
      }
      case "defend":
        combat.defending = true;
        out.texts.push("身構えて守りを固めた。");
        break;
      case "flee": {
        const r = this.skillCheck(c, "acrobatics", 12, dice);
        checks.push(r);
        if (r.outcome === "success") {
          st.combat = { active: false, enemies: {} };
          out.combatEnded = true;
          const exit = availableExits(s, st, hostR).find((x) => x.open);
          if (exit) applyEffects(s, st, host, [{ op: "move_to", node: exit.to }], out);
          out.texts.push(`戦闘から逃げ出した${exit ? `（${exit.label}）` : ""}。`);
        } else out.texts.push("逃げ道を塞がれた！");
        break;
      }
      case "withdraw": {
        const res = s.resolutions.find((r) => r.outcome === "withdrawn");
        if (!res) throw new Error("scenario without withdraw resolution");
        return this.finishAct({ ep, s, st, c, dice, turn, actionId, params, out, check: checks, combatLog, resolution: res, reason: "withdrawn" });
      }
    }

    if (free) st.freeActions = (st.freeActions ?? 0) + 1;

    // Enemies act after the player's action while combat continues.
    if (st.combat.active) {
      for (const [enemyId] of Object.entries(st.combat.enemies)) {
        if (c.hp <= 0) break;
        combatLog.push(this.enemyAttack(c, s, enemyId, dice, out, !!combat.defending));
      }
    }

    // Character down → fallback.
    if (c.hp <= 0) {
      c.condition = "down";
      const fb = s.fallbackPolicy.find((f) => f.when === "character_down");
      const res = s.resolutions.find((r) => r.id === fb?.resolution);
      if (res) return this.finishAct({ ep, s, st, c, dice, turn, actionId, params, out, check: checks, combatLog, resolution: res, reason: "character_down" });
    }

    let resolution: Resolution | undefined = findResolution(s, st, host);
    let reason = "resolved";
    // Free actions don't consume the story budget, but a hard cap keeps every episode finite.
    if (!resolution && (turn - (st.freeActions ?? 0) >= s.maxTurns || turn >= s.maxTurns * 2)) {
      const fb = s.fallbackPolicy.find((f) => f.when === "turn_limit");
      resolution = s.resolutions.find((r) => r.id === fb?.resolution);
      reason = "turn_limit";
    }
    return this.finishAct({ ep, s, st, c, dice, turn, actionId, params, out, check: checks, combatLog, resolution, reason, resumed, license, improvised, npcReaction });
  }

  /** In-character material for free dialogue. Public data only. */
  private npcReaction(c: CharacterSheet, target: { id: string; name: string; entity?: string; description: string }, turn: number): Json {
    const npc = target.entity ? this.world.npcs.find((n) => n.id === target.entity) : undefined;
    const rel = npc ? (c.relations[npc.id] ?? 0) : 0;
    const rumors = npc?.rumors ?? [];
    return {
      name: target.name,
      profile: npc?.publicProfile ?? target.description,
      manner: npc?.manner,
      disposition: rel >= 15 ? "親しい" : rel >= 5 ? "好意的" : rel <= -10 ? "敵対的" : rel < 0 ? "警戒している" : "普通",
      may_mention: rumors.length ? rumors[turn % rumors.length] : undefined,
      guidance: "この人物として自由に応答してよい。may_mention は話の流れが合えば触れてよい噂。秘密や新事実は語らせない。",
    };
  }

  private pickEnemy(st: EpisodeState, targetId: string | undefined): string {
    const ids = Object.keys(st.combat.enemies);
    if (!st.combat.active || ids.length === 0) throw new GameError("INVALID_ACTION", "攻撃できる敵がいない。");
    if (targetId === undefined && ids.length === 1) return ids[0] as string;
    if (!targetId || !st.combat.enemies[targetId]) throw new GameError("NEEDS_CLARIFICATION", "どの敵を狙うか指定してください。", { enemies: ids });
    return targetId;
  }

  private skillCheck(c: CharacterSheet, skill: string, difficulty: number, dice: DiceStream) {
    const roll = dice.d20();
    const modifier = skillModifier(c, skill);
    const total = roll + modifier;
    return {
      kind: "skill_check",
      skill,
      skill_name: SKILL_NAMES[skill] ?? skill,
      dice: roll,
      modifier,
      total,
      difficulty,
      difficulty_label: difficultyLabel(difficulty),
      outcome: total >= difficulty ? ("success" as const) : ("failure" as const),
    };
  }

  private playerAttack(
    c: CharacterSheet,
    s: CompiledScenario,
    st: EpisodeState,
    enemyId: string,
    dice: DiceStream,
    out: EffectOutput,
    w: { ability: keyof CharacterSheet["abilities"]; damage: string; label: string; bonus: number },
  ) {
    const enemy = st.combat.enemies[enemyId];
    const def = this.enemyDef(s, enemyId);
    const name = s.enemies.find((e) => e.id === enemyId)?.name ?? enemyId;
    if (!enemy || !def) throw new GameError("INVALID_ACTION", "その敵はいない。");
    const roll = dice.d20();
    const modifier = c.abilities[w.ability] + w.bonus;
    const hit = roll === 20 || (roll !== 1 && roll + modifier >= def.defense);
    let damage = 0;
    if (hit) {
      damage = Math.max(1, dice.roll(w.damage) + Math.max(0, c.abilities[w.ability]));
      enemy.hp = Math.max(0, enemy.hp - damage);
      out.texts.push(`${w.label}で${name}を攻撃し、${damage}のダメージを与えた。`);
      if (enemy.hp <= 0) {
        markDefeated(st, enemyId, out);
        out.texts.push(`${name}を倒した！`);
      }
    } else out.texts.push(`${w.label}での攻撃は${name}にかわされた。`);
    return { kind: "player_attack", target: enemyId, dice: roll, modifier, difficulty: def.defense, outcome: hit ? "hit" : "miss", damage, enemy_hp: enemy.hp };
  }

  private enemyAttack(c: CharacterSheet, s: CompiledScenario, enemyId: string, dice: DiceStream, out: EffectOutput, defending: boolean) {
    const def = this.enemyDef(s, enemyId);
    const name = s.enemies.find((e) => e.id === enemyId)?.name ?? enemyId;
    if (!def) return { kind: "enemy_attack", attacker: enemyId, outcome: "none" };
    const roll = dice.d20();
    const target = defense(c, this.items, defending);
    const hit = roll === 20 || (roll !== 1 && roll + def.attack >= target);
    let damage = 0;
    if (hit) {
      damage = Math.max(1, dice.roll(def.damage));
      c.hp = Math.max(0, c.hp - damage);
      c.condition = c.hp <= 0 ? "down" : "wounded";
      out.texts.push(`${name}の攻撃を受け、${damage}のダメージ（HP ${c.hp}/${c.max_hp}）。`);
    } else out.texts.push(`${name}の攻撃をかわした。`);
    return { kind: "enemy_attack", attacker: enemyId, dice: roll, modifier: def.attack, difficulty: target, outcome: hit ? "hit" : "miss", damage, character_hp: c.hp };
  }

  private enemyDef(s: CompiledScenario, enemyId: string): MonsterDef | undefined {
    const e = s.enemies.find((x) => x.id === enemyId);
    return e ? this.monsters.get(e.monster) : undefined;
  }

  private finishAct(a: {
    ep: EpisodeRow;
    s: CompiledScenario;
    st: EpisodeState;
    c: CharacterSheet;
    dice: DiceStream;
    turn: number;
    actionId: string;
    params: Record<string, string>;
    out: EffectOutput;
    check: Json[];
    combatLog: Json[];
    resolution?: Resolution;
    reason: string;
    resumed?: boolean;
    license?: (typeof LICENSE)[keyof typeof LICENSE];
    improvised?: Json;
    npcReaction?: Json;
  }): Json {
    const { ep, s, st, c, turn, out } = a;
    const before = this.loadCharacter(c.character_id);
    const prev = JSON.parse(ep.state) as EpisodeState;
    const progressed =
      st.clues.length > prev.clues.length ||
      st.flags.length !== prev.flags.length ||
      st.node !== prev.node ||
      st.defeated.length > prev.defeated.length ||
      st.combat.active !== prev.combat.active;
    if (progressed || st.progressTurn === undefined) st.progressTurn = turn;
    let nudge: Json | undefined;
    if (!a.resolution && !st.combat.active && turn - (st.progressTurn ?? 0) >= STALL_TURNS) {
      const h = this.pickHint(s, st, c, turn);
      if (h) {
        nudge = { text: h.text, how: "選択肢として列挙しない。NPCの仕草、環境の変化、キャラクターのふとした気づきとして描写にさりげなく織り込む。" };
        st.hintsGiven = [...(st.hintsGiven ?? []).filter((x) => x !== h.id), h.id];
        st.progressTurn = turn;
      }
    }
    // knowledge from revealed clues
    const eventId = this.emit({
      type: "episode.action_resolved",
      accountId: ep.account_id,
      characterId: c.character_id,
      episodeId: ep.episode_id,
      visibility: "participants",
      payload: {
        turn,
        action: { id: a.actionId, parameters: a.params },
        checks: a.check,
        combat: a.combatLog,
        dice: a.dice.rolls,
        revealed_clues: out.revealedClues,
        summary: out.texts.join(" ").slice(0, 300),
      },
    });
    const eventIds = [eventId];
    for (const clueId of out.revealedClues) {
      const clue = s.clues.find((x) => x.id === clueId);
      if (clue?.fact) this.learnFact(c.character_id, clue.fact, eventId);
    }

    let status: "active" | "completed" = "active";
    let conclusion: Json | undefined;
    if (a.resolution) {
      const r = this.conclude(ep, s, c, a.resolution, a.reason, eventId);
      status = "completed";
      conclusion = r.conclusion;
      eventIds.push(...r.eventIds);
    }

    this.saveCharacter(c);
    const phase = phaseFor(turn - (st.freeActions ?? 0), s.targetTurns, status);
    this.sql.run(
      "UPDATE episodes SET status = ?, phase = ?, turn = ?, state = ?, updated_at = ? WHERE episode_id = ?",
      status,
      phase,
      turn,
      JSON.stringify(st),
      this.iso(),
      ep.episode_id,
    );
    const after = c;
    const changes: Json = {};
    if (after.hp !== before.hp) changes.hp = after.hp - before.hp;
    if (after.mp !== before.mp) changes.mp = after.mp - before.mp;
    if (after.gold !== before.gold) changes.gold = after.gold - before.gold;
    if (after.xp !== before.xp) changes.xp = after.xp - before.xp;
    const itemDiff = diffItems(before.items, after.items);
    if (Object.keys(itemDiff).length) changes.items = itemDiff;
    const relDiff = diffItems(before.relations, after.relations);
    if (Object.keys(relDiff).length) changes.relations = relDiff;

    const view = this.sceneView(c, s, st, ep.episode_id, turn, status);
    return {
      status: "resolved",
      episode_id: ep.episode_id,
      turn,
      expected_turn: turn,
      world_revision: this.revision(),
      event_ids: eventIds,
      action: { id: a.actionId, parameters: a.params },
      resumed_from_pause: a.resumed ?? false,
      result: {
        checks: a.check,
        combat: a.combatLog,
      },
      narration: out.texts,
      narrative_license: a.license ?? LICENSE.embellish,
      ...(a.improvised ? { improvised: a.improvised } : {}),
      ...(a.npcReaction ? { npc_reaction: a.npcReaction } : {}),
      ...(nudge ? { gm_nudge: nudge } : {}),
      revealed_clues: out.revealedClues.map((id) => ({ id, text: s.clues.find((x) => x.id === id)?.text })),
      changes,
      scene: view.scene,
      combat: view.combat,
      objectives: view.objectives,
      character: view.character,
      available_actions: status === "completed" ? [] : this.actionCatalog(s, st, c, turn).actions.map((x) => x.action_id),
      narration_guidance:
        status === "completed"
          ? "冒険は決着した。epilogue を元に結末を描写し、報酬と世界への影響を伝える。rate_adventure で評価を任意で尋ね、次の冒険は get_adventures で確認できると伝える。"
          : this.guidance(s, st, c, turn),
      progress: view.progress,
      ...(conclusion ? { conclusion } : {}),
    };
  }

  private conclude(ep: EpisodeRow, s: CompiledScenario, c: CharacterSheet, r: Resolution, reason: string, causeEventId: string) {
    const xp = Math.min(r.rewards.xp, s.impactLimits.maxXp);
    const gold = Math.min(r.rewards.gold, s.impactLimits.maxGold);
    const prevLevel = c.level;
    c.xp += xp;
    c.gold += gold;
    for (const it of r.rewards.items) c.items[it] = Math.min(99, (c.items[it] ?? 0) + 1);
    c.level = levelForXp(c.xp);
    if (c.level > prevLevel) {
      c.max_hp += 2 * (c.level - prevLevel);
      c.hp = Math.min(c.max_hp, c.hp + 2 * (c.level - prevLevel));
    }
    if (c.hp <= 0 || c.condition === "down") {
      c.hp = 1;
      c.condition = "wounded";
    }
    // Rest after the adventure restores MP.
    c.mp = c.max_mp;

    const eventIds: string[] = [];
    const worldChanges: string[] = [];
    for (const w of r.worldEffects) {
      if (w.op === "set_fact") {
        const def = this.world.facts.find((f) => f.id === w.fact);
        if (!def || this.factEstablished(w.fact)) continue;
        const vis = w.visibility === "private" ? "secret" : "public";
        const evId = this.emit({
          type: "world.fact_established",
          accountId: ep.account_id,
          characterId: c.character_id,
          episodeId: ep.episode_id,
          visibility: vis === "public" ? "public" : "participants",
          causedBy: [causeEventId],
          payload: { fact_id: w.fact, summary: def.text },
        });
        this.sql.run(
          "INSERT INTO facts (id, text, status, visibility, source_event_ids, established_at) VALUES (?, ?, 'established', ?, ?, ?)",
          w.fact,
          def.text,
          vis,
          JSON.stringify([evId]),
          this.iso(),
        );
        this.learnFact(c.character_id, w.fact, evId);
        eventIds.push(evId);
        worldChanges.push(def.text);
      } else {
        const evId = this.emit({
          type: "world.entity_status_changed",
          accountId: ep.account_id,
          characterId: c.character_id,
          episodeId: ep.episode_id,
          visibility: "public",
          causedBy: [causeEventId],
          payload: { entity_id: w.entity, status: w.status, summary: `${w.entity} の状態が ${w.status} になった。` },
        });
        this.sql.run("UPDATE entities SET status = ?, revision = revision + 1 WHERE id = ?", w.status, w.entity);
        eventIds.push(evId);
      }
    }
    const summary = `${c.name}の冒険「${s.title}」は「${r.title}」で決着した（${outcomeName(r.outcome)}）。${r.epilogue}`;
    const evId = this.emit({
      type: "episode.completed",
      accountId: ep.account_id,
      characterId: c.character_id,
      episodeId: ep.episode_id,
      visibility: "participants",
      causedBy: [causeEventId],
      payload: { outcome: r.outcome, resolution_id: r.id, reason, rewards: { xp, gold, items: r.rewards.items }, summary },
    });
    eventIds.push(evId);
    this.sql.run(
      "UPDATE episodes SET outcome = ?, resolution_id = ?, summary = ?, completed_at = ? WHERE episode_id = ?",
      r.outcome,
      r.id,
      summary,
      this.iso(),
      ep.episode_id,
    );
    return {
      eventIds,
      conclusion: {
        outcome: r.outcome,
        outcome_name: outcomeName(r.outcome),
        title: r.title,
        epilogue: r.epilogue,
        reason,
        rewards: { xp, gold, items: r.rewards.items.map((i) => ({ id: i, name: this.items.get(i)?.name ?? i })) },
        level_up: c.level > prevLevel ? c.level : undefined,
        world_changes: worldChanges,
        summary,
      },
    };
  }

  private insertReplanRequest(accountId: string, ep: EpisodeRow, lost: string[]) {
    this.sql.run(
      "INSERT INTO feature_requests (id, account_id, episode_id, world_day, structured_intent, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)",
      randomId("frq"),
      accountId,
      ep.episode_id,
      this.today(),
      JSON.stringify({ kind: "replan", scenario: ep.scenario_id, lost_dependencies: lost }),
      this.iso(),
    );
  }

  private learnFact(characterId: string, factId: string, eventId: string) {
    const def = this.world.facts.find((f) => f.id === factId);
    if (!def) return;
    // Secret facts become known to the character without becoming public world facts.
    if (!one(this.sql, "SELECT 1 FROM facts WHERE id = ?", factId))
      this.sql.run(
        "INSERT INTO facts (id, text, status, visibility, source_event_ids, established_at) VALUES (?, ?, 'established', ?, ?, ?)",
        factId,
        def.text,
        def.visibility === "public" ? "public" : "secret",
        JSON.stringify([eventId]),
        this.iso(),
      );
    this.sql.run("INSERT OR IGNORE INTO knowledge (character_id, fact_id, learned_event_id) VALUES (?, ?, ?)", characterId, factId, eventId);
  }

  private pauseAdventure(accountId: string, episodeId: string) {
    const ep = this.loadEpisode(accountId, episodeId);
    if (ep.status !== "active") throw new GameError("INVALID_ACTION", `この冒険は中断できる状態ではありません（${ep.status}）。`);
    this.sql.run("UPDATE episodes SET status = 'paused', updated_at = ? WHERE episode_id = ?", this.iso(), episodeId);
    const ev = this.emit({
      type: "episode.paused",
      accountId,
      characterId: ep.character_id,
      episodeId,
      visibility: "participants",
      payload: { turn: ep.turn, summary: "冒険を中断した。" },
    });
    return {
      status: "paused",
      episode_id: episodeId,
      turn: ep.turn,
      event_ids: [ev],
      next_step: "resume_game で再開できます（冒険権は再消費しません）。",
    };
  }

  private resumeGame(accountId: string, characterId: string) {
    const c = this.ownedCharacter(accountId, characterId);
    const ep = this.openEpisode(characterId);
    const last = one<EpisodeRow>(
      this.sql,
      "SELECT * FROM episodes WHERE character_id = ? AND status = 'completed' ORDER BY completed_at DESC LIMIT 1",
      characterId,
    );
    const completedCount = one<{ n: number }>(this.sql, "SELECT COUNT(*) AS n FROM episodes WHERE character_id = ? AND status = 'completed'", characterId)?.n ?? 0;
    let active: Json | null = null;
    if (ep) {
      const s = this.scenarioFor(ep);
      const st = JSON.parse(ep.state) as EpisodeState;
      const recent = this.sql
        .all<{ payload: string }>(
          "SELECT payload FROM world_events WHERE episode_id = ? AND type = 'episode.action_resolved' ORDER BY seq DESC LIMIT 3",
          ep.episode_id,
        )
        .map((r) => (JSON.parse(r.payload) as Json).summary)
        .reverse();
      active = {
        ...this.sceneView(c, s, st, ep.episode_id, ep.turn, ep.status),
        hook: s.hook,
        recap: recent,
        narration_guidance: `${ep.status === "paused" ? "中断していた冒険を再開する。" : ""}これまでのあらすじ（recap）を短く伝え、現在の場面を描写して次の行動を尋ねる。`,
      };
    }
    return {
      character: this.publicSheet(c),
      active_episode: active,
      last_result: last ? { episode_id: last.episode_id, outcome: last.outcome, summary: last.summary } : null,
      play_budget: this.playBudget(accountId),
      world_intro: completedCount === 0 ? this.world.intro : undefined,
      world_news: this.sql
        .all<{ text: string }>("SELECT text FROM facts WHERE visibility = 'public' ORDER BY established_at DESC LIMIT 5")
        .map((f) => f.text),
      gm_guidance: GM_INSTRUCTIONS,
      next_step: active
        ? "active_episode の場面から再開する。行動の前に get_actions を確認する。"
        : "get_adventures で冒険の候補を確認する。",
    };
  }

  private getHistory(accountId: string, characterId: string, cursor?: number, limit = 20) {
    this.ownedCharacter(accountId, characterId);
    const rows = this.sql.all<{ seq: number; event_id: string; type: string; episode_id: string | null; world_day: string; payload: string; created_at: string }>(
      `SELECT seq, event_id, type, episode_id, world_day, payload, created_at FROM world_events
       WHERE character_id = ? ${cursor ? "AND seq < ?" : ""} ORDER BY seq DESC LIMIT ?`,
      ...(cursor ? [characterId, cursor, limit] : [characterId, limit]),
    );
    const episodes = this.sql.all<{ episode_id: string; scenario_id: string; outcome: string | null; summary: string | null; started_at: string; status: string }>(
      "SELECT episode_id, scenario_id, outcome, summary, started_at, status FROM episodes WHERE character_id = ? ORDER BY started_at DESC LIMIT 20",
      characterId,
    );
    return {
      events: rows.map((r) => ({
        event_id: r.event_id,
        type: r.type,
        episode_id: r.episode_id,
        world_day: r.world_day,
        summary: (JSON.parse(r.payload) as Json).summary,
        created_at: r.created_at,
      })),
      episodes,
      next_cursor: rows.length === limit ? rows[rows.length - 1]?.seq : null,
    };
  }

  private getRules(topic?: string) {
    if (topic) {
      const text = RULE_TOPICS[topic];
      if (!text) throw new GameError("NOT_FOUND", "そのトピックはありません。", { topics: Object.keys(RULE_TOPICS) });
      return { rules_version: RULES_VERSION, topic, text };
    }
    return {
      rules_version: RULES_VERSION,
      topics: RULE_TOPICS,
      races: this.world.races.map((r) => ({ id: r.id, name: r.name, description: r.description, bonus: r.bonus })),
      classes: this.world.classes.map((c) => ({ id: c.id, name: c.name, hp: c.hp, mp: c.mp, trained_skills: c.trainedSkills, spells: c.spells })),
    };
  }

  private rateAdventure(accountId: string, input: Json) {
    const ep = this.loadEpisode(accountId, String(input.episode_id));
    if (ep.status !== "completed") throw new GameError("INVALID_ACTION", "評価は冒険の完了後にできます。");
    this.sql.transaction(() => {
      this.sql.run(
        "INSERT INTO ratings (episode_id, account_id, score, comment, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(episode_id) DO UPDATE SET score = excluded.score, comment = excluded.comment",
        ep.episode_id,
        accountId,
        Number(input.score),
        input.comment ? sanitizeText(String(input.comment), 1000) : null,
        this.iso(),
      );
    });
    return { status: "recorded", episode_id: ep.episode_id, score: input.score };
  }

  // ------------------------------------------------------------ helpers

  private host(c: CharacterSheet, st: EpisodeState, s: CompiledScenario, dice: DiceStream, turn: number): Host {
    return {
      turn: () => turn,
      hasItem: (item) => (c.items[item] ?? 0) > 0,
      gold: () => c.gold,
      spawnEnemy: (enemyId) => {
        const m = this.enemyDef(s, enemyId);
        const hp = m?.hp ?? 5;
        return { hp, maxHp: hp };
      },
      applyCharacterEffect: (e) => {
        switch (e.op) {
          case "damage": {
            const d = dice.roll(e.amount);
            c.hp = Math.max(0, c.hp - d);
            c.condition = c.hp <= 0 ? "down" : "wounded";
            return `${d}のダメージを受けた（HP ${c.hp}/${c.max_hp}）。`;
          }
          case "heal": {
            const before = c.hp;
            c.hp = Math.min(c.max_hp, c.hp + dice.roll(e.amount));
            return `HPが${c.hp - before}回復した。`;
          }
          case "give_item":
            c.items[e.item] = Math.min(99, (c.items[e.item] ?? 0) + e.qty);
            return `${this.items.get(e.item)?.name ?? e.item}を手に入れた。`;
          case "take_item":
            removeItem(c, e.item, e.qty);
            return undefined;
          case "gold": {
            const before = c.gold;
            c.gold = Math.max(0, c.gold + e.amount);
            return c.gold > before ? `${c.gold - before}ゴールドを得た。` : `${before - c.gold}ゴールドを失った。`;
          }
          case "relation": {
            c.relations[e.npc] = Math.max(-100, Math.min(100, (c.relations[e.npc] ?? 0) + e.delta));
            return undefined;
          }
        }
      },
    };
  }

  private readHost(c: CharacterSheet, turn: number) {
    return { turn: () => turn, hasItem: (item: string) => (c.items[item] ?? 0) > 0, gold: () => c.gold };
  }

  private emit(e: {
    type: string;
    accountId?: string;
    characterId?: string;
    episodeId?: string;
    visibility: "public" | "participants" | "private";
    payload: Json;
    causedBy?: string[];
  }): string {
    const eventId = randomId("evt");
    this.sql.run(
      `INSERT INTO world_events (event_id, type, account_id, character_id, episode_id, world_day, payload, caused_by, visibility, rule_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      e.type,
      e.accountId ?? null,
      e.characterId ?? null,
      e.episodeId ?? null,
      this.today(),
      JSON.stringify(e.payload),
      JSON.stringify(e.causedBy ?? []),
      e.visibility,
      RULES_VERSION,
      this.iso(),
    );
    if (e.visibility === "public")
      this.sql.run("INSERT INTO outbox (event_id, destination, status) VALUES (?, 'chronicle', 'pending')", eventId);
    return eventId;
  }

  private audit(actor: string, action: string, target: string | null, reason: string | null, details?: Json) {
    this.sql.run(
      "INSERT INTO audit_log (id, actor, action, target, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      randomId("aud"),
      actor,
      action,
      target,
      reason,
      details ? JSON.stringify(details) : null,
      this.iso(),
    );
  }

  private revision(): number {
    return one<{ seq: number }>(this.sql, "SELECT MAX(seq) AS seq FROM world_events")?.seq ?? 0;
  }

  private today(): string {
    return worldDay(this.now());
  }

  private iso(): string {
    return this.now().toISOString();
  }
}

interface ActInput {
  episode_id: string;
  action_id: string;
  parameters?: Record<string, string>;
  expected_turn: number;
  request_id: string;
}

function phaseFor(turn: number, target: number, status: string): string {
  if (status === "completed") return "epilogue";
  if (turn < 2) return "intro";
  if (turn < target * 0.5) return "exploration";
  if (turn < target * 0.8) return "turning_point";
  return "climax";
}

function outcomeName(o: string): string {
  return { success: "成功", partial: "部分的な決着", failure: "失敗", withdrawn: "撤退" }[o] ?? o;
}

function raceName(world: WorldDef, race: string): string {
  return world.races.find((r) => r.id === race)?.name ?? race;
}

function removeItem(c: CharacterSheet, item: string, qty: number) {
  const have = c.items[item] ?? 0;
  if (have <= qty) delete c.items[item];
  else c.items[item] = have - qty;
}

function diffItems(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[k] ?? 0) - (a[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from user text
const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮]/g;

function sanitizeName(s: string, max: number): string {
  const v = s.replace(CONTROL, "").trim().slice(0, max);
  if (!v) throw new GameError("INVALID_INPUT", "名前が空です。");
  return v;
}

function sanitizeText(s: string, max: number): string {
  return s.replace(CONTROL, " ").trim().slice(0, max);
}

export { evalCond };
