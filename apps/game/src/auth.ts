/**
 * OAuth authorization UI (M03).
 *
 * MVP identity: invite-only accounts with a personal access key.
 *  - New player: invite code + display name → account + access key (shown once)
 *  - Returning player: access key
 * The key is never stored; only SHA-256(key) is kept as identity subject
 * (issuer "mcp-quest:key"). Google OIDC (spec §15.1) can be added as another
 * issuer without changing accounts.
 */
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { type Env, worldStub } from "./env.js";
import { escapeHtml, page } from "./html.js";

export const KEY_ISSUER = "mcp-quest:key";

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newAccessKey(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
  return `MQ-${chars.match(/.{1,6}/g)?.join("-")}`;
}

async function renderForm(env: Env, authReq: AuthRequest, error?: string): Promise<Response> {
  const consent = await env.OAUTH_PROVIDER.describeConsent(authReq);
  const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(authReq);
  const d = consent as unknown as { clientName?: string; redirectHost?: string; redirectUriHost?: string };
  const client = escapeHtml(d.clientName ?? authReq.clientId);
  const redirectHost = escapeHtml(d.redirectHost ?? d.redirectUriHost ?? "");
  const body = `
    <h1>MCP Quest に接続</h1>
    <p class="muted"><strong>${client}</strong>${redirectHost ? `（${redirectHost}）` : ""} が、あなたのキャラクターとして冒険を進める権限を求めています。</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <section class="card">
      <h2>はじめての方（招待コード）</h2>
      <form method="post">
        <input type="hidden" name="handle" value="${escapeHtml(handle)}">
        <input type="hidden" name="mode" value="register">
        <label>招待コード<input name="invite" required maxlength="64" autocomplete="off"></label>
        <label>表示名<input name="display_name" required maxlength="32"></label>
        <button type="submit">アカウントを作成して接続</button>
      </form>
    </section>
    <section class="card">
      <h2>アクセスキーをお持ちの方</h2>
      <form method="post">
        <input type="hidden" name="handle" value="${escapeHtml(handle)}">
        <input type="hidden" name="mode" value="login">
        <label>アクセスキー<input name="access_key" required maxlength="80" autocomplete="current-password" type="password"></label>
        <button type="submit">接続を許可</button>
      </form>
    </section>
    <form method="post"><input type="hidden" name="handle" value="${escapeHtml(handle)}"><input type="hidden" name="mode" value="deny"><button class="secondary" type="submit">拒否する</button></form>`;
  const res = page("MCP Quest に接続", body);
  headers.forEach((v, k) => res.headers.append(k, v));
  return res;
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") {
    let authReq: AuthRequest;
    try {
      authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (e) {
      return page("エラー", `<p class="error">認可リクエストが不正です: ${escapeHtml(String(e))}</p>`, 400);
    }
    return renderForm(env, authReq);
  }
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const mode = String(form.get("mode") ?? "");
  if (mode === "deny") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  let approved: Awaited<ReturnType<Env["OAUTH_PROVIDER"]["approveConsent"]>>;
  try {
    approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
  } catch {
    return page("エラー", `<p class="error">フォームの有効期限が切れました。AIクライアントから接続をやり直してください。</p>`, 400);
  }
  const authReq = approved.request;
  const stub = worldStub(env);

  let accountId: string | undefined;
  let issuedKey: string | undefined;
  if (mode === "login") {
    const key = String(form.get("access_key") ?? "").trim().toUpperCase();
    const res = await stub.resolveIdentity(KEY_ISSUER, await sha256Hex(key));
    if (!res.ok || !res.result) return renderForm(env, authReq, "アクセスキーが正しくありません。");
    accountId = res.result;
  } else if (mode === "register") {
    issuedKey = newAccessKey();
    const res = await stub.redeemInvite({
      code: String(form.get("invite") ?? "").trim(),
      displayName: String(form.get("display_name") ?? ""),
      issuer: KEY_ISSUER,
      subject: await sha256Hex(issuedKey),
    });
    if (!res.ok || !res.result) return renderForm(env, authReq, res.error?.message ?? "登録に失敗しました。");
    accountId = res.result.account_id;
  } else return renderForm(env, authReq, "不正なリクエストです。");

  const status = await stub.accountStatus(accountId);
  if (!status.ok || status.result !== "active") return renderForm(env, authReq, "このアカウントは現在利用できません。");

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: accountId,
    metadata: { issuer: KEY_ISSUER },
    scope: authReq.scope,
    props: { accountId },
  });
  const headers = new Headers(approved.headers);
  if (!issuedKey) {
    headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers });
  }
  const res = page(
    "アカウントを作成しました",
    `<h1>ようこそ、冒険者</h1>
     <p>あなたのアクセスキーです。<strong>この画面でしか表示されません。</strong>別のAIクライアントから接続するときに必要なので、パスワードマネージャー等に保存してください。</p>
     <p class="key">${escapeHtml(issuedKey)}</p>
     <p><a class="button" href="${escapeHtml(redirectTo)}">保存しました。AIクライアントに戻る</a></p>`,
  );
  headers.forEach((v, k) => res.headers.append(k, v));
  return res;
}
