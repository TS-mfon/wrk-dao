"""G1: lib.canonical.canonicalize reproduces every frozen canonical string byte for byte.

The count in the success token is measured from the frozen file at runtime. A
hardcoded 41 would still pass if the file shrank to one vector, which is exactly the
failure this gate exists to catch.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import Checker, load_frozen_vectors  # noqa: E402

from lib.canonical import canonicalize  # noqa: E402


def main() -> None:
    paired, _ = load_frozen_vectors()
    checker = Checker()

    for vector in paired:
        produced = canonicalize(vector["value"])
        expected = vector["canonical"]
        if produced != expected:
            # Report the first differing byte: "these strings differ" is not actionable.
            index = 0
            while index < len(produced) and index < len(expected) and produced[index] == expected[index]:
                index += 1
            checker.check(
                False,
                f"{vector['name']}: canonical text diverges at index {index}\n"
                f"       expected: {expected[max(0, index - 12): index + 12]!r}\n"
                f"       actual:   {produced[max(0, index - 12): index + 12]!r}",
            )
            continue

        # Pure ASCII output is what lets Solidity hash the same bytes with no UTF-8
        # encoder on-chain (docs/CANONICAL.md §1.4).
        for position, char in enumerate(produced):
            code = ord(char)
            if code < 0x20 or code > 0x7E:
                checker.check(False, f"{vector['name']}: non-ASCII output 0x{code:02x} at index {position}")
                break

        # Idempotence through a JSON round-trip.
        import json

        checker.equal(
            canonicalize(json.loads(produced)), produced, f"{vector['name']}: parse/re-encode fixed point"
        )

        # Key order must not depend on insertion order.
        if produced.startswith("{") and produced != "{}":
            checker.equal(
                canonicalize(_reverse_keys(vector["value"])), produced, f"{vector['name']}: key order independence"
            )

    checker.finish(f"GENLIB-VECTORS OK {len(paired)}")


def _reverse_keys(value):
    if isinstance(value, list):
        return [_reverse_keys(item) for item in value]
    if isinstance(value, dict):
        return {key: _reverse_keys(value[key]) for key in reversed(list(value.keys()))}
    return value


if __name__ == "__main__":
    main()
