/**
 * End-to-end smoke test against a running game Worker (wrangler dev or a
 * deployed URL). Exercises: admin invite → OAuth (DCR + PKCE + invite
 * registration with a fake Google IdP) → MCP tools → second session via a fresh
 * Google login → resume → suspension. Local only (needs the fake-IdP .dev.vars).
 *
 *   BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=dev-admin-token npx tsx scripts/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "node:http";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_TOKEN ?? "dev-admin-token";
const REDIRECT = "http://localhost:9999/callback";

function b64url(buf: ArrayBuffer | Uint8Array) {
  return Buffer.from(buf as Uint8Array).toString("base64url");
}

// --- fake Google (OIDC) for local runs. wrangler dev must point at it via .dev.vars:
//   GOOGLE_CLIENT_ID=fake-client  GOOGLE_CLIENT_SECRET=fake-secret
//   OIDC_AUTHORIZE_URL=http://127.0.0.1:9898/authorize  OIDC_TOKEN_URL=http://127.0.0.1:9898/token  OIDC_ISSUER=http://127.0.0.1:9898
const IDP_PORT = 9898;
let currentSub = "google-user-1";
const codes = new Map<string, { nonce: string; sub: string }>();
const idp = createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", `http://127.0.0.1:${IDP_PORT}`);
  if (u.pathname === "/authorize") {
    const code = `code-${Math.random().toString(36).slice(2)}`;
    codes.set(code, { nonce: u.searchParams.get("nonce") ?? "", sub: currentSub });
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", u.searchParams.get("state")!);
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }
  if (u.pathname === "/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const p = new URLSearchParams(body);
    const c = codes.get(p.get("code") ?? "");
    if (!c || p.get("client_secret") !== "fake-secret" || !p.get("code_verifier")) return void res.writeHead(400).end("{}");
    const claims = { iss: `http://127.0.0.1:${IDP_PORT}`, aud: p.get("client_id"), sub: c.sub, nonce: c.nonce, exp: Math.floor(Date.now() / 1000) + 300, given_name: "スモーク" };
    const jwt = `${b64url(Buffer.from('{"alg":"none"}'))}.${b64url(Buffer.from(JSON.stringify(claims)))}.`;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id_token: jwt, access_token: "x" }));
    return;
  }
  res.writeHead(404).end();
});

class Jar {
  private c = new Map<string, string>();
  take(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv!.indexOf("=");
      this.c.set(kv!.slice(0, i), kv!.slice(i + 1));
    }
  }
  get header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

/** Run the full authorization: consent → (fake) Google → optional first-time invite → token. */
async function oauth(clientId: string, opts: { sub: string; invite?: string; displayName?: string }) {
  currentSub = opts.sub;
  const jar = new Jar();
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, state: "xyz", scope: "game:play",
    code_challenge: challenge, code_challenge_method: "S256", resource: `${BASE}/mcp`,
  });
  const authUrl = `${BASE}/authorize?${q}`;
  const page = await fetch(authUrl);
  if (!page.ok) throw new Error(`authorize GET ${page.status}: ${await page.text()}`);
  jar.take(page);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())?.[1];
  if (!handle) throw new Error("no consent handle");
  const approve = await fetch(authUrl, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
  jar.take(approve);
  const toIdp = approve.headers.get("location");
  if (!toIdp?.startsWith(`http://127.0.0.1:${IDP_PORT}/authorize`)) throw new Error(`expected redirect to IdP, got ${approve.status} ${toIdp}`);
  const fromIdp = (await fetch(toIdp, { redirect: "manual" })).headers.get("location")!;
  let res = await fetch(fromIdp, { redirect: "manual", headers: { cookie: jar.header } });
  jar.take(res);
  if (res.status === 200) {
    // first time: invite form
    const html = await res.text();
    const action = /<form method="post" action="([^"]+)">\s*<input type="hidden" name="mode" value="register">/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    if (!action || !opts.invite) throw new Error(`first-time page without invite: ${html.slice(0, 300)}`);
    res = await fetch(new URL(action, BASE), {
      method: "POST", redirect: "manual",
      headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ mode: "register", invite: opts.invite, display_name: opts.displayName ?? "スモーク" }),
    });
    jar.take(res);
  }
  const location = res.headers.get("location");
  if (!location?.startsWith(REDIRECT)) throw new Error(`authorization failed: ${res.status} ${location ?? (await res.text()).slice(0, 300)}`);
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in ${location}`);
  const tok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` }),
  });
  const tj = (await tok.json()) as { access_token?: string };
  if (!tj.access_token) throw new Error(`token failed: ${JSON.stringify(tj)}`);
  return { token: tj.access_token };
}

