import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { appHandler } from "./app.js";
import type { Env } from "./env.js";
import { mcpApiHandler } from "./mcp.js";

export { WorldDO } from "./world-do.js";

const providers = new Map<string, OAuthProvider<Env>>();

/** The OAuth provider needs the canonical resource URL, which depends on the deployment origin. */
function providerFor(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApiHandler,
      defaultHandler: appHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["game:play"],
      accessTokenTTL: 3600,
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: "MCP Quest" },
    });
    providers.set(origin, p);
  }
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = env.PUBLIC_ORIGIN || new URL(request.url).origin;
    return providerFor(origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
