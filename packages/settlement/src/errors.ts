export type SettlementErrorCode =
  | "CONFIGURATION" | "NOT_FINALIZED" | "EXECUTION_FAILED" | "TRANSACTION_MISMATCH"
  | "INVALID_DECISION" | "TRANSCRIPTION_MISMATCH" | "MANDATE_MISMATCH"
  | "PAYEE_MISMATCH" | "ESCROW_MISMATCH" | "ATTESTATION" | "POSTING_CONFLICT"
  | "SUBMISSION_UNCERTAIN" | "RECEIPT_REVERTED" | "RPC_RESPONSE";

/** Stable, secret-free errors suitable for CLI/API reporting. */
export class SettlementError extends Error {
  override readonly name = "SettlementError";
  constructor(readonly code: SettlementErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function requireSettlement(
  condition: unknown, code: SettlementErrorCode, message: string,
): asserts condition {
  if (!condition) throw new SettlementError(code, message);
}
