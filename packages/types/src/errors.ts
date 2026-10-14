/**
 * Typed error taxonomy.
 *
 * Every failure in this package throws a `WrkError` carrying a stable `code`.
 * The codes are the contract: callers switch on `code`, never on message text,
 * because messages are allowed to improve and codes are not.
 *
 * Why not plain `TypeError`? Because "the canonical encoder refused this value"
 * and "this state transition is illegal" are different facts with different
 * remedies, and a settlement adapter that catches one must not silently catch
 * the other.
 */

export type WrkErrorCode =
  /* canonical JSON (docs/CANONICAL.md §1) */
  | "CANONICAL_UNDEFINED"
  | "CANONICAL_NON_INTEGER"
  | "CANONICAL_UNSAFE_INTEGER"
  | "CANONICAL_BIGINT"
  | "CANONICAL_BAD_KEY"
  | "CANONICAL_SYMBOL_KEY"
  | "CANONICAL_UNSUPPORTED_TYPE"
  | "CANONICAL_NON_PLAIN_OBJECT"
  | "CANONICAL_CYCLE"
  | "CANONICAL_DEPTH"
  | "CANONICAL_NON_ASCII_OUTPUT"
  /* identifiers (docs/ARCHITECTURE.md §5) */
  | "ID_BAD_PREFIX"
  | "ID_BAD_FORMAT"
  | "ID_BAD_ALPHABET"
  | "ID_OVERFLOW"
  | "ID_BAD_BYTES32"
  | "ID_CLOCK_EXHAUSTED"
  /* basis-point money math (docs/ARCHITECTURE.md §7) */
  | "BP_RANGE"
  | "BP_SUM"
  | "BP_ALLOCATIONS"
  | "BP_AMOUNT"
  | "BP_VERDICT_MISMATCH"
  /* state machines (docs/ARCHITECTURE.md §6) */
  | "STATE_UNKNOWN"
  | "STATE_ILLEGAL_TRANSITION"
  /* payload schemas (docs/ARCHITECTURE.md §7) */
  | "SCHEMA_INVALID"
  /* attestation (docs/ARCHITECTURE.md §8) */
  | "EIP712_SIGNER_ORDER"
  | "EIP712_FIELD"
  /* hashing (docs/CANONICAL.md §2) */
  | "HASH_BAD_BYTES32"
  | "HASH_BAD_UINT";

export class WrkError extends Error {
  readonly code: WrkErrorCode;
  readonly detail: Readonly<Record<string, unknown>> | undefined;

  constructor(code: WrkErrorCode, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "WrkError";
    this.code = code;
    this.detail = detail === undefined ? undefined : Object.freeze({ ...detail });
  }
}

export function isWrkError(value: unknown): value is WrkError {
  return value instanceof WrkError;
}

/** Throws a `WrkError`. Returns `never` so it can tail a narrowing branch. */
export function fail(code: WrkErrorCode, message: string, detail?: Record<string, unknown>): never {
  throw new WrkError(code, message, detail);
}

/**
 * Renders a value for an error message without ever throwing and without
 * pasting an unbounded payload into a log line.
 */
export function describe(value: unknown, limit = 80): string {
  let text: string;
  try {
    if (typeof value === "bigint") text = `${value}n`;
    else if (typeof value === "symbol") text = value.toString();
    else if (typeof value === "function") text = `[function ${value.name || "anonymous"}]`;
    else if (value === undefined) text = "undefined";
    else text = JSON.stringify(value) ?? String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
