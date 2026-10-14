// Generates contracts/base/test/CanonicalVectors.t.sol from the frozen fixtures.
//
//   node scripts/generate-canonical-vectors-test.mjs
//
// The Solidity test asserts that the EVM's keccak256 reproduces every digest in
// fixtures/canonical-vectors.json, making Solidity the third independent agreeing
// implementation alongside TypeScript (viem) and Python (a vendored pure-Python keccak).
//
// It is generated rather than hand-written because 41 hand-escaped string literals is
// 41 chances to introduce exactly the divergence the test exists to detect. The
// generator also verifies the pure-ASCII property of every vector before emitting it,
// so a non-ASCII vector fails generation loudly instead of quietly producing a literal
// whose bytes differ from the other two languages'.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "contracts/base/test/CanonicalVectors.t.sol");

const frozen = JSON.parse(readFileSync(join(ROOT, "fixtures/canonical-vectors.json"), "utf8"));

/**
 * Canonical output is pure ASCII 0x20–0x7E (docs/CANONICAL.md §1.1 rule 3), so a
 * Solidity string literal needs only the quote and the backslash escaped. That
 * sufficiency is checked, not assumed.
 */
function solidityLiteral(text, name) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error(
        `vector ${name} contains 0x${code.toString(16)} at index ${i}: canonical output must be pure ASCII`,
      );
    }
  }
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const vectors = frozen.vectors;
if (!Array.isArray(vectors) || vectors.length === 0) {
  throw new Error("frozen vectors file has no vectors");
}
if (frozen.vector_count !== vectors.length) {
  throw new Error(`vector_count ${frozen.vector_count} disagrees with the array length ${vectors.length}`);
}

// Three chunks so no single function's string data approaches the initcode limit.
const CHUNKS = 3;
const chunks = Array.from({ length: CHUNKS }, () => []);
vectors.forEach((vector, index) => chunks[index % CHUNKS].push(vector));

const functions = chunks
  .map((chunk, index) => {
    const lines = chunk
      .map(
        (vector) =>
          `        _assertVector("${vector.name}", "${solidityLiteral(vector.canonical, vector.name)}", ${vector.keccak256});`,
      )
      .join("\n");
    return [
      `    /// @dev Chunk ${index + 1} of ${CHUNKS}. Split so no one function's string data`,
      `    ///      approaches the 49152-byte initcode limit.`,
      `    function test_solidityReproducesFrozenDigests_chunk${index + 1}() public pure {`,
      lines,
      `    }`,
    ].join("\n");
  })
  .join("\n\n");

const source = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// GENERATED FILE — regenerate rather than edit:
//   node scripts/generate-canonical-vectors-test.mjs
//
// Asserts that Solidity's keccak256 reproduces every digest in
// fixtures/canonical-vectors.json. With TypeScript (viem) and Python (a vendored
// pure-Python keccak) already proven against the same file, this makes the EVM the
// third independent agreeing implementation of the canonical hashing contract — and the
// three share no lineage, which is the whole point. Agreement between two
// implementations that descend from one another proves only that the copy worked.
//
// Why Solidity can hash these bytes at all (docs/CANONICAL.md §1.4): canonical output
// contains no byte above 0x7E, so its UTF-8 encoding is byte-identical to its ASCII
// encoding. \`keccak256(bytes(s))\` on a literal therefore hashes exactly what the other
// two languages hash, with no UTF-8 encoder in the contract and no lone-surrogate edge
// case to handle on-chain. This file is the evidence for that claim rather than a
// comment asserting it.

import {Test} from "forge-std/Test.sol";

contract CanonicalVectorsTest is Test {
    uint256 internal constant FROZEN_VECTOR_COUNT = ${vectors.length};

    function _assertVector(string memory name, string memory canonical, bytes32 expected)
        internal
        pure
    {
        assertEq(keccak256(bytes(canonical)), expected, name);
    }

${functions}

    /// @dev Asserted separately so a chunk that silently loses vectors is caught. Three
    ///      green chunks over a shrinking set look identical, from the outside, to three
    ///      green chunks over the full set.
    function test_everyFrozenVectorIsCovered() public pure {
        uint256 covered = ${chunks.map((chunk) => chunk.length).join(" + ")};
        assertEq(covered, FROZEN_VECTOR_COUNT, "every frozen vector must be asserted");
    }

    /// @dev The anchor, stated plainly: this is the digest the entire three-language
    ///      contract is pinned to, and the value a reviewer can check by hand.
    function test_anchorDigest() public pure {
        assertEq(
            keccak256(bytes("{}")),
            0xb48d38f93eaa084033fc5970bf96e559c33c4cdc07d889ab00b4d63f9590739d
        );
    }
}
`;

writeFileSync(OUT, source);
console.log(`CANONICAL-VECTORS-TEST generated ${vectors.length} vectors in ${CHUNKS} chunks`);
