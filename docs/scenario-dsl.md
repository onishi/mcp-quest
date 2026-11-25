# Scenario DSL（schemaVersion 1）

シナリオは筋書きではなく「状況」を JSON で記述する。スキーマの正本は `packages/scenario-dsl/src/schema.ts`、例は `world/scenarios/*.json`。
任意コード・式・ネットワーク・ループは書けない。条件と効果は登録済みの語彙だけ。

## 構成要素

| 要素 | 内容 |
|---|---|
| `nodes` | 場面。`location`（世界の場所 ID）、`targets`（npc / object / feature / enemy）、`exits`（`requires` 条件付き可）、`onEnter` |
| `clues` | 手がかり。`fact` を指定するとキャラクターの既知情報になる |
| `clocks` | 進行する危機。満ちると `onFull` を一度だけ実行 |
| `enemies` | 戦闘で使う敵（世界の `monsters` を参照） |
| `triggers` | 行動への反応。`action`（investigate / talk / interact / use_item / move）+ `target` / `option` / `approach` / `item`、`when`、`once`、`check`（技能・難易度）、`effects` / `onSuccess` / `onFailure` |
| `resolutions` | 決着。`when` が満たされた時点で Kernel が完了・報酬・世界への影響を確定 |
| `fallbackPolicy` | `turn_limit` / `character_down` / `dependency_lost` 時の決着（必須） |
| `dependencies` | 前提となる人物（例: `npc_grik` が alive）。失われると `dependency_lost` |
| `impactLimits` | 報酬の上限 |

### 条件（Cond）

`{flag}` `{clue}` `{node}` `{clock, gte}` `{defeated}` `{hasItem}` `{turnGte}` `{combat}` `{not}` `{all}` `{any}`。
`light` フラグは Kernel が設定する（灯火の呪文、松明・ランタン）。

### 効果（Effect）

`reveal_clue` `set_flag` `clear_flag` `advance_clock` `move_to` `damage` `heal` `give_item` `take_item` `gold` `start_combat` `end_combat` `defeat` `narrate` `relation`

### 世界への影響（resolution.worldEffects）

`set_fact`（public / private）、`set_entity_status`（alive / dead / missing / departed）。

## コンパイラの検査

- スキーマ・型（未知のフィールドや op は拒否）
- ID 参照（ノード、手がかり、時計、敵、アイテム、NPC、場所、事実）
- 全ノードの到達可能性
- 必須目標・解決条件の充足可能性（静的な過大近似）
- 終了可能性: 撤退の決着、`turn_limit` と `character_down` の代替処理、依存がある場合の `dependency_lost`
- 1トリガーあたりの効果数上限（時計の連鎖を含む）、時計の連鎖禁止
- 報酬が `impactLimits` 以内
- 公開テキスト（hook / publicSummary）に秘密の事実 ID を含まない
- digest（SHA-256）を付与。公開後に内容を変えるときは `version` を上げる

`npm run check:scenarios` で全シナリオを検証し、`npm test` のシミュレーションで終了性と不変条件を確認する。

## 新しいシナリオを追加する手順

1. `world/scenarios/<id>.json` を書く（既存シナリオをひな形にする）。
2. 必要な場所・NPC・アイテム・事実を `world/initial/eldia.ts` に追加する。
3. `world/index.ts` の `scenarioSources` に登録する。
4. `npm run check:scenarios` と `npm test` を通す。可能ならダイスに頼らない解決経路のテストを `tests/unit/scenarios.test.ts` に追加する。
