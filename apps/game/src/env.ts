import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { RpcResult } from "./world-do.js";

/**
 * Runtime bindings. By design (R-LLM-03) there is no AI binding, no LLM API
 * key and no binding that can start the Evolution pipeline.
 */
export interface Env {
  WORLD: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Name of the world instance; separates production / staging / development worlds. */
  WORLD_INSTANCE: string;
  /** Canonical public origin (e.g. https://quest.example.com). Falls back to the request origin. */
  PUBLIC_ORIGIN?: string;
  /** Google OAuth client (identity only; not an LLM credential). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Local development only: point the OIDC flow at a fake IdP. Leave unset in deployed environments. */
  OIDC_AUTHORIZE_URL?: string;
  OIDC_TOKEN_URL?: string;
  OIDC_ISSUER?: string;
  /** Bearer token for the internal admin API (not an LLM credential). */
  ADMIN_TOKEN?: string;
}

export interface AuthProps {
  accountId: string;
}

type Obj = Record<string, any>;

/** Typed view of the World DO RPC surface (see world-do.ts). */
export interface WorldApi {
  tool(accountId: string, name: string, input: unknown): Promise<RpcResult<Obj>>;
  resolveIdentity(issuer: string, subject: string): Promise<RpcResult<string | null>>;
  redeemInvite(input: { code: string; displayName: string; issuer: string; subject: string }): Promise<RpcResult<{ account_id: string }>>;
  linkIdentity(input: { fromIssuer: string; fromSubject: string; toIssuer: string; toSubject: string }): Promise<RpcResult<{ account_id: string }>>;
  accountStatus(accountId: string): Promise<RpcResult<string | null>>;
  admin(op: string, args: Obj): Promise<RpcResult<unknown>>;
  publicSnapshot(): Promise<
    RpcResult<{
      world: { id: string; name: string; intro: string; day: string };
      facts: Array<{ id: string; text: string; established_at: string }>;
      recent: Array<{ type: string; world_day: string; summary: unknown }>;
      stats: { accounts: number; completed_adventures: number };
    }>
  >;
}

export function worldStub(env: Env): WorldApi {
  return env.WORLD.get(env.WORLD.idFromName(env.WORLD_INSTANCE || "dev")) as unknown as WorldApi;
}
