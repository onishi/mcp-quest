# 運用メモ（MVP）

## デプロイ（未実施・手順案）

1. KV ネームスペースを作成し、`apps/game/wrangler.jsonc` の `OAUTH_KV` の id を置き換える。
   `npx wrangler kv namespace create OAUTH_KV`
2. 管理トークンを設定する（LLM 用の Secret は**設定しない**）。
   `npx wrangler secret put ADMIN_TOKEN`
3. 必要なら `PUBLIC_ORIGIN` を vars に設定する（OAuth の resource 識別子に使う）。
4. `npx wrangler deploy`（本番は `--env production`。世界は `WORLD_INSTANCE` で分離される）。
5. Claude の「カスタムコネクタ」に `https://<host>/mcp` を登録し、M02 の検証項目（認可、書き込み、確認ダイアログの頻度、別チャットからの再開）を記録する。

本番へのデプロイは人間が行う（AGENTS.md）。

## 管理 API

`Authorization: Bearer $ADMIN_TOKEN`。変更系は `reason`（3文字以上）が必須で、監査ログに記録される。`x-admin-actor` ヘッダで操作者名を残せる。

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/admin/invites` | 招待コード発行 `{maxUses?, expiresAt?}` |
| GET | `/admin/accounts` | アカウント一覧 |
| GET | `/admin/accounts/:id` | アカウント・制限・最近のイベント |
| POST | `/admin/accounts/:id/suspend` | 停止（即時反映） |
| POST | `/admin/accounts/:id/restore` | 停止解除 |
| POST | `/admin/accounts/:id/restrictions` | 制限 `{scope: all/game:play/read_only, reason, expiresAt?}` |
| POST | `/admin/restrictions/:id/lift` | 制限解除 |
| POST | `/admin/accounts/:id/refund` | 冒険権の返却（障害時のみ） |
| GET | `/admin/audit` | 監査ログ |
| GET | `/admin/feature-requests` | 未実装行動・再構成の要求（Daily 用の入力。信頼できないデータ） |
| GET | `/admin/outbox` | 公開投影待ちのイベント |

## 障害時

| 事象 | 対応 |
|---|---|
| AI クライアントの切断・再送 | 同じ request_id の再送で保存済み結果が返る。`resume_game` で状態を再取得 |
| 日次処理・LLM の停止 | Runtime は影響を受けない（LLM 非依存）。既存シナリオで開始・完了・再開できる |
| 悪用 | `restrictions` で操作範囲ごとに制限、または `suspend`。いずれも次の呼び出しから即時反映 |
| シナリオの不具合 | 修正版を `version` を上げて公開。進行中のエピソードは旧版で継続。冒険権は `refund` で返却 |
