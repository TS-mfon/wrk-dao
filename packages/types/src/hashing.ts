/**
 * Hashing — the two constructions from `docs/CANONICAL.md`, and nothing else.
 *
 *   §1 content hash  keccak256( ascii_bytes( canonical_json(value) ) )
 *   §2 struct hash   keccak256( abi.encode(field, ...) )   never abi.encodePacked
 *
 * Using the wrong one is a bug even when the digest looks fine. `abi.encodePacked`
 * over more than one dynamic field is not injective: ("ab","c") and ("a","bc")
 * produce identical bytes, so two different settlements could share a
 * `settlementId`. Everything here uses `abi.encode`.
 */

import { encodeAbiParameters, keccak256 } from "viem";
import type { Hex } from "viem";
import { canonicalize } from "./canonical.js";
import { fail } from "./errors.js";

/** A 32-byte hex string, `0x` + 64 lowercase-or-uppercase hex digits. */
export type Bytes32 = `0x${string}`;

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Converts canonical text to its byte form, asserting the pure-ASCII guarantee
 * rather than trusting it.
 *
 * This is why Solidity can hash the same bytes with no UTF-8 encoder on-chain
 * (`docs/CANONICAL.md` §1.4). If the guarantee ever broke, the three languages
 * would diverge silently — so it is checked on every call, not once in a test.
 */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      fail(
        "CANONICAL_NON_ASCII_OUTPUT",
        `canonical output must be pure ASCII 0x20-0x7e, found 0x${code.toString(16)} at index ${i}`,
        { index: i, code },
      );
    }
    out[i] = code;
  }
  return out;
}

/** `keccak256` over already-canonical text. */
export function hashCanonicalText(canonical: string): Bytes32 {
  return keccak256(asciiBytes(canonical)) as Bytes32;
}

/**
 * Content hash (§1): `keccak256(ascii_bytes(canonical_json(value)))`.
 *
 * This is the hash stored for DAO metadata, missions, proposals, deliverables,
 * evidence bundles and — critically — adjudication decisions, whose digest
 * becomes the `decisionHash` the escrow settles against.
 */
export function contentHash(value: unknown): Bytes32 {
  return hashCanonicalText(canonicalize(value));
}

/** Canonical text and its digest together, for callers that store both. */
export function contentHashWithCanonical(value: unknown): {
  canonical: string;
  hash: Bytes32;
} {
  const canonical = canonicalize(value);
  return { canonical, hash: hashCanonicalText(canonical) };
}

/** Normalises and validates a `bytes32` value. Returns it lowercased. */
export function assertBytes32(value: string, label = "value"): Bytes32 {
  if (!BYTES32_PATTERN.test(value)) {
    fail("HASH_BAD_BYTES32", `${label} must be 0x followed by 64 hex digits, got ${value.length} chars`, {
      label,
    });
  }
  return value.toLowerCase() as Bytes32;
}

function assertUint(value: bigint, max: bigint, label: string): bigint {
  if (value < 0n || value > max) {
    fail("HASH_BAD_UINT", `${label} out of range: ${value}`, { label, value: value.toString() });
  }
  return value;
}

/**
 * Struct hash (§2) for the settlement identifier. Per SPEC §40:
 *
 *   settlementId = keccak256(abi.encode(mandateId, decisionHash, nonce))
 *
 * Invariant I3: changing any input changes the id. Invariant I2 depends on this
 * being reproducible from chain data, so the encoding is pinned here and
 * re-derived identically in Solidity.
 */
export function settlementId(mandateId: string, decisionHash: string, nonce: bigint): Bytes32 {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }] as const,
      [
        assertBytes32(mandateId, "mandateId"),
        assertBytes32(decisionHash, "decisionHash"),
        assertUint(nonce, UINT256_MAX, "nonce"),
      ],
    ),
  ) as Bytes32;
}

/**
 * Generic `abi.encode`-based struct hash, for the cases where a fixed set of
 * typed fields — not off-chain content — is being hashed.
 *
 * Exposed so no caller reaches for `encodePacked` out of convenience. There is
 * deliberately no packed variant in this package.
 */
export function structHash<const T extends readonly { readonly type: string }[]>(
  types: T,
  values: readonly unknown[],
): Bytes32 {
  if (types.length !== values.length) {
    fail("HASH_BAD_UINT", `structHash needs one value per type: ${types.length} vs ${values.length}`);
  }
  // viem validates each value against its declared type and throws on mismatch.
  return keccak256(
    encodeAbiParameters(types as never, values as never),
  ) as Bytes32;
}