async function mcp(token: string) {
  const client = new Client({ name: "smoke", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const sc = r.structuredContent as any;
    if (r.isError) throw Object.assign(new Error(`${name}: ${JSON.stringify(sc?.error ?? r.content)}`), { sc });
    return sc;
  };
  return { client, call };
}

const rid = () => `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const log = (...a: unknown[]) => console.log("•", ...a);

async function main() {
  await new Promise<void>((r) => idp.listen(IDP_PORT, "127.0.0.1", r));
  // 1. admin creates an invite
  const inv = await fetch(`${BASE}/admin/invites`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{}" });
  const { code } = (await inv.json()) as { code: string };
  log("invite", code);

  // 2. dynamic client registration (what Claude/ChatGPT do)
  const reg = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Smoke Test Client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  const { client_id } = (await reg.json()) as { client_id: string };
  log("client", client_id);

  // 3. register via invite
  const sub = `google-${Date.now()}`;
  const first = await oauth(client_id, { sub, invite: code, displayName: "スモーク" });
  log("registered via Google + invite");
  try {
    await oauth(client_id, { sub: `stranger-${Date.now()}` });
    throw new Error("expected unknown Google user without invite to be refused");
  } catch (e: any) {
    if (!String(e.message).includes("first-time page without invite")) throw e;
    log("unknown Google user without invite → asked for invite code");
  }

  // unauthenticated MCP is rejected
  const unauth = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (unauth.status !== 401) throw new Error(`expected 401, got ${unauth.status}`);
  log("unauthenticated /mcp → 401");

  // 4. play in "chat A"
  const a = await mcp(first.token);
  const tools = await a.client.listTools();
  log("tools", tools.tools.map((t) => t.name).join(","));
  const created = await a.call("create_character", { name: "スモーク", race: "dwarf", class: "cleric", request_id: rid() });
  const chr = created.character.character_id;
  const adv = await a.call("get_adventures", { character_id: chr });
  log("adventures", adv.adventures.map((x: any) => `${x.adventure_id}:${x.available}`).join(" "));
  const started = await a.call("start_adventure", { character_id: chr, adventure_id: "goblin_village", request_id: rid() });
  const ep = started.episode_id;
  let turn = started.turn;
  const r1 = await a.call("act", { episode_id: ep, action_id: "talk", parameters: { target_id: "marta" }, expected_turn: turn, request_id: rid() });
  turn = r1.turn;
  log(`act turn ${turn}:`, r1.narration.join(" ").slice(0, 80));
  const req = rid();
  const r2 = await a.call("act", { episode_id: ep, action_id: "move", parameters: { to: "mine_entrance" }, expected_turn: turn, request_id: req });
  const r2b = await a.call("act", { episode_id: ep, action_id: "move", parameters: { to: "mine_entrance" }, expected_turn: turn, request_id: req });
  if (!r2b.replayed || r2b.turn !== r2.turn) throw new Error("idempotent replay failed");
  log("retransmission replayed without double execution");
  try {
    await a.call("act", { episode_id: ep, action_id: "investigate", parameters: { target_id: "tracks" }, expected_turn: turn, request_id: rid() });
    throw new Error("expected STALE_STATE");
  } catch (e: any) {
    if (!String(e.message).includes("STALE_STATE")) throw e;
    log("stale turn rejected");
  }
  await a.call("pause_adventure", { episode_id: ep, request_id: rid() });
  await a.client.close();

  // 5. "chat B": a fresh OAuth login with the access key, then resume
  const second = await oauth(client_id, { sub });
  const b = await mcp(second.token);
  const resumed = await b.call("resume_game", { character_id: chr });
  if (resumed.active_episode?.episode_id !== ep || resumed.active_episode.turn !== r2.turn) throw new Error("resume mismatch");
  log(`resumed from another session at turn ${resumed.active_episode.turn}, status ${resumed.active_episode.episode_status}`);
  const budget = await b.call("get_play_budget");
  log("credits remaining", budget.play_budget.adventure_credits);
  const w = await b.call("act", { episode_id: ep, action_id: "withdraw", parameters: {}, expected_turn: resumed.active_episode.turn, request_id: rid() });
  log("concluded:", w.conclusion.outcome, w.conclusion.title);
  await b.client.close();

  // 6. admin: suspend takes effect immediately
  const acc = (await (await fetch(`${BASE}/admin/accounts`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as any[];
  const me = acc.find((x) => x.display_name === "スモーク" && x.status === "active");
  await fetch(`${BASE}/admin/accounts/${me.account_id}/suspend`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "smoke test" }) });
  const c = await mcp(second.token);
  try {
    await c.call("get_my_account");
    throw new Error("expected RESTRICTED");
  } catch (e: any) {
    if (!String(e.message).includes("RESTRICTED")) throw e;
    log("suspension applied immediately");
  }
  await fetch(`${BASE}/admin/accounts/${me.account_id}/restore`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "smoke test done" }) });
  await c.client.close();

  const home = await fetch(`${BASE}/`);
  log("public page", home.status);
  console.log("\nSMOKE OK");
  idp.close();
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
