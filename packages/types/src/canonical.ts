/**
 * Canonical JSON — production TypeScript encoder.
 *
 * Normative definition: `docs/CANONICAL.md` §1. Version `wrk/canonical-json/v1`.
 * This must agree with `contracts/genlayer/lib/canonical.py` on every byte of
 * every input; `fixtures/canonical-vectors.json` is the frozen contract and
 * `pnpm verify:vectors` proves it.
 *
 * The rules, restated so an implementer never has to leave this file:
 *
 *  1. Object keys sorted ascending by UTF-16 code unit.
 *  2. Separators are exactly `,` and `:`. No other whitespace.
 *  3. Output is pure ASCII. Only 0x20–0x7E appear literally. Everything below
 *     0x20 or above 0x7E — **including 0x7F (DEL)** — is escaped as `\uXXXX`
 *     with lowercase hex, except the shorthands \b \t \n \f \r \" \\ which are
 *     always preferred where they apply. Non-BMP characters become their UTF-16
 *     surrogate pair. This is exactly Python's `ensure_ascii=True`.
 *  4. Object keys must match `^[A-Za-z0-9_]+$`. This is what makes rule 1's two
 *     sort orders (UTF-16 code unit in JS, code point in Python) identical.
 *  5. Numbers must be safe integers. Floats, NaN, ±Infinity, bigints and
 *     out-of-range integers are rejected. `-0` normalises to `0`. Anything that
 *     can exceed 2^53 — a uint256 USDC amount, for instance — travels as a
 *     decimal string.
 *  6. `undefined` is rejected. `null` is allowed. Array order is preserved.
 *
 * Three strictness rules are added here beyond the reference encoder, all in the
 * fail-closed direction and none of which affects any frozen vector:
 *
 *  - Non-plain objects (Date, Map, Set, RegExp, boxed primitives, class
 *    instances) are rejected rather than silently encoded as `{}` via
 *    `Object.keys`. Python's reference rejects the equivalent inputs.
 *  - Objects carrying symbol keys are rejected, because `Object.keys` would drop
 *    them and a dropped key is a silent hash fork.
 *  - Cycles and runaway depth raise a typed error instead of a `RangeError`.
 */

import { fail, describe } from "./errors.js";

/** The canonical-JSON version these rules implement. Part of every hash's meaning. */
export const CANONICAL_JSON_VERSION = "wrk/canonical-json/v1" as const;

/** Object keys must match this exactly (rule 4). */
export const CANONICAL_KEY_PATTERN = /^[A-Za-z0-9_]+$/;

/** Largest integer either language encodes without loss (rule 5). */
export const MAX_SAFE_CANONICAL_INTEGER = 9_007_199_254_740_991;
export const MIN_SAFE_CANONICAL_INTEGER = -9_007_199_254_740_991;

/**
 * Depth ceiling. The deepest frozen vector nests 11 levels; 128 leaves ample
 * headroom for real payloads while keeping recursion bounded so a hostile
 * document cannot turn into a stack overflow inside an adjudicator.
 */
export const CANONICAL_MAX_DEPTH = 128;

/** The JSON value space canonical JSON accepts. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

const ESCAPES = new Map<number, string>([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

function encodeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const shorthand = ESCAPES.get(code);
    if (shorthand !== undefined) {
      out += shorthand;
    } else if (code < 0x20 || code > 0x7e) {
      // 0x7F (DEL) lands here deliberately. Python's ensure_ascii=True escapes
      // it, so a "printable ASCII" boundary of `> 0x7f` would fork every hash
      // containing it. Established by exhaustive probe, not by documentation.
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += value.charAt(i);
    }
  }
  return `${out}"`;
}

function encodeNumber(value: number): string {
  if (!Number.isInteger(value)) {
    fail("CANONICAL_NON_INTEGER", `rejects non-integer number ${describe(value)}`, { value });
  }
  if (!Number.isSafeInteger(value)) {
    fail(
      "CANONICAL_UNSAFE_INTEGER",
      `rejects unsafe integer ${describe(value)}: encode it as a decimal string`,
      { value },
    );
  }
  // Normalise -0 to 0 so the two spellings cannot hash differently.
  return String(value === 0 ? 0 : value);
}

function isPlainObject(value: object): boolean {
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, depth: number, ancestors: Set<object>, path: string): string {
  if (depth > CANONICAL_MAX_DEPTH) {
    fail("CANONICAL_DEPTH", `exceeds max nesting depth ${CANONICAL_MAX_DEPTH} at ${path}`, { path });
  }
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return encodeNumber(value);
    case "bigint":
      fail(
        "CANONICAL_BIGINT",
        `rejects bigint ${describe(value)} at ${path}: encode large integers as decimal strings`,
        { path },
      );
    // eslint-disable-next-line no-fallthrough -- fail() returns never
    case "string":
      return encodeString(value);
    case "undefined":
      fail("CANONICAL_UNDEFINED", `rejects undefined at ${path}`, { path });
    // eslint-disable-next-line no-fallthrough -- fail() returns never
    case "object":
      break;
    default:
      fail("CANONICAL_UNSUPPORTED_TYPE", `rejects ${typeof value} at ${path}`, { path });
  }

  const object = value as object;
  if (ancestors.has(object)) {
    fail("CANONICAL_CYCLE", `rejects circular reference at ${path}`, { path });
  }
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      const items: string[] = [];
      for (let i = 0; i < object.length; i++) {
        items.push(encode(object[i], depth + 1, ancestors, `${path}[${i}]`));
      }
      return `[${items.join(",")}]`;
    }

    if (!isPlainObject(object)) {
      fail(
        "CANONICAL_NON_PLAIN_OBJECT",
        `rejects ${Object.prototype.toString.call(object)} at ${path}: pass a plain JSON object ` +
          `(a Date, Map, Set, class instance or cross-realm object would encode as {})`,
        { path },
      );
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      fail(
        "CANONICAL_SYMBOL_KEY",
        `rejects symbol-keyed property at ${path}: Object.keys would drop it silently`,
        { path },
      );
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (!CANONICAL_KEY_PATTERN.test(key)) {
        fail(
          "CANONICAL_BAD_KEY",
          `rejects key ${describe(key)} at ${path}: keys must match ${String(CANONICAL_KEY_PATTERN)}`,
          { path, key },
        );
      }
      const child = record[key];
      if (child === undefined) {
        fail("CANONICAL_UNDEFINED", `rejects undefined at ${path}.${key}`, { path, key });
      }
      parts.push(`${encodeString(key)}:${encode(child, depth + 1, ancestors, `${path}.${key}`)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Serialises `value` to canonical JSON, or throws `WrkError` if it is outside the
 * accepted value space.
 *
 * Takes `unknown` on purpose: inputs arrive from `JSON.parse`, HTTP bodies and
 * chain logs, so the runtime check is the contract and a compile-time type would
 * be a comfortable lie.
 */
export function canonicalize(value: unknown): string {
  return encode(value, 0, new Set<object>(), "$");
}

/**
 * True when `value` can be canonicalised. Never throws.
 *
 * Prefer `canonicalize` in a try/catch when you need the reason — this exists
 * for validation paths that only need the boolean.
 */
export function isCanonicalizable(value: unknown): value is CanonicalValue {
  try {
    canonicalize(value);
    return true;
  } catch {
    return false;
  }
}
