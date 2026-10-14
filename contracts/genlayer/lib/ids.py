"""Identifiers — ``<prefix>_<ULID>`` (``docs/ARCHITECTURE.md`` §5).

Must agree exactly with ``packages/types/src/ids.ts``: the same string must decode
to the same ``bytes32`` in both languages, or the escrow and the adjudicator
disagree about which mandate is being paid.

The alphabet is the part that must be exactly right. ULID uses Crockford base32,
which excludes **I, L, O and U** because they are confusable. A decoder that
accepted them would let two different strings decode to the same value.
"""

from __future__ import annotations

import os
import time

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_DECODE = {char: index for index, char in enumerate(ALPHABET)}

ULID_LENGTH = 26
TIME_BITS = 48
RANDOM_BITS = 80
MAX_TIME = (1 << TIME_BITS) - 1
MAX_RANDOM = (1 << RANDOM_BITS) - 1
MAX_ULID = (1 << 128) - 1

#: Every object that carries an id, per docs/ARCHITECTURE.md §5.
ID_PREFIXES = ("agt", "dao", "msn", "prp", "mnd", "dlv", "evd", "dec", "stl")

_PREFIX_SET = frozenset(ID_PREFIXES)


class IdError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


def id_pattern(prefix: str) -> str:
    """The regex source for a valid id with this prefix, for validation layers."""
    assert_prefix(prefix)
    return rf"^{prefix}_[0-7][0-9A-HJKMNP-TV-Z]{{25}}$"


def assert_prefix(prefix: str) -> None:
    if prefix not in _PREFIX_SET:
        raise IdError("ID_BAD_PREFIX", f"unknown id prefix {prefix!r}")


def encode_ulid(value: int) -> str:
    if value < 0 or value > MAX_ULID:
        raise IdError("ID_OVERFLOW", f"ULID value does not fit in 128 bits: {value}")
    chars = [""] * ULID_LENGTH
    remaining = value
    for index in range(ULID_LENGTH - 1, -1, -1):
        chars[index] = ALPHABET[remaining & 31]
        remaining >>= 5
    return "".join(chars)


def decode_ulid(text: str) -> int:
    if len(text) != ULID_LENGTH:
        raise IdError("ID_BAD_FORMAT", f"ULID must be {ULID_LENGTH} characters, got {len(text)}")
    value = 0
    for index, char in enumerate(text):
        digit = _DECODE.get(char)
        if digit is None:
            raise IdError(
                "ID_BAD_ALPHABET",
                f"ULID character {char!r} at index {index} is outside Crockford base32 "
                "(I, L, O and U are excluded)",
            )
        value = value * 32 + digit
    if value > MAX_ULID:
        # 26 characters can express 130 bits; only the low 128 are an id, so the
        # first character must be 0-7.
        raise IdError("ID_OVERFLOW", "ULID decodes to more than 128 bits: first character must be 0-7")
    return value


def new_id(prefix: str, now_ms: int | None = None) -> str:
    """Mint a new id.

    With an explicit ``now_ms`` the timestamp is honoured exactly — the parameter
    exists for deterministic construction, and an id whose embedded time is not the
    time you asked for would be useless.

    Note for contract authors: this draws from ``os.urandom``, which is
    non-deterministic. **Do not call it inside an Intelligent Contract's
    deterministic path** — every validator would mint a different id and consensus
    would fail. Ids for on-chain objects come from the caller or from a
    deterministic derivation; this helper is for off-chain tooling and tests.
    """
    assert_prefix(prefix)
    stamp = int(time.time() * 1000) if now_ms is None else int(now_ms)
    if stamp < 0 or stamp > MAX_TIME:
        raise IdError("ID_BAD_FORMAT", f"timestamp out of ULID range: {stamp}")
    randomness = int.from_bytes(os.urandom(10), "big")
    return f"{prefix}_{encode_ulid((stamp << RANDOM_BITS) | randomness)}"


def parse_id(value: str, expected: str | None = None) -> dict[str, object]:
    """Parse and validate an id. Returns prefix, ulid, time_ms and the 128-bit value."""
    if not isinstance(value, str):
        raise IdError("ID_BAD_FORMAT", f"id must be a string, got {type(value).__name__}")
    separator = value.find("_")
    if separator == -1:
        raise IdError("ID_BAD_FORMAT", f"id {value!r} has no prefix separator")
    prefix = value[:separator]
    ulid = value[separator + 1 :]
    assert_prefix(prefix)
    if expected is not None and prefix != expected:
        raise IdError("ID_BAD_PREFIX", f"expected prefix {expected}, got {prefix}")
    decoded = decode_ulid(ulid)
    return {
        "id": value,
        "prefix": prefix,
        "ulid": ulid,
        "time_ms": decoded >> RANDOM_BITS,
        "value": decoded,
    }


def is_id(value: object, expected: str | None = None) -> bool:
    """True when ``value`` is a valid id. Never raises."""
    try:
        parse_id(value, expected)  # type: ignore[arg-type]
        return True
    except IdError:
        return False


def to_bytes32(value: str) -> str:
    """The on-chain form: the ULID's 128 bits, left-padded with 16 zero bytes.

    The prefix is deliberately not encoded — on-chain, an object's type is implied
    by which mapping holds it — so decoding requires naming the prefix.
    """
    parsed = parse_id(value)
    return "0x" + format(int(parsed["value"]), "064x")  # type: ignore[arg-type]


def from_bytes32(hex_value: str, prefix: str) -> str:
    """Inverse of :func:`to_bytes32`. Rejects a bytes32 whose high 16 bytes are set."""
    assert_prefix(prefix)
    if not isinstance(hex_value, str):
        raise IdError("ID_BAD_BYTES32", f"expected a hex string, got {type(hex_value).__name__}")
    text = hex_value.lower()
    if not text.startswith("0x") or len(text) != 66:
        raise IdError("ID_BAD_BYTES32", f"expected 0x followed by 64 hex digits, got {hex_value!r}")
    try:
        value = int(text, 16)
    except ValueError as error:
        raise IdError("ID_BAD_BYTES32", f"not hexadecimal: {hex_value!r}") from error
    if value > MAX_ULID:
        raise IdError(
            "ID_BAD_BYTES32",
            f"high 16 bytes must be zero for an id-shaped bytes32, got {text[:34]}",
        )
    return f"{prefix}_{encode_ulid(value)}"
