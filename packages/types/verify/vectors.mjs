// G2: the production TypeScript encoder reproduces every frozen canonical string
// byte for byte, and every frozen keccak256 digest.
//
// The count in the success token is measured from the frozen file at runtime. A
// hardcoded 41 would pass if the file shrank to one vector, which is exactly the
// failure this gate exists to catch.

import { keccak256 } from "viem";
import { loadFrozenVectors, check, checkEqual, finish, abort } from "./_common.mjs";

try {
  const { canonicalize, contentHash, hashCanonicalText, asciiBytes, contentHashWithCanonical } =
    await import("../dist/index.js");
  const { paired } = loadFrozenVectors();

  for (const vector of paired) {
    const produced = canonicalize(vector.value);

    if (produced !== vector.canonical) {
      // Report the first differing byte: "these strings differ" is not actionable.
      let index = 0;
      while (index < produced.length && index < vector.canonical.length && produced[index] === vector.canonical[index]) {
        index += 1;
      }
      check(
        false,
        `${vector.name}: canonical text diverges at index ${index}\n` +
          `       expected: ${JSON.stringify(vector.canonical.slice(Math.max(0, index - 12), index + 12))}\n` +
          `       actual:   ${JSON.stringify(produced.slice(Math.max(0, index - 12), index + 12))}`,
      );
      continue;
    }

    checkEqual(contentHash(vector.value), vector.keccak256, `${vector.name}: content hash`);
    checkEqual(hashCanonicalText(vector.canonical), vector.keccak256, `${vector.name}: hash of frozen text`);

    // An independent digest path: hash the bytes with viem directly rather than
    // through this package's wrapper, so a bug inside contentHash cannot agree
    // with itself.
    const bytes = new Uint8Array(vector.canonical.length);
    for (let i = 0; i < vector.canonical.length; i++) bytes[i] = vector.canonical.charCodeAt(i);
    checkEqual(keccak256(bytes), vector.keccak256, `${vector.name}: independent keccak256 of ASCII bytes`);

    // Output must be pure ASCII 0x20-0x7e, which is what lets Solidity hash the
    // same bytes with no UTF-8 encoder on-chain (docs/CANONICAL.md §1.4).
    for (let i = 0; i < produced.length; i++) {
      const code = produced.charCodeAt(i);
      if (code < 0x20 || code > 0x7e) {
        check(false, `${vector.name}: non-ASCII output 0x${code.toString(16)} at index ${i}`);
        break;
      }
    }
    checkEqual(asciiBytes(produced).length, produced.length, `${vector.name}: one byte per character`);

    // Idempotence: canonicalising a parsed canonical string is a fixed point.
    checkEqual(canonicalize(JSON.parse(produced)), produced, `${vector.name}: parse/re-encode fixed point`);

    // Key order must not depend on insertion order.
    if (produced.startsWith("{") && produced !== "{}") {
      const reversed = reverseKeyOrder(vector.value);
      checkEqual(canonicalize(reversed), produced, `${vector.name}: key order independence`);
    }

    const both = contentHashWithCanonical(vector.value);
    checkEqual(both.canonical, vector.canonical, `${vector.name}: contentHashWithCanonical text`);
    checkEqual(both.hash, vector.keccak256, `${vector.name}: contentHashWithCanonical digest`);
  }

  finish(`TYPES-VECTORS OK ${paired.length}`);
} catch (error) {
  abort(error);
}

function reverseKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseKeyOrder);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).reverse()) out[key] = reverseKeyOrder(value[key]);
  return out;
}
