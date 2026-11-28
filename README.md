# MCP Quest

> 一日一話、あなたの冒険が世界の歴史になる。

ChatGPT・Claude などの対話AIを GM として、リモート MCP 経由で同じ世界に参加する永続型・非同期のファンタジーTRPG。
仕様は [`spec.md`](spec.md) を参照。

**ゲームを実行するのはプログラム。ゲームを進化させるのはAI。** プレイ中の運営側 LLM 呼び出しはゼロ（LLM-Free Runtime）。判定・状態・報酬はすべてサーバー（World Kernel）が確定する。

## 現在の状態（MVP 開発中 / v0.1.0 に向けて）

| 範囲 | 状態 |
|---|---|
| Player MCP 16ツール（stateless Streamable HTTP） | 実装済み・ローカルで E2E 確認 |
| OAuth（DCR + PKCE）、Google ログイン + 初回のみ招待コード | 実装済み・ローカル（擬似 Google）で E2E 確認 |
| World Durable Object + SQLite、イベント・receipt・outbox | 実装済み |
| 冒険権（1日1回付与・最大3・JST 4:00 境界） | 実装済み |
| Scenario DSL（スキーマ・コンパイラ・実行器） | 実装済み |
| シナリオ | 3本（ゴブリンたちの村 / 消えた薬草採り / 最後の一杯） |
| 管理 API（招待・停止・制限・返却・監査） | 実装済み |
| LLM 非依存の機械的検査（CI） | 実装済み |
| 実機の Claude / ChatGPT での接続検証（M02） | **未検証** |
| 人間によるプレイテスト（M15） | **未実施** |

詳細な進捗は [`ROADMAP.md`](ROADMAP.md)、次の作業は [`evolution/handoff.md`](evolution/handoff.md)。

## 構成

```text
apps/game/              Cloudflare Worker: MCP endpoint, OAuth, World DO, admin API, 公開ページ
packages/kernel/        World Kernel（状態・ルール・コマンド処理）。LLM なし・ネットワークなし
packages/scenario-dsl/  Scenario DSL のスキーマ・コンパイラ・実行器
world/                  初期世界（エルディア / リーフェン村）とシナリオ JSON
tests/                  unit / security / simulation
scripts/                LLM 非依存チェック、シナリオ検証、E2E スモーク
docs/                   MCP 契約、Scenario DSL、運用
```

## 開発

Node.js 22 以上。

```bash
npm install
npm run ci            # typecheck + LLM-free check + scenario compile + tests

# ローカル起動（wrangler dev。KV/DO はローカルで模擬される）
# Google の代わりに scripts/smoke.ts 内蔵の擬似 OIDC サーバー（127.0.0.1:9898）を使う
cat > apps/game/.dev.vars <<'VARS'
ADMIN_TOKEN=dev-admin-token
GOOGLE_CLIENT_ID=fake-client
GOOGLE_CLIENT_SECRET=fake-secret
OIDC_AUTHORIZE_URL=http://127.0.0.1:9898/authorize
OIDC_TOKEN_URL=http://127.0.0.1:9898/token
OIDC_ISSUER=http://127.0.0.1:9898
VARS
npm run dev           # http://127.0.0.1:8787

# 別ターミナルで E2E スモーク（招待 → Google ログイン → MCP → 別セッション再開 → 停止）
BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=dev-admin-token npx tsx scripts/smoke.ts
```

### 遊び方（ローカル）

1. 招待コードを発行する:
   `curl -X POST -H 'authorization: Bearer dev-admin-token' http://127.0.0.1:8787/admin/invites -d '{}'`
2. MCP クライアント（例: MCP Inspector `npx @modelcontextprotocol/inspector`）で `http://127.0.0.1:8787/mcp` に接続する。
3. 認可画面で「Google でログインして許可」を押す。初回だけ招待コードと表示名を入力するとアカウントが作られる。以後は Google でログインするだけ。
4. AI に「冒険を始めたい」と話しかける。サーバー指示（GM 指針）に従い `resume_game` → `create_character` → `get_adventures` → `start_adventure` → `get_actions` / `act` と進む。

Claude 等の実クライアントから接続するには公開 HTTPS の URL が必要（デプロイ手順は [`docs/operations.md`](docs/operations.md)）。

## ドキュメント

- [`docs/mcp-contract.md`](docs/mcp-contract.md) — ツール・行動・エラー契約
- [`docs/scenario-dsl.md`](docs/scenario-dsl.md) — シナリオの書き方と検証項目
- [`docs/operations.md`](docs/operations.md) — デプロイ、管理 API、障害時の対応
- [`AGENTS.md`](AGENTS.md) — AI 開発エージェント向けの規約
