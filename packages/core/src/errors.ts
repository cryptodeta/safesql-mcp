/** Every error a tool can return: a stable code, a plain message and a concrete next step. */
export type ErrorCode =
  | "BAD_INPUT"
  | "UNKNOWN_DATABASE"
  | "UNKNOWN_TABLE"
  | "BLOCKED"
  | "READ_ONLY"
  | "POLICY"
  | "TIMEOUT"
  | "TOO_MANY_ROWS"
  | "CONFIRM_REQUIRED"
  | "CONNECTION"
  | "SQL_ERROR"
  | "CONFIG"
  | "INTERNAL";

export class SafeSqlError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "SafeSqlError";
    this.code = code;
    this.hint = hint;
  }
}

export function toSafeSqlError(err: unknown): SafeSqlError {
  if (err instanceof SafeSqlError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new SafeSqlError("INTERNAL", message);
}
