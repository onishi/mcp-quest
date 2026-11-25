/**
 * Player MCP endpoint (Streamable HTTP, stateless). Each request builds a
 * fresh McpServer bound to the authenticated account and forwards tool calls
 * to the World DO. The server never calls an LLM; summaries are templates.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { GM_INSTRUCTIONS, TOOLS } from "@mcp-quest/kernel";
import { type AuthProps, type Env, worldStub } from "./env.js";

export const SERVER_VERSION = "0.1.0";

export function buildServer(env: Env, props: AuthProps): McpServer {
  const server = new McpServer({ name: "mcp-quest", version: SERVER_VERSION }, { instructions: GM_INSTRUCTIONS });
  const stub = worldStub(env);
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          title: def.title,
          readOnlyHint: !def.write,
          destructiveHint: def.destructive ?? false,
          idempotentHint: def.write, // writes are idempotent per request_id
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const res = await stub.tool(props.accountId, def.name, args ?? {});
        if (!res.ok && res.error) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `${res.error.code}: ${res.error.message}\n${JSON.stringify({ error: res.error })}` }],
            structuredContent: { error: res.error },
          };
        }
        const result = res.result as Record<string, unknown>;
        return {
          content: [{ type: "text" as const, text: `${summarize(def.name, result)}\n${JSON.stringify(result)}` }],
          structuredContent: result,
        };
      },
    );
  }
  return server;
}

/** Fixed-template one-line summary (no LLM). */
function summarize(tool: string, r: Record<string, any>): string {
  switch (tool) {
    case "act": {
      const done = r.progress?.episode_complete;
      return `[turn ${r.turn}] ${(r.narration ?? []).join(" ")}${done ? ` 【決着: ${r.conclusion?.title}】` : ""}`;
    }
    case "start_adventure":
      return `冒険「${r.adventure?.title}」開始（episode_id=${r.episode_id}, turn=${r.turn}）`;
    case "observe":
      return `[turn ${r.turn}] ${r.scene?.name}: ${r.scene?.description}`;
    case "resume_game":
      return r.active_episode ? `進行中の冒険があります（episode_id=${r.active_episode.episode_id}）` : "進行中の冒険はありません";
    default:
      return `${tool} ok`;
  }
}

export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: AuthProps }).props;
    if (!props?.accountId) return new Response("unauthorized", { status: 401 });
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null }), {
        status: 405,
        headers: { "content-type": "application/json", allow: "POST" },
      });
    }
    const server = buildServer(env, props);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      ctx.waitUntil(server.close());
    }
  },
};
