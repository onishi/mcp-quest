# Player MCP 契約（MVP）

エンドポイント: `POST /mcp`（Streamable HTTP、ステートレス、JSON レスポンス）。OAuth 2.1 Bearer トークン必須。
ツール定義の正本: `packages/kernel/src/tools.ts`。サーバー指示（GM 指針）は `initialize` の `instructions` と `resume_game.gm_guidance` で返す。

各ツールは `structuredContent` に構造化結果を、`content[0].text` に定型の1行要約 + 同じ JSON を返す（LLM 生成なし）。

## ツール

| ツール | 種別 | 入力 | 概要 |
|---|---|---|---|
| `get_my_account` | 読み取り | — | アカウント、制限、冒険権 |
| `list_characters` | 読み取り | — | 自分のキャラクター |
| `create_character` | 書き込み | name, race, class, background?, request_id | 1アカウント1キャラクター |
| `resume_game` | 読み取り | character_id | 現状、進行中の冒険（あらすじ付き）、前回の結果、世界ニュース、GM 指針 |
| `get_adventures` | 読み取り | character_id | 冒険候補と参加可否・理由 |
| `start_adventure` | 書き込み | character_id, adventure_id, request_id | 冒険権を1消費して開始 |
| `observe` | 読み取り | episode_id | 場面、見えている対象、出口、戦闘、既知の手がかり、turn |
| `inspect` | 読み取り | episode_id, target_id | 対象・手がかり・所持品の既知情報 |
| `get_actions` | 読み取り | episode_id | 実行可能な行動とパラメータ候補 |
| `act` | 書き込み | episode_id, action_id, parameters?, expected_turn, request_id | 意思決定1回分を原子的に処理 |
| `pause_adventure` | 書き込み | episode_id, request_id | 中断（再開は冒険権を消費しない） |
| `get_character` | 読み取り | character_id | キャラクターシート |
| `get_history` | 読み取り | character_id, cursor?, limit? | 出来事と過去の冒険 |
| `get_play_budget` | 読み取り | — | 冒険権と次回付与時刻 |
| `get_rules` | 読み取り | topic? | 公開ルール |
| `rate_adventure` | 書き込み | episode_id, score, comment? | 完了後の評価 |

`account_id` はツール入力では受け付けない（認可トークンからのみ決まる）。

## 行動（`act.action_id`）

| action_id | parameters | 備考 |
|---|---|---|
| `move` | `to` | 出口のノード ID。条件付き出口は `lockedText` 付きで拒否 |
| `investigate` | `target_id` | 判定が必要な場合あり |
| `talk` | `target_id`, `approach`（friendly / persuade / intimidate / deceive） | 既定 friendly |
| `interact` | `target_id`, `option_id` | 場面固有の選択肢（`get_actions` の `choices`） |
| `use_item` | `item_id`, `target_id?` | 傷薬は回復、松明・ランタンは灯り |
| `attack` | `target_id` | 戦闘中のみ |
| `cast` | `spell_id`, `target_id?` | MP 消費。攻撃呪文は戦闘中のみ |
| `defend` / `flee` | — | 戦闘中のみ |
| `withdraw` | — | 撤退として決着（冒険権は戻らない） |

自由記述の `intent` を `parameters` に入れてもよい（記録のみ。判定には使わない）。

## `act` レスポンス（抜粋）

```json
{
  "status": "resolved",
  "episode_id": "ep_…",
  "turn": 5, "expected_turn": 5,
  "world_revision": 128,
  "event_ids": ["evt_…"],
  "result": { "checks": [{ "skill": "perception", "dice": 14, "modifier": 2, "total": 16, "difficulty": 12, "outcome": "success" }], "combat": [] },
  "narration": ["足跡の一部が岩場を回り込んでいるのに気づいた。…"],
  "revealed_clues": [{ "id": "c_tracks_lead", "text": "…" }],
  "changes": { "hp": -2, "items": { "mine_map": 1 } },
  "scene": { "name": "旧鉱山の入口", "targets": [], "exits": [] },
  "available_actions": ["move", "investigate", "talk", "interact", "use_item", "withdraw"],
  "narration_guidance": "未確認の情報は断定しない。判定結果を変えない。",
  "progress": { "turn": 5, "target_turns": 12, "max_turns": 24, "phase": "exploration", "episode_complete": false },
  "conclusion": { "outcome": "success", "title": "…", "epilogue": "…", "rewards": { "xp": 60, "gold": 30 } }
}
```

判定の失敗も `resolved`。同じ `request_id` の再送は保存済みの結果を `replayed: true` 付きで返し、ダイスを振り直さない。

## エラー

ツールエラーは `isError: true` と `structuredContent.error = { code, message, state_changed, next_step, … }`。

| code | 意味 |
|---|---|
| `AUTH_REQUIRED` / `FORBIDDEN` | 未認証・他人のリソース |
| `RESTRICTED` | 停止・制限中（scope, reason, expires_at を返す） |
| `RATE_LIMITED` | `retry_after` 秒待つ |
| `NO_ADVENTURE_CREDIT` | `next_grant_at` を案内 |
| `STALE_STATE` | `current_turn` を返す。observe で再取得 |
| `INVALID_ACTION` / `INVALID_INPUT` | 状態変更なし |
| `UNSUPPORTED_ACTION` | 未実装の行動。機能要望として記録（1日1件）。即時実装はしない |
| `NEEDS_CLARIFICATION` | 対象が曖昧（例: 複数の敵） |
| `NEEDS_REPLAN` | 冒険の前提が失われ、代替処理が定義されていない |
| `IDEMPOTENCY_CONFLICT` | 同じ request_id で別の内容 |
| `CONFLICT` | 進行中の冒険がある、キャラクター作成済みなど |
| `TEMPORARY_UNAVAILABLE` | 同じ request_id で再試行 |
