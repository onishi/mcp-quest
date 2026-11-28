/**
 * Post-deploy check for a deployed environment (real Google cannot be scripted):
 * OAuth metadata, 401 on /mcp, consent page, and the redirect to Google with
 * the right client_id / redirect_uri / PKCE / nonce.
 *
 *   BASE_URL=https://mcp-quest-game.wagaya.workers.dev npx tsx scripts/check-deploy.ts
 */
const BASE = process.env.BASE_URL ?? "https://mcp-quest-game.wagaya.workers.dev";
const ok = (m: string) => console.log("✓", m);
const fail = (m: string): never => {
  console.error("✗", m);
  process.exit(1);
  throw new Error(m);
};

const meta = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
if (meta.status !== 200) fail(`protected resource metadata ${meta.status}`);
ok("protected resource metadata");
const unauth = await fetch(`${BASE}/mcp`, { method: "POST" });
if (unauth.status !== 401) fail(`/mcp without token → ${unauth.status}`);
ok("/mcp requires a token");

const reg = await fetch(`${BASE}/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Deploy Check", redirect_uris: ["http://localhost:9999/callback"], token_endpoint_auth_method: "none" }),
});
const { client_id } = (await reg.json()) as { client_id: string };
const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "http://localhost:9999/callback", state: "s", scope: "game:play", code_challenge: "x".repeat(43), code_challenge_method: "S256" });
const page = await fetch(`${BASE}/authorize?${q}`);
const html = await page.text();
if (page.status !== 200) fail(`consent page ${page.status}: ${html.slice(0, 200)}`);
if (!html.includes("Google でログイン")) fail("consent page has no Google button");
ok("consent page");
const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]!;
const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const go = await fetch(`${BASE}/authorize?${q}`, {
  method: "POST", redirect: "manual",
  headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
  body: new URLSearchParams({ handle, decision: "approve" }),
});
const loc = new URL(go.headers.get("location") ?? fail(`no redirect (${go.status})`));
if (loc.origin !== "https://accounts.google.com") fail(`redirects to ${loc.origin}`);
const p = loc.searchParams;
if (!p.get("client_id")?.endsWith(".apps.googleusercontent.com")) fail(`client_id looks wrong: ${p.get("client_id")}`);
if (p.get("redirect_uri") !== `${BASE}/callback`) fail(`redirect_uri ${p.get("redirect_uri")}`);
if (p.get("code_challenge_method") !== "S256" || !p.get("nonce") || !p.get("state")) fail("missing PKCE / nonce / state");
ok(`redirects to Google (client ${p.get("client_id")?.slice(0, 12)}…, redirect_uri ${p.get("redirect_uri")})`);
console.log("\nDEPLOY CHECK OK — finish with a real Google login from Claude.");

export {};
