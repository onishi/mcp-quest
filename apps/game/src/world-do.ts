/**
 * World Durable Object: the single authoritative writer for one world
 * (spec §12). Holds the Kernel over DO SQLite. No AI bindings, no secrets
 * for LLMs, no outbound network.
 */
import { DurableObject } from "cloudflare:workers";
import { type CompiledWorld, GameError, Kernel, type Sql, type SqlValue, compileWorld } from "@mcp-quest/kernel";
import { eldiaWorld } from "@mcp-quest/world";
import type { Env } from "./env.js";

export type RpcError = ReturnType<GameError["toJSON"]>["error"];
/** RPC-friendly result (exceptions do not keep their class across RPC). */
export interface RpcResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: RpcError;
}

let compiledPromise: Promise<CompiledWorld> | undefined;
function compiled() {
  compiledPromise ??= compileWorld(eldiaWorld);
  return compiledPromise;
}

function doSql(storage: DurableObjectStorage): Sql {
  return {
    all<T>(query: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(query, ...params).toArray() as T[];
    },
    run(query: string, ...params: SqlValue[]) {
      storage.sql.exec(query, ...params).toArray();
    },
    transaction<T>(fn: () => T): T {
      return storage.transactionSync(fn);
    },
  };
}

export class WorldDO extends DurableObject<Env> {
  private kernel!: Kernel;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const { world, scenarios } = await compiled();
      this.kernel = new Kernel({ sql: doSql(ctx.storage), world, scenarios });
      this.kernel.init();
    });
  }

  private wrap<T>(fn: () => T): RpcResult<T> {
    try {
      return { ok: true, result: fn() };
    } catch (e) {
      if (e instanceof GameError) return { ok: false, error: e.toJSON().error };
      console.error("kernel error", e);
      return { ok: false, error: new GameError("TEMPORARY_UNAVAILABLE", "サーバー内部エラーです。").toJSON().error };
    }
  }

  // Player tools — accountId comes from verified OAuth props only.
  tool(accountId: string, name: string, input: unknown) {
    return this.wrap(() => this.kernel.call(accountId, name, input));
  }

  // Auth
  resolveIdentity(issuer: string, subject: string) {
    return this.wrap(() => this.kernel.resolveIdentity(issuer, subject) ?? null);
  }
  redeemInvite(input: { code: string; displayName: string; issuer: string; subject: string }) {
    return this.wrap(() => this.kernel.redeemInvite(input));
  }
  linkIdentity(input: { fromIssuer: string; fromSubject: string; toIssuer: string; toSubject: string }) {
    return this.wrap(() => this.kernel.linkIdentity(input));
  }
  accountStatus(accountId: string) {
    return this.wrap(() => this.kernel.listAccounts().find((a) => a.account_id === accountId)?.status ?? null);
  }

  // Admin (called only from the admin router after bearer auth)
  admin(op: string, args: Record<string, unknown>) {
    const k = this.kernel;
    const actor = String(args.actor ?? "admin");
    return this.wrap(() => {
      switch (op) {
        case "createInvite":
          return k.createInvite({ createdBy: actor, maxUses: args.maxUses as number | undefined, expiresAt: args.expiresAt as string | undefined });
        case "listAccounts":
          return k.listAccounts();
        case "accountActivity":
          return k.getAccountActivity(String(args.accountId));
        case "suspend":
          return k.setAccountStatus(actor, String(args.accountId), "suspended", String(args.reason ?? ""));
        case "restore":
          return k.setAccountStatus(actor, String(args.accountId), "active", String(args.reason ?? ""));
        case "restrict":
          return k.addRestriction(actor, {
            accountId: String(args.accountId),
            scope: String(args.scope ?? "game:play"),
            reason: String(args.reason ?? ""),
            expiresAt: args.expiresAt as string | undefined,
          });
        case "lift":
          return k.liftRestriction(actor, String(args.restrictionId), String(args.reason ?? ""));
        case "refund":
          return k.refundCredit(actor, String(args.accountId), String(args.reason ?? ""));
        case "audit":
          return k.auditLog();
        case "featureRequests":
          return k.featureRequests();
        case "outbox":
          return k.pendingOutbox();
        default:
          throw new GameError("NOT_FOUND", `unknown admin op ${op}`);
      }
    });
  }

  // Public read model (no private data)
  publicSnapshot() {
    return this.wrap(() => this.kernel.publicSnapshot());
  }
}
