/**
 * OAuth authorization UI (M03, spec §15.1).
 *
 * MCP clients authorize against this Worker (OAuth 2.1 + DCR + PKCE). The
 * identity step is delegated to Google (OpenID Connect):
 *
 *   GET  /authorize  consent page ("Google でログイン")
 *   POST /authorize  approve consent → redirect to Google (state bound to this browser)
 *   GET  /callback   Google returns → known identity: done
 *                                   → unknown: first-time page (invite code, or legacy access-key migration)
 *   POST /callback   first-time form → redeem invite / link legacy account → done
 *
 * Accounts are keyed by (issuer, subject); email is never used to merge
 * accounts. Only the Google `sub` is stored.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider";
import { type Env, worldStub } from "./env.js";
import { escapeHtml, page } from "./html.js";

/** Legacy issuer for access keys (sign-in removed; kept only for one-time migration). */
export const KEY_ISSUER = "mcp-quest:key";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface GoogleStep {
  step: "google";
  verifier: string;
  nonce: string;
}
interface RegisterStep {
  step: "register";
  issuer: string;
  subject: string;
  suggestedName: string;
}
type UpstreamData = GoogleStep | RegisterStep;

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

function oidc(env: Env, origin: string) {
  return {
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
    authorizeUrl: env.OIDC_AUTHORIZE_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env.OIDC_TOKEN_URL || "https://oauth2.googleapis.com/token",
    issuers: env.OIDC_ISSUER ? [env.OIDC_ISSUER] : GOOGLE_ISSUERS,
    /** canonical issuer stored with identities */
    issuer: env.OIDC_ISSUER || GOOGLE_ISSUERS[0]!,
    redirectUri: `${origin}/callback`,
  };
}

function errorPage(message: string, status = 400) {
  return page("エラー", `<h1>接続できませんでした</h1><p class="error">${escapeHtml(message)}</p><p class="muted">AIクライアントからもう一度接続をやり直してください。</p>`, status);
}

function withHeaders(res: Response, headers: Headers): Response {
  headers.forEach((v, k) => res.headers.append(k, v));
  return res;
}

// ------------------------------------------------------------- /authorize

export async function handleAuthorize(request: Request, env: Env, origin: string): Promise<Response> {
  const cfg = oidc(env, origin);
  if (!cfg.clientId || !cfg.clientSecret) return errorPage("ログインの設定（Google OAuth クライアント）がまだ行われていません。", 503);

  if (request.method === "GET") {
    let authReq: AuthRequest;
    try {
      authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (e) {
      return errorPage(`認可リクエストが不正です: ${String(e)}`);
    }
    const consent = (await env.OAUTH_PROVIDER.describeConsent(authReq)) as unknown as { clientName?: string; redirectHost?: string; redirectUriHost?: string };
    const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(authReq);
    const client = escapeHtml(consent.clientName ?? authReq.clientId);
    const host = escapeHtml(consent.redirectHost ?? consent.redirectUriHost ?? "");
    const body = `
      <h1>MCP Quest に接続</h1>
      <p class="muted"><strong>${client}</strong>${host ? `（${host}）` : ""} が、あなたのキャラクターとして冒険を進める権限を求めています。</p>
      <form method="post">
        <input type="hidden" name="handle" value="${escapeHtml(handle)}">
        <input type="hidden" name="decision" value="approve">
        <button type="submit">Google でログインして許可</button>
      </form>
      <form method="post">
        <input type="hidden" name="handle" value="${escapeHtml(handle)}">
        <input type="hidden" name="decision" value="deny">
        <button class="secondary" type="submit">拒否する</button>
      </form>
      <p class="muted">はじめての方は、Google でログインしたあとに招待コードを入力します。</p>`;
    return withHeaders(page("MCP Quest に接続", body), headers);
  }

  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") === "deny") {
      const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
    const verifier = randomToken(48);
    const nonce = randomToken(24);
    const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
      data: { step: "google", verifier, nonce } satisfies GoogleStep,
      headers: approved.headers,
    });
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const url = new URL(cfg.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: "openid profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    headers.set("location", url.toString());
    return new Response(null, { status: 302, headers });
  } catch {
    return errorPage("フォームの有効期限が切れました。");
  }
}

// -------------------------------------------------------------- /callback

/**
 * Exchange the authorization code and validate the ID token's claims.
 * The ID token comes directly from Google's token endpoint over TLS with our
 * client secret, so per OIDC Core §3.1.3.7 (6) TLS server validation stands
 * in for signature verification; iss/aud/exp/nonce are still checked.
 */
async function exchangeGoogleCode(cfg: ReturnType<typeof oidc>, code: string, data: GoogleStep) {
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: data.verifier,
    }),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  const part = json.id_token?.split(".")[1];
  if (!part) throw new Error("no id_token");
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))) as {
    iss?: string;
    aud?: string | string[];
    sub?: string;
    exp?: number;
    nonce?: string;
    name?: string;
    given_name?: string;
  };
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!claims.iss || !cfg.issuers.includes(claims.iss)) throw new Error("bad issuer");
  if (!aud.includes(cfg.clientId)) throw new Error("bad audience");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("expired id_token");
  if (claims.nonce !== data.nonce) throw new Error("bad nonce");
  if (!claims.sub) throw new Error("no subject");
  return { subject: claims.sub, name: (claims.given_name || claims.name || "").slice(0, 32) };
}

