# ROADMAP

全体計画は `spec.md` §18。ここでは MVP バックログ（§19.1）の進捗を管理する。

凡例: ✅ 完了（自動テストで確認） / 🟡 一部完了 / ⬜ 未着手 / 🔍 要外部検証

| ID | タスク | 状態 | メモ |
|---|---|---|---|
| M01 | リポジトリ・TypeScript・Wrangler・テスト環境 | ✅ | npm workspaces、vitest、GitHub Actions CI |
| M02 | リモートMCP read/write スパイク | 🔍 | wrangler dev 上で SDK クライアントによる OAuth→読み書き→別セッション再開を確認（`scripts/smoke.ts`）。**実際の Claude / ChatGPT での接続・書き込み可否・確認回数は未検証**（公開 URL へのデプロイが必要） |
| M03 | OAuth・内部account_id・招待 | 🟡 | DCR + PKCE、招待コード登録、アクセスキーログイン（SHA-256 のみ保存）、停止の即時反映。Google OIDC は未実装 |
| M04 | World DO + SQLite初期化 | ✅ | `WORLD_INSTANCE` で dev / production の世界を分離。マイグレーション、シナリオ digest 検査 |
| M05 | Command pipeline + イベント + receipt | ✅ | 冪等キー、payload 不一致拒否、古い turn 拒否、状態・イベント・receipt・outbox を単一トランザクションで確定 |
| M06 | キャラクター・冒険権・所有権 | ✅ | 1アカウント1キャラ、1日1権・最大3・JST 4:00、同時進行1、再開は消費なし |
| M07 | Entity / Component / Fact / Knowledge | ✅ | キャラクターは entity + 検証付き component。fact の visibility、knowledge による既知情報 |
| M08 | 行動レジストリ・移動・会話・調査 | ✅ | move / investigate / talk(approach) / interact / use_item / withdraw |
| M09 | ダイス・戦闘・魔法・報酬 | ✅ | (seed, turn) 決定的ダイス、attack/cast/defend/flee、戦闘不能→救助、報酬は上限付きで1回のみ |
| M10 | エピソード状態機械 | ✅ | active / paused / completed、ターン上限・戦闘不能・依存消失の代替処理 |
| M10a | Scenario DSL・コンパイラ・実行器 | ✅ | 型・参照・到達可能性・終了可能性・効果数上限・秘密・報酬上限を検査 |
| M11 | 初期世界とシナリオ1本 | ✅ | リーフェン村（NPC 15、場所 12）、ゴブリンたちの村 |
| M12 | resume_game とコンテキスト出力 | ✅ | あらすじ・GM 指針・世界ニュース。秘密漏洩テストあり |
| M13 | 基本管理・制限・監査 | ✅ | 管理 API（招待・停止・制限・解除・冒険権返却・監査ログ・機能要望・outbox） |
| M14 | シナリオ在庫5〜10本 | 🟡 | 3本（戦闘/交渉、探索/救助、人間ドラマ）。残り 2〜7 本 |
| M15 | 実機・人間によるプレイテスト | ⬜ | 未実施 |
| M15a | RuntimeのLLM非依存検証 | 🟡 | `check:llm-free`（Binding・SDK（推移的依存含む）・推論エンドポイント・キー参照・Kernel のネットワーク）。実行時のネットワーク監査は未実装 |
| M16 | Cronの最小ジョブ・feature request記録 | 🟡 | 未実装行動を `feature_requests` に記録（1日1件）、依存消失時の replan 要求記録。Cron は未実装 |
| M17 | 最小公開ページと運営表示 | 🟡 | `/` に世界紹介・公開事実・公開イベント、`/api/world`。同意済み冒険の概要は未実装 |

## 既知の課題・設計メモ

- シナリオは `unique_per_character`。共有世界では、他のプレイヤーがゴブリン問題を解決した後でも別のプレイヤーが同じ事件を遊べる（世界の事実と矛盾し得る）。v0.2.0 の共有世界で `forbidsFacts` / `unique_world` を使って整理する。
- ランダム方策シミュレーション（`tests/simulation`）は終了性と不変条件の検査であり、面白さやバランスの指標ではない。ランダムプレイでは大半がターン上限で終わる。
- MCP はステートレス（JSON レスポンス）。サーバー→クライアント通知は使っていない。
- 技術的レート制限は DO メモリ上（再起動でリセット）。エッジの Rate Limiting / WAF は未設定。
