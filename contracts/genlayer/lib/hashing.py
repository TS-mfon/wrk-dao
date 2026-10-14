"""Hashing — the two constructions from ``docs/CANONICAL.md``, and nothing else.

    §1 content hash   keccak256( ascii_bytes( canonical_json(value) ) )
    §2 struct hash    keccak256( abi.encode(field, ...) )   never abi.encodePacked

Using the wrong one is a bug even when the digest looks fine.

``abi.encodePacked`` over more than one dynamic field is not injective:
``("ab", "c")`` and ``("a", "bc")`` produce identical bytes, so two different
settlements could share a ``settlementId``. There is deliberately no packed
variant in this module — the abi encoder below pads every field to 32 bytes and
length-prefixes dynamic types, which is exactly what Solidity's ``abi.encode``
does and is why §2 requires it.
"""

from __future__ import annotations

from typing import Any

from .canonical import canonicalize
from .keccak import keccak256, keccak256_hex

UINT256_MAX = (1 << 256) - 1


class HashError(ValueError):
    """Raised when a value cannot be encoded for hashing."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def ascii_bytes(text: str) -> bytes:
    """Encode canonical text, asserting the pure-ASCII guarantee."""
    for index, char in enumerate(text):
        code = ord(char)
        if code < 0x20 or code > 0x7E:
            raise HashError(
                "CANONICAL_NON_ASCII_OUTPUT",
                f"canonical output must be pure ASCII 0x20-0x7e, found 0x{code:02x} at index {index}",
            )
    return text.encode("ascii")


def hash_canonical_text(canonical: str) -> str:
    """keccak256 over already-canonical text, as ``0x``-prefixed hex."""
    return keccak256_hex(ascii_bytes(canonical))


def content_hash(value: Any) -> str:
    """Content hash (§1) of ``value``.

    This is the digest stored for DAO metadata, missions, proposals, deliverables,
    evidence bundles and — critically — adjudication decisions, whose hash becomes
    the ``decisionHash`` the Base escrow settles against.
    """
    return hash_canonical_text(canonicalize(value))


def content_hash_with_canonical(value: Any) -> tuple[str, str]:
    """Return ``(canonical_text, digest)`` for callers that store both."""
    canonical = canonicalize(value)
    return canonical, hash_canonical_text(canonical)


# ── abi.encode, the subset §2 needs ──────────────────────────────────────────


def _word(value: int) -> bytes:
    if value < 0 or value > UINT256_MAX:
        raise HashError("HASH_BAD_UINT", f"value out of uint256 range: {value}")
    return value.to_bytes(32, "big")


def normalize_bytes32(value: str, label: str = "value") -> str:
    """Validate a ``bytes32`` hex string and return it lowercased."""
    if not isinstance(value, str):
        raise HashError("HASH_BAD_BYTES32", f"{label} must be a hex string, got {type(value).__name__}")
    text = value.lower()
    if not text.startswith("0x") or len(text) != 66:
        raise HashError(
            "HASH_BAD_BYTES32", f"{label} must be 0x followed by 64 hex digits, got {len(value)} chars"
        )
    try:
        int(text, 16)
    except ValueError as error:
        raise HashError("HASH_BAD_BYTES32", f"{label} is not hexadecimal: {value}") from error
    return text


def bytes32_to_bytes(value: str, label: str = "value") -> bytes:
    return bytes.fromhex(normalize_bytes32(value, label)[2:])


def settlement_id(mandate_id_b32: str, decision_hash: str, nonce: int) -> str:
    """Struct hash (§2) for the settlement identifier. Per SPEC §40:

        settlementId = keccak256(abi.encode(mandateId, decisionHash, nonce))

    Invariant I3: changing any input changes the id. Invariant I2 — at most one
    execution per ``settlementId`` — depends on this being reproducible from chain
    data, so the encoding is pinned here and re-derived identically in Solidity
    and TypeScript.

    ``mandate_id_b32`` is the mandate's **bytes32** form (see ``lib.ids``), not its
    ``mnd_`` string: the on-chain record holds bytes32 and the hash must match what
    the escrow computes.
    """
    if isinstance(nonce, bool) or not isinstance(nonce, int):
        raise HashError("HASH_BAD_UINT", f"nonce must be an integer, got {type(nonce).__name__}")
    encoded = (
        bytes32_to_bytes(mandate_id_b32, "mandateId")
        + bytes32_to_bytes(decision_hash, "decisionHash")
        + _word(nonce)
    )
    return keccak256_hex(encoded)


def struct_hash(fields: list[tuple[str, Any]]) -> str:
    """Generic ``abi.encode``-based struct hash over ``(type, value)`` pairs.

    Supports the static types this protocol signs: ``bytes32``, ``uint8``..
    ``uint256``, ``address`` and ``bool``. Dynamic types are deliberately absent —
    they require offset/length encoding, and every struct hash in this protocol is
    static. A caller that needs one should extend this explicitly rather than reach
    for a packed concatenation.
    """
    out = bytearray()
    for kind, value in fields:
        if kind == "bytes32":
            out += bytes32_to_bytes(str(value), "bytes32 field")
        elif kind == "address":
            text = str(value).lower()
            if not text.startswith("0x") or len(text) != 42:
                raise HashError("HASH_BAD_BYTES32", f"address must be 0x + 40 hex digits, got {value}")
            out += bytes(12) + bytes.fromhex(text[2:])
        elif kind == "bool":
            out += _word(1 if value else 0)
        elif kind.startswith("uint"):
            bits = int(kind[4:] or "256")
            if bits % 8 != 0 or not 8 <= bits <= 256:
                raise HashError("HASH_BAD_UINT", f"unsupported integer width {kind}")
            if isinstance(value, bool) or not isinstance(value, int):
                raise HashError("HASH_BAD_UINT", f"{kind} field must be an integer, got {value!r}")
            if value < 0 or value >= (1 << bits):
                raise HashError("HASH_BAD_UINT", f"{value} does not fit in {kind}")
            out += _word(value)
        else:
            raise HashError("HASH_BAD_UINT", f"unsupported abi type {kind!r}")
    return keccak256_hex(bytes(out))


__all__ = [
    "HashError",
    "ascii_bytes",
    "bytes32_to_bytes",
    "content_hash",
    "content_hash_with_canonical",
    "hash_canonical_text",
    "keccak256",
    "keccak256_hex",
    "normalize_bytes32",
    "settlement_id",
    "struct_hash",
]
