import { DatabaseSync } from "node:sqlite";
import type { Sql, SqlValue } from "@mcp-quest/kernel";

/** node:sqlite adapter implementing the kernel's Sql interface (tests only). */
export function memorySql(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  let depth = 0;
  return {
    db,
    all<T>(query: string, ...params: SqlValue[]): T[] {
      return db.prepare(query).all(...params) as T[];
    },
    run(query: string, ...params: SqlValue[]) {
      db.prepare(query).run(...params);
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) throw new Error("nested transaction");
      depth++;
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
