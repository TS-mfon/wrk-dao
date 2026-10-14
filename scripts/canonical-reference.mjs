// Reference implementation of WRK canonical JSON (docs/CANONICAL.md).
// Driver-owned. Used only to generate and check fixtures/canonical-vectors.json;
// packages/types ships the production TypeScript copy and must match this byte for byte.

/**
 * Canonical JSON rules (see docs/CANONICAL.md):
 *  1. Object keys sorted ascending by UTF-16 code unit.
 *  2. No insignificant whitespace: "," and ":" separators, nothing else.
 *  3. Pure ASCII output. Only 0x20-0x7E survive as literal characters. Every
 *     code unit below 0x20 or above 0x7E -- including 0x7F (DEL) -- is escaped
 *     as \uXXXX with lowercase hex, except the shorthands \b \t \n \f \r \" \\
 *     which are always used where they apply. Non-BMP characters are escaped as
 *     their UTF-16 surrogate pair. This is exactly Python's ensure_ascii=True,
 *     verified code point by code point across U+0000-U+10FFF by
 *     scripts/verify-hash-parity.mjs's sibling probe.
 *  4. Object keys MUST match ^[A-Za-z0-9_]+$. Restricting keys to ASCII makes
 *     "sort by UTF-16 code unit" (JavaScript) and "sort by code point" (Python)
 *     the same ordering. Without it, an astral key such as U+1F600 sorts before
 *     U+FFFD in JavaScript and after it in Python, silently forking every hash.
 *  5. Numbers must be safe integers. Floats, NaN, Infinity, -0 and bigints
 *     outside the safe range are rejected: large values travel as decimal strings.
 *  6. undefined is rejected. null is allowed. Arrays keep their order.
 */

const KEY_PATTERN = /^[A-Za-z0-9_]+$/;

const ESCAPES = new Map([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x22, '\\"'],
  [0x5c, "\\\\"],
]);

function encodeString(value) {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const shorthand = ESCAPES.get(code);
    if (shorthand !== undefined) {
      out += shorthand;
      // 0x7f (DEL) IS escaped: Python's ensure_ascii=True escapes it, and the
      // two serialisers must agree on every byte. It is the single code point in
      // U+0000-U+10FFF where a naive "printable ASCII" boundary diverges.
    } else if (code < 0x20 || code > 0x7e) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += value[i];
    }
  }
  return out + '"';
}

function encodeNumber(value) {
  if (typeof value === "bigint") {
    throw new TypeError(
      `canonical JSON rejects bigint ${value}: encode large integers as decimal strings`,
    );
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(`canonical JSON rejects non-integer number ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `canonical JSON rejects unsafe integer ${value}: encode it as a decimal string`,
    );
  }
  // Normalise -0 to 0 so the two spellings cannot hash differently.
  return String(value === 0 ? 0 : value);
}

export function canonicalize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
    case "bigint":
      return encodeNumber(value);
    case "string":
      return encodeString(value);
    case "undefined":
      throw new TypeError("canonical JSON rejects undefined");
    case "object":
      break;
    default:
      throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalize(item)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) {
      throw new TypeError(
        `canonical JSON rejects key ${JSON.stringify(key)}: keys must match ${KEY_PATTERN}`,
      );
    }
    const child = value[key];
    if (child === undefined) {
      throw new TypeError(`canonical JSON rejects undefined at key ${JSON.stringify(key)}`);
    }
    parts.push(encodeString(key) + ":" + canonicalize(child));
  }
  return "{" + parts.join(",") + "}";
}
