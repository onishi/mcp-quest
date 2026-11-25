/**
 * Storage abstraction. The kernel talks to a synchronous SQLite interface so
 * that the same code runs inside a Durable Object (ctx.storage.sql) and in
 * Node tests (node:sqlite). All writes for one command happen in one
 * transaction (spec §13.2).
 */
export type SqlValue = string | number | null;

export interface Sql {
  all<T = Record<string, SqlValue>>(query: string, ...params: SqlValue[]): T[];
  run(query: string, ...params: SqlValue[]): void;
  transaction<T>(fn: () => T): T;
}

export function one<T>(sql: Sql, query: string, ...params: SqlValue[]): T | undefined {
  return sql.all<T>(query, ...params)[0];
}

export const KERNEL_VERSION = "kernel@0.1.0";

/** Ordered migrations. Never edit an applied migration; append a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL,
    status TEXT NOT NULL, trust_level TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS identities (
    issuer TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (issuer, subject)
  );
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS restrictions (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, scope TEXT NOT NULL, reason TEXT NOT NULL,
    expires_at TEXT, created_at TEXT NOT NULL, lifted_at TEXT, created_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adventure_credits (
    account_id TEXT PRIMARY KEY, balance INTEGER NOT NULL, last_granted_day TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS components (
    entity_id TEXT NOT NULL, component_type TEXT NOT NULL, schema_version INTEGER NOT NULL,
    value TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entity_id, component_type)
  );
  CREATE TABLE IF NOT EXISTS facts (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL, visibility TEXT NOT NULL,
    source_event_ids TEXT NOT NULL DEFAULT '[]', established_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    character_id TEXT NOT NULL, fact_id TEXT NOT NULL, learned_event_id TEXT NOT NULL,
    PRIMARY KEY (character_id, fact_id)
  );
  CREATE TABLE IF NOT EXISTS scenarios (
    id TEXT NOT NULL, version INTEGER NOT NULL, schema_version INTEGER NOT NULL, digest TEXT NOT NULL,
    compiled TEXT NOT NULL, status TEXT NOT NULL, registered_at TEXT NOT NULL,
    PRIMARY KEY (id, version)
  );
  CREATE TABLE IF NOT EXISTS episodes (
    episode_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, account_id TEXT NOT NULL,
    scenario_id TEXT NOT NULL, scenario_version INTEGER NOT NULL, scenario_digest TEXT NOT NULL,
    status TEXT NOT NULL, phase TEXT NOT NULL, turn INTEGER NOT NULL, state TEXT NOT NULL,
    rng_seed TEXT NOT NULL, rule_versions TEXT NOT NULL, outcome TEXT, resolution_id TEXT,
    summary TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS episodes_by_character ON episodes (character_id, status);
  CREATE TABLE IF NOT EXISTS dependencies (
    episode_id TEXT NOT NULL, entity_id TEXT NOT NULL, predicate TEXT NOT NULL, expected_value TEXT NOT NULL,
    PRIMARY KEY (episode_id, entity_id, predicate)
  );
  CREATE TABLE IF NOT EXISTS world_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
    account_id TEXT, character_id TEXT, episode_id TEXT, world_day TEXT NOT NULL,
    payload TEXT NOT NULL, caused_by TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL,
    rule_version TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_character ON world_events (character_id, seq);
  CREATE TABLE IF NOT EXISTS command_receipts (
    account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, tool TEXT NOT NULL,
    payload_hash TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS outbox (
    event_id TEXT PRIMARY KEY, destination TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, next_retry TEXT
  );
  CREATE TABLE IF NOT EXISTS feature_requests (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, episode_id TEXT, world_day TEXT NOT NULL,
    structured_intent TEXT NOT NULL, status TEXT NOT NULL, source_event_id TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ratings (
    episode_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, score INTEGER NOT NULL, comment TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
    reason TEXT, details TEXT, created_at TEXT NOT NULL
  );
  `,
];

export function migrate(sql: Sql): void {
  sql.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(sql.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));
  MIGRATIONS.forEach((m, i) => {
    if (applied.has(i + 1)) return;
    sql.transaction(() => {
      for (const stmt of m.split(";").map((s) => s.trim()).filter(Boolean)) sql.run(stmt);
      sql.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", i + 1, new Date().toISOString());
    });
  });
}
