import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256, stringToBytes } from "viem";
import {
  asciiBytes,
  assertBytes32,
  contentHash,
  contentHashWithCanonical,
  hashCanonicalText,
  settlementId,
  structHash,
} from "../src/index.js";

/** From fixtures/canonical-vectors.json — the anchor value for the whole contract. */
const EMPTY_OBJECT_DIGEST = "0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d";

describe("content hash (docs/CANONICAL.md §1)", () => {
  it("reproduces the anchor digest", () => {
    expect(contentHash({})).toBe(EMPTY_OBJECT_DIGEST);
  });

  it("is keccak256 of the ASCII bytes, verifiable without this package", () => {
    const value = { b: 2, a: "x" };
    expect(contentHash(value)).toBe(keccak256(stringToBytes('{"a":"x","b":2}')));
  });

  it("is insensitive to key insertion order", () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }));
  });

  it("is sensitive to every other difference", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ A: 1 }));
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
    expect(contentHash("1")).not.toBe(contentHash(1));
  });

  it("returns the canonical text alongside the digest", () => {
    const { canonical, hash } = contentHashWithCanonical({ b: 1, a: 2 });
    expect(canonical).toBe('{"a":2,"b":1}');
    expect(hash).toBe(hashCanonicalText(canonical));
  });

  it("refuses to hash a value the encoder rejects", () => {
    expect(() => contentHash(undefined)).toThrow(/CANONICAL_UNDEFINED/);
    expect(() => contentHash(1.5)).toThrow(/CANONICAL_NON_INTEGER/);
  });
});

describe("asciiBytes", () => {
  it("emits one byte per character", () => {
    expect([...asciiBytes("abc")]).toEqual([0x61, 0x62, 0x63]);
  });

  it("refuses anything outside 0x20-0x7e, so the Solidity guarantee is checked not assumed", () => {
    expect(() => asciiBytes("é")).toThrow(/CANONICAL_NON_ASCII_OUTPUT/);
    expect(() => asciiBytes("\u007f")).toThrow(/CANONICAL_NON_ASCII_OUTPUT/);
    expect(() => asciiBytes("\n")).toThrow(/CANONICAL_NON_ASCII_OUTPUT/);
  });
});

describe("struct hash (docs/CANONICAL.md §2)", () => {
  const mandateId = `0x${"11".repeat(32)}`;
  const decisionHash = `0x${"22".repeat(32)}`;

  it("matches abi.encode, which is what Solidity computes", () => {
    expect(settlementId(mandateId, decisionHash, 1n)).toBe(
      keccak256(
        encodeAbiParameters(
          [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
          [mandateId as `0x${string}`, decisionHash as `0x${string}`, 1n],
        ),
      ),
    );
  });

  it("is injective in each input (invariant I3)", () => {
    const base = settlementId(mandateId, decisionHash, 1n);
    expect(settlementId(decisionHash, decisionHash, 1n)).not.toBe(base);
    expect(settlementId(mandateId, mandateId, 1n)).not.toBe(base);
    expect(settlementId(mandateId, decisionHash, 2n)).not.toBe(base);
  });

  it("is case-insensitive about hex input but not value-insensitive", () => {
    expect(settlementId(mandateId.toUpperCase().replace("0X", "0x"), decisionHash, 1n)).toBe(
      settlementId(mandateId, decisionHash, 1n),
    );
  });

  it("rejects malformed bytes32 rather than padding it", () => {
    expect(() => settlementId("0xdead", decisionHash, 1n)).toThrow(/HASH_BAD_BYTES32/);
    expect(() => settlementId(mandateId, "", 1n)).toThrow(/HASH_BAD_BYTES32/);
    expect(() => settlementId(mandateId, decisionHash, -1n)).toThrow(/HASH_BAD_UINT/);
  });

  it("is not abi.encodePacked — the collision packed encoding allows must not occur", () => {
    // ("ab","c") and ("a","bc") collide under encodePacked. Under abi.encode they
    // cannot, which is why §2 forbids the packed form for multi-field hashes.
    const left = structHash([{ type: "string" }, { type: "string" }] as const, ["ab", "c"]);
    const right = structHash([{ type: "string" }, { type: "string" }] as const, ["a", "bc"]);
    expect(left).not.toBe(right);
  });

  it("requires one value per declared type", () => {
    expect(() => structHash([{ type: "uint256" }] as const, [])).toThrow(/structHash needs one value per type/);
  });
});

describe("assertBytes32", () => {
  it("lowercases so two spellings of one value compare equal", () => {
    expect(assertBytes32(`0x${"AB".repeat(32)}`)).toBe(`0x${"ab".repeat(32)}`);
  });

  it("rejects the wrong length or a missing prefix", () => {
    expect(() => assertBytes32("0x00")).toThrow(/HASH_BAD_BYTES32/);
    expect(() => assertBytes32("ab".repeat(32))).toThrow(/HASH_BAD_BYTES32/);
    expect(() => assertBytes32(`0x${"zz".repeat(32)}`)).toThrow(/HASH_BAD_BYTES32/);
  });
});
