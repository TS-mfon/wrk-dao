"""Canonical JSON — production Python encoder.

Normative definition: ``docs/CANONICAL.md`` §1. Version ``wrk/canonical-json/v1``.

This must agree with ``packages/types/src/canonical.ts`` on every byte of every
input. ``fixtures/canonical-vectors.json`` is the frozen contract and
``contracts/genlayer/tests/lib/verify_vectors.py`` proves it.

The rules, restated so an implementer never has to leave this file:

1. Object keys sorted ascending.
2. Separators are exactly ``,`` and ``:``. No other whitespace.
3. Output is pure ASCII. ``ensure_ascii=True`` escapes every code point outside
   0x20–0x7E as ``\\uXXXX`` with lowercase hex — **including 0x7F (DEL)**, which
   is the single code point in U+0000–U+10FFF where a plausible "printable ASCII"
   boundary changes the answer. That was settled by exhaustive probe across both
   languages, not by reading either one's documentation. Do not "fix" it.
4. Object keys must match ``^[A-Za-z0-9_]+$``. Restricting keys to ASCII is what
   makes JavaScript's "sort by UTF-16 code unit" and Python's "sort by code point"
   the same ordering. Without it, an astral key such as U+1F600 sorts before
   U+FFFD in JavaScript and after it in Python, silently forking every hash that
   contains both.
5. Numbers must be safe integers, in ``[-(2^53-1), 2^53-1]``. Floats are rejected
   outright — see below. Anything that can exceed 2^53 travels as a decimal
   string: a uint256 USDC amount is a string, never a number.
6. ``None`` is allowed. Arrays keep their order.

The deliberate asymmetry with JavaScript
----------------------------------------
Python rejects ``2.0``; JavaScript cannot even see it, because ``JSON.parse`` has
already turned that spelling into the integer 2 by the time its encoder runs.

This direction is safe and is the reason the difference is tolerable at all
(``docs/CANONICAL.md`` §1.2): a producer that emits ``2.0`` makes Python refuse the
payload, so the mission or decision is never created. It can never make Python
emit ``2.0`` where JavaScript emits ``2``. Fail-closed on one side beats agreement
on a wrong byte — which is why ``verify_rejects.py`` is load-bearing rather than
cosmetic.
"""

from __future__ import annotations

import json
import re
from typing import Any

CANONICAL_JSON_VERSION = "wrk/canonical-json/v1"

KEY_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")

MAX_SAFE_INTEGER = 9007199254740991
MIN_SAFE_INTEGER = -9007199254740991

#: The deepest frozen vector nests 11 levels. 128 leaves ample headroom while
#: keeping recursion bounded, so a hostile document cannot become a
#: RecursionError inside an adjudicator.
MAX_DEPTH = 128


class CanonicalError(TypeError):
    """Raised for any value outside the canonical JSON value space.

    Subclasses ``TypeError`` so code written against the reference encoder's
    behaviour keeps working, and carries ``code`` and ``path`` so a caller can
    react to the reason rather than parse the message.
    """

    def __init__(self, code: str, message: str, path: str = "$") -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.path = path


def _validate(value: Any, path: str, depth: int) -> None:
    if depth > MAX_DEPTH:
        raise CanonicalError(
            "CANONICAL_DEPTH", f"exceeds max nesting depth {MAX_DEPTH} at {path}", path
        )

    if value is None or isinstance(value, str):
        return

    # bool before int: bool is a subclass of int, and True must encode as `true`
    # rather than as the integer 1.
    if isinstance(value, bool):
        return

    if isinstance(value, int):
        if value > MAX_SAFE_INTEGER or value < MIN_SAFE_INTEGER:
            raise CanonicalError(
                "CANONICAL_UNSAFE_INTEGER",
                f"rejects unsafe integer {value} at {path}: encode it as a decimal string",
                path,
            )
        return

    if isinstance(value, float):
        # Including integral spellings such as 2.0 and -0.0. See the module
        # docstring: this is the fail-closed half of the documented asymmetry.
        raise CanonicalError(
            "CANONICAL_FLOAT",
            f"rejects float {value!r} at {path}: money and timestamps are integers, "
            "large values are decimal strings",
            path,
        )

    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _validate(item, f"{path}[{index}]", depth + 1)
        return

    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalError(
                    "CANONICAL_NON_STRING_KEY",
                    f"rejects non-string key {key!r} at {path}",
                    path,
                )
            if not KEY_PATTERN.match(key):
                raise CanonicalError(
                    "CANONICAL_BAD_KEY",
                    f"rejects key {key!r} at {path}: keys must match ^[A-Za-z0-9_]+$",
                    path,
                )
            _validate(item, f"{path}.{key}", depth + 1)
        return

    # bytes, set, Decimal, complex, a dataclass, an arbitrary object — anything
    # json.dumps would refuse or, worse, coerce.
    raise CanonicalError(
        "CANONICAL_UNSUPPORTED_TYPE", f"rejects {type(value).__name__} at {path}", path
    )


def canonicalize(value: Any) -> str:
    """Return the canonical JSON text for ``value``.

    Raises :class:`CanonicalError` for anything outside the accepted value space.
    """
    _validate(value, "$", 0)
    text = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )
    # The ASCII guarantee is what lets Solidity hash these bytes with no UTF-8
    # encoder on-chain (docs/CANONICAL.md §1.4). Check it rather than assume it:
    # the cost is one scan and the failure it catches is a silent three-language
    # fork.
    for index, char in enumerate(text):
        code = ord(char)
        if code < 0x20 or code > 0x7E:
            raise CanonicalError(
                "CANONICAL_NON_ASCII_OUTPUT",
                f"canonical output must be pure ASCII 0x20-0x7e, found 0x{code:02x} at index {index}",
            )
    return text


def is_canonicalizable(value: Any) -> bool:
    """True when ``value`` can be canonicalised. Never raises."""
    try:
        canonicalize(value)
        return True
    except CanonicalError:
        return False