async function complete(env: Env, authReq: AuthRequest, accountId: string, issuer: string, headers: Headers): Promise<Response> {
  const status = await worldStub(env).accountStatus(accountId);
  if (!status.ok || status.result !== "active") return withHeaders(errorPage("このアカウントは現在利用できません。", 403), headers);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: accountId,
    metadata: { issuer },
    scope: authReq.scope,
    props: { accountId },
  });
  headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers });
}

async function registerPage(env: Env, authReq: AuthRequest, data: RegisterStep, error?: string): Promise<Response> {
  const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(authReq, { data });
  const action = `/callback?state=${encodeURIComponent(state)}`;
  const body = `
    <h1>はじめまして、冒険者</h1>
    <p class="muted">Google アカウントの確認ができました。MCP Quest は現在招待制です。</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <section class="card">
      <h2>招待コードで始める</h2>
      <form method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="mode" value="register">
        <label>招待コード<input name="invite" required maxlength="64" autocomplete="off"></label>
        <label>表示名<input name="display_name" required maxlength="32" value="${escapeHtml(data.suggestedName)}"></label>
        <button type="submit">アカウントを作成して接続</button>
      </form>
    </section>
    <section class="card">
      <h2>以前のアクセスキーをお持ちの方</h2>
      <p class="muted">アクセスキーでのログインは廃止しました。キーを一度入力すると、そのアカウント（キャラクターと冒険の記録）をこの Google アカウントに引き継ぎます。以後はキーは使えなくなります。</p>
      <form method="post" action="${escapeHtml(action)}">
        <input type="hidden" name="mode" value="link">
        <label>アクセスキー<input name="access_key" required maxlength="80" type="password" autocomplete="off"></label>
        <button type="submit">引き継いで接続</button>
      </form>
    </section>`;
  return withHeaders(page("MCP Quest に登録", body), headers);
}

export async function handleCallback(request: Request, env: Env, origin: string): Promise<Response> {
  const cfg = oidc(env, origin);
  let resumed: Awaited<ReturnType<Env["OAUTH_PROVIDER"]["finishUpstream"]>>;
  try {
    resumed = await env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(request);
  } catch {
    return errorPage("ログインの有効期限が切れたか、別のブラウザで開始されました。");
  }
  const authReq = resumed.request;
  const data = resumed.data as UpstreamData;
  const headers = resumed.headers;
  const url = new URL(request.url);
  const stub = worldStub(env);

  if (data.step === "google") {
    if (request.method !== "GET") return errorPage("不正なリクエストです。");
    if (url.searchParams.get("error")) {
      headers.set("location", authorizationErrorRedirect(authReq, "access_denied"));
      return new Response(null, { status: 302, headers });
    }
    let google: { subject: string; name: string };
    try {
      google = await exchangeGoogleCode(cfg, url.searchParams.get("code") ?? "", data);
    } catch (e) {
      console.error("google sign-in failed", String(e));
      return withHeaders(errorPage("Google でのログインに失敗しました。"), headers);
    }
    const known = await stub.resolveIdentity(cfg.issuer, google.subject);
    if (known.ok && known.result) return complete(env, authReq, known.result, cfg.issuer, headers);
    const res = await registerPage(env, authReq, { step: "register", issuer: cfg.issuer, subject: google.subject, suggestedName: google.name });
    return withHeaders(res, headers);
  }

  // data.step === "register": first-time form posted back with a fresh, browser-bound state
  if (request.method !== "POST") return errorPage("不正なリクエストです。");
  const form = await request.formData();
  const mode = String(form.get("mode") ?? "");
  let accountId: string | undefined;
  let failure: string | undefined;
  if (mode === "register") {
    const res = await stub.redeemInvite({
      code: String(form.get("invite") ?? "").trim(),
      displayName: String(form.get("display_name") ?? "").trim() || "冒険者",
      issuer: data.issuer,
      subject: data.subject,
    });
    if (res.ok && res.result) accountId = res.result.account_id;
    else failure = res.error?.message ?? "登録に失敗しました。";
  } else if (mode === "link") {
    const key = String(form.get("access_key") ?? "").trim().toUpperCase();
    const res = await stub.linkIdentity({ fromIssuer: KEY_ISSUER, fromSubject: await sha256Hex(key), toIssuer: data.issuer, toSubject: data.subject });
    if (res.ok && res.result) accountId = res.result.account_id;
    else failure = res.error?.message ?? "引き継ぎに失敗しました。";
  } else failure = "不正なリクエストです。";

  if (!accountId) return withHeaders(await registerPage(env, authReq, data, failure), headers);
  return complete(env, authReq, accountId, data.issuer, headers);
}
