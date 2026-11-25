/**
 * End-to-end smoke test against a running game Worker (wrangler dev or a
 * deployed URL). Exercises: admin invite → OAuth (DCR + PKCE + invite
 * registration) → MCP tools → second session via access-key login → resume.
 *
 *   BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=dev-admin-token npx tsx scripts/smoke.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const ADMIN = process.env.ADMIN_TOKEN ?? "dev-admin-token";
const REDIRECT = "http://localhost:9999/callback";

function b64url(buf: ArrayBuffer | Uint8Array) {
  return Buffer.from(buf as Uint8Array).toString("base64url");
}

async function oauth(clientId: string, form: Record<string, string>) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "xyz",
    scope: "game:play",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
  });
  const authUrl = `${BASE}/authorize?${q}`;
  const page = await fetch(authUrl);
  if (!page.ok) throw new Error(`authorize GET ${page.status}: ${await page.text()}`);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!handle) throw new Error("no consent handle");
  const post = await fetch(authUrl, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ handle, ...form }),
  });
  let location = post.headers.get("location");
  let accessKey: string | undefined;
  if (!location) {
    const body = await post.text();
    accessKey = /class="key">([^<]+)</.exec(body)?.[1];
    location = /href="([^"]+)">保存しました/.exec(body)?.[1]?.replace(/&amp;/g, "&") ?? null;
    if (!location) throw new Error(`authorize POST failed: ${post.status} ${body.slice(0, 500)}`);
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`no code in ${location}`);
  const tok = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${BASE}/mcp` }),
  });
  const tj = (await tok.json()) as { access_token?: string };
  if (!tj.access_token) throw new Error(`token failed: ${JSON.stringify(tj)}`);
  return { token: tj.access_token, accessKey };
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
  const first = await oauth(client_id, { mode: "register", invite: code, display_name: "スモーク" });
  log("registered; access key issued:", !!first.accessKey);

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
  const second = await oauth(client_id, { mode: "login", access_key: first.accessKey! });
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
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
