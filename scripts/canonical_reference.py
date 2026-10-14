"""Reference implementation of WRK canonical JSON for the Python/GenLayer side.

Driver-owned. contracts/genlayer/lib/canonical.py ships the production copy and
must produce byte-identical output to scripts/canonical-reference.mjs.

The rules live in docs/CANONICAL.md. This module exists so the parity test can
compare the two languages directly instead of trusting that they agree.
"""

from __future__ import annotations

import json
import re

KEY_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")

MAX_SAFE_INTEGER = 9007199254740991
MIN_SAFE_INTEGER = -9007199254740991


def _validate(value: object, path: str = "$") -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int):
        # bool is a subclass of int and was already handled above.
        if value > MAX_SAFE_INTEGER or value < MIN_SAFE_INTEGER:
            raise TypeError(
                f"canonical JSON rejects unsafe integer {value} at {path}: "
                "encode it as a decimal string"
            )
        return
    if isinstance(value, float):
        raise TypeError(f"canonical JSON rejects float {value!r} at {path}")
    if isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _validate(item, f"{path}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"canonical JSON rejects non-string key {key!r} at {path}")
            if not KEY_PATTERN.match(key):
                raise TypeError(
                    f"canonical JSON rejects key {key!r} at {path}: "
                    "keys must match ^[A-Za-z0-9_]+$"
                )
            _validate(item, f"{path}.{key}")
        return
    raise TypeError(f"canonical JSON rejects {type(value).__name__} at {path}")


def canonicalize(value: object) -> str:
    """Return the canonical JSON text for ``value``.

    ``ensure_ascii=True`` keeps the output pure ASCII, which is what makes the
    JavaScript and Python encoders agree without a UTF-8 or lone-surrogate
    negotiation. ``allow_nan=False`` turns NaN/Infinity into an error rather
    than the non-standard tokens Python would otherwise emit.
    """
    _validate(value)
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )
