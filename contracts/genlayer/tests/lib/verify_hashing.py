"""G2: lib.hashing.content_hash reproduces every frozen keccak256 digest.

This is where the vendored keccak earns its place. The frozen digests were produced
by viem and cross-checked against Foundry's `cast keccak` and solc's own `keccak256`
inside a Solidity test -- three implementations that share no lineage with
lib/keccak.py. If this gate is green, the pure-Python permutation is correct.

It also pins the trap: hashlib.sha3_256 is NOT keccak256. The two differ only in a
domain-separation byte, so a mistake there would be silent and every digest would
disagree with Base. That difference is asserted directly below.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import Checker, load_frozen_vectors  # noqa: E402

from lib.hashing import (  # noqa: E402
    ascii_bytes,
    content_hash,
    content_hash_with_canonical,
    hash_canonical_text,
    settlement_id,
    struct_hash,
)
from lib.keccak import keccak256_hex  # noqa: E402

# Published Keccak-256 known answers, independent of this protocol's fixtures.
KNOWN_ANSWERS = {
    b"": "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    b"abc": "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    b"testing": "0x5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02",
}


def main() -> None:
    paired, _ = load_frozen_vectors()
    checker = Checker()

    for data, expected in KNOWN_ANSWERS.items():
        checker.equal(keccak256_hex(data), expected, f"published known answer for {data!r}")

    # The sponge's rate is 136 bytes. Inputs either side of that boundary exercise
    # the pad10*1 edge where the padding and terminator bits share one byte.
    for length in (0, 1, 135, 136, 137, 271, 272, 273):
        digest = keccak256_hex(b"a" * length)
        checker.check(
            digest.startswith("0x") and len(digest) == 66, f"digest shape at input length {length}"
        )

    # keccak256 is not SHA3-256. If these ever agree, the wrong function is wired in.
    import hashlib

    checker.check(
        keccak256_hex(b"abc") != "0x" + hashlib.sha3_256(b"abc").hexdigest(),
        "keccak256 must differ from hashlib.sha3_256 -- they are different functions",
    )

    for vector in paired:
        checker.equal(content_hash(vector["value"]), vector["keccak256"], f"{vector['name']}: content hash")
        checker.equal(
            hash_canonical_text(vector["canonical"]),
            vector["keccak256"],
            f"{vector['name']}: hash of the frozen text",
        )
        canonical, digest = content_hash_with_canonical(vector["value"])
        checker.equal(canonical, vector["canonical"], f"{vector['name']}: paired canonical text")
        checker.equal(digest, vector["keccak256"], f"{vector['name']}: paired digest")
        checker.equal(
            len(ascii_bytes(vector["canonical"])),
            len(vector["canonical"]),
            f"{vector['name']}: one byte per character",
        )

    # ascii_bytes must refuse anything outside 0x20-0x7e rather than assume the
    # guarantee holds.
    for bad in ("é", "\u007f", "\n", " "):
        checker.raises(lambda bad=bad: ascii_bytes(bad), f"ascii_bytes must refuse {bad!r}", "CANONICAL_NON_ASCII_OUTPUT")

    # Struct hash (§2): settlementId = keccak256(abi.encode(mandateId, decisionHash, nonce)).
    mandate = "0x" + "11" * 32
    decision = "0x" + "22" * 32
    base = settlement_id(mandate, decision, 1)
    checker.equal(
        base,
        struct_hash([("bytes32", mandate), ("bytes32", decision), ("uint256", 1)]),
        "settlement_id agrees with the generic abi.encode struct hash",
    )
    # Invariant I3: injective in every input.
    checker.check(settlement_id(mandate, decision, 2) != base, "changing the nonce changes the id")
    checker.check(settlement_id(decision, mandate, 1) != base, "swapping the two hashes changes the id")
    checker.check(settlement_id(mandate, mandate, 1) != base, "changing decisionHash changes the id")
    # Hex casing is a spelling, not a value.
    checker.equal(settlement_id(mandate.upper().replace("0X", "0x"), decision, 1), base, "hex casing is irrelevant")

    # abi.encode must be injective where abi.encodePacked is not. Packed encoding of
    # two 32-byte words is just concatenation, so the collision has to be built from
    # the field boundary: (a‖b, c) vs (a, b‖c) is only expressible with dynamic types,
    # which struct_hash refuses outright.
    checker.raises(
        lambda: struct_hash([("string", "ab"), ("string", "c")]),
        "struct_hash must refuse dynamic types rather than pack them",
    )

    checker.raises(lambda: settlement_id("0xdead", decision, 1), "short mandateId", "HASH_BAD_BYTES32")
    checker.raises(lambda: settlement_id(mandate, decision, -1), "negative nonce", "HASH_BAD_UINT")
    checker.raises(lambda: settlement_id(mandate, decision, 1 << 256), "nonce above uint256", "HASH_BAD_UINT")
    checker.raises(lambda: settlement_id(mandate, decision, True), "boolean nonce", "HASH_BAD_UINT")
    checker.raises(lambda: content_hash(1.5), "content_hash must refuse a float", "CANONICAL_FLOAT")

    checker.finish(f"GENLIB-HASHING OK {len(paired)}")


if __name__ == "__main__":
    main()
