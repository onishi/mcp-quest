/** Domain error contract (spec §14.4). */
export type ErrorCode =
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "NO_ADVENTURE_CREDIT"
  | "STALE_STATE"
  | "INVALID_ACTION"
  | "INVALID_INPUT"
  | "UNSUPPORTED_ACTION"
  | "NEEDS_CLARIFICATION"
  | "NEEDS_REPLAN"
  | "RESTRICTED"
  | "IDEMPOTENCY_CONFLICT"
  | "CONFLICT"
  | "TEMPORARY_UNAVAILABLE";

const NEXT_STEP: Record<ErrorCode, string> = {
  AUTH_REQUIRED: "再認証してください。",
  FORBIDDEN: "この操作の権限がありません。別人の権限を使わないでください。",
  NOT_FOUND: "IDを確認し、list_characters や resume_game で正しいIDを取得してください。",
  RATE_LIMITED: "retry_after 秒待ってから再試行してください。連続で再試行しないでください。",
  NO_ADVENTURE_CREDIT: "次回付与時刻まで待つか、冒険権を消費しない閲覧（get_history, get_rules）を案内してください。",
  STALE_STATE: "observe または resume_game で最新状態を取得し、必要ならプレイヤーに再確認してください。",
  INVALID_ACTION: "get_actions で現在実行可能な行動を確認してください。状態は変更されていません。",
  INVALID_INPUT: "入力パラメータを確認してください。状態は変更されていません。",
  UNSUPPORTED_ACTION: "既存の行動で代替するか、機能提案として日次処理に記録されたことを伝えてください。即時実装はされません。",
  NEEDS_CLARIFICATION: "行動の意図や対象をプレイヤーに確認してください。",
  NEEDS_REPLAN: "撤退（withdraw）または中断を案内してください。",
  RESTRICTED: "制限の内容・期限をプレイヤーに伝えてください。",
  IDEMPOTENCY_CONFLICT: "新しい request_id を生成して送り直してください。",
  CONFLICT: "resume_game で状態を再取得してください。",
  TEMPORARY_UNAVAILABLE: "同じ request_id で少し待って再試行してください。",
};

export class GameError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    readonly stateChanged = false,
  ) {
    super(message);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        state_changed: this.stateChanged,
        next_step: NEXT_STEP[this.code],
        ...this.details,
      },
    };
  }
}
