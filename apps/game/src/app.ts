/**
 * Non-MCP routes: OAuth authorize UI, public world page (M17), health, and
 * the internal admin API (M13). Admin requires a bearer token and every
 * mutating admin call needs a reason, which is written to the audit log.
 */
import { handleAuthorize, handleCallback } from "./auth.js";
import { type Env, worldStub } from "./env.js";
import { escapeHtml, page } from "./html.js";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) return json({ error: "unauthorized" }, 401);
  const stub = worldStub(env);
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const parts = url.pathname.replace(/^\/admin\/?/, "").split("/").filter(Boolean);
  const actor = String(request.headers.get("x-admin-actor") ?? "admin").slice(0, 64);
  const needReason = () => {
    if (!body.reason || String(body.reason).trim().length < 3) throw new Error("reason is required");
  };
  let op: string;
  const args: Record<string, unknown> = { ...body, actor };
  try {
    const [a, b, c] = parts;
    if (request.method === "POST" && a === "invites") op = "createInvite";
    else if (request.method === "GET" && a === "accounts" && !b) op = "listAccounts";
    else if (request.method === "GET" && a === "accounts" && b) (op = "accountActivity"), (args.accountId = b);
    else if (request.method === "POST" && a === "accounts" && b && c === "suspend") (needReason(), (op = "suspend"), (args.accountId = b));
    else if (request.method === "POST" && a === "accounts" && b && c === "restore") (needReason(), (op = "restore"), (args.accountId = b));
    else if (request.method === "POST" && a === "accounts" && b && c === "restrictions") (needReason(), (op = "restrict"), (args.accountId = b));
    else if (request.method === "POST" && a === "accounts" && b && c === "refund") (needReason(), (op = "refund"), (args.accountId = b));
    else if (request.method === "POST" && a === "restrictions" && b && c === "lift") (needReason(), (op = "lift"), (args.restrictionId = b));
    else if (request.method === "GET" && a === "audit") op = "audit";
    else if (request.method === "GET" && a === "feature-requests") op = "featureRequests";
    else if (request.method === "GET" && a === "outbox") op = "outbox";
    else return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String((e as Error).message) }, 400);
  }
  const res = await stub.admin(op, args);
  return json(res.ok ? res.result ?? { ok: true } : { error: res.error }, res.ok ? 200 : 400);
}

async function publicHome(env: Env, url: URL): Promise<Response> {
  const res = await worldStub(env).publicSnapshot();
  const s = res.result;
  if (!res.ok || !s) return page("MCP Quest", `<h1>MCP Quest</h1><p class="error">現在、世界の情報を取得できません。プレイには影響しない場合があります。</p>`, 503);
  const facts = s.facts.map((f) => `<li>${escapeHtml(f.text)} <span class="muted">${escapeHtml(f.established_at.slice(0, 10))}</span></li>`).join("");
  const recent = s.recent.map((r) => `<li>${escapeHtml(String(r.summary ?? ""))} <span class="muted">${escapeHtml(r.world_day)}</span></li>`).join("");
  return page(
    "MCP Quest",
    `<h1>MCP Quest</h1>
     <p class="muted">一日一話、あなたの冒険が世界の歴史になる。</p>
     <section class="card"><h2>${escapeHtml(s.world.name)}の現在（世界日 ${escapeHtml(s.world.day)}）</h2><p>${escapeHtml(s.world.intro)}</p></section>
     <h2>世界の出来事</h2><ul class="timeline">${recent || "<li class='muted'>まだ公開された出来事はありません。</li>"}</ul>
     <h2>確定した事実</h2><ul class="timeline">${facts}</ul>
     <section class="card"><h2>遊び方</h2>
       <p>現在は招待制です。招待コードをお持ちの方は、Claude などリモートMCPに対応したAIクライアントでカスタムコネクタを追加し、次のURLを指定してください。</p>
       <p><code>${escapeHtml(`${url.origin}/mcp`)}</code></p>
       <p class="muted">冒険者 ${s.stats.accounts} 人 / 完了した冒険 ${s.stats.completed_adventures} 件</p></section>`,
  );
}

export const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = env.PUBLIC_ORIGIN || url.origin;
    if (url.pathname === "/authorize") return handleAuthorize(request, env, origin);
    if (url.pathname === "/callback") return handleCallback(request, env, origin);
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname === "/api/world" && request.method === "GET") {
      const res = await worldStub(env).publicSnapshot();
      return json(res.ok ? res.result : { error: res.error }, res.ok ? 200 : 503);
    }
    if (url.pathname.startsWith("/admin")) return handleAdmin(request, env, url);
    if (url.pathname === "/" && request.method === "GET") return publicHome(env, url);
    return new Response("not found", { status: 404 });
  },
};
