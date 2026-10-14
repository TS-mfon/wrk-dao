"""G3: every illegal value is refused, including each float spelling JavaScript accepts.

This gate is load-bearing, not cosmetic. docs/CANONICAL.md §1.2 tolerates one
asymmetry between the two encoders: JavaScript cannot see the spelling `2.0` because
JSON.parse turned it into the integer 2 before the encoder ran, while Python keeps the
distinction and rejects it.

That is only acceptable because it fails closed. A producer emitting `2.0` makes Python
refuse the payload, so the mission or decision is never created; it can never make
Python emit `2.0` where JavaScript emits `2`. If Python ever starts accepting floats,
the silent hash fork that document exists to prevent is reopened -- so every
reject_python_only vector is checked here individually.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import Checker, load_frozen_vectors  # noqa: E402

from lib.canonical import CanonicalError, canonicalize, is_canonicalizable  # noqa: E402
from lib.hashing import content_hash  # noqa: E402


def main() -> None:
    _, inputs = load_frozen_vectors()
    checker = Checker()

    # ── shared reject vectors ────────────────────────────────────────────────
    checker.check(len(inputs["reject"]) > 0, "fixtures must carry reject vectors")
    for vector in inputs["reject"]:
        checker.raises(
            lambda v=vector: canonicalize(v["value"]),
            f"reject vector {vector['name']} ({vector.get('reason', '')})",
        )
        checker.equal(
            is_canonicalizable(vector["value"]), False, f"is_canonicalizable({vector['name']}) must be False"
        )
        # A hash of an illegal value is worse than no hash.
        checker.raises(lambda v=vector: content_hash(v["value"]), f"content_hash must refuse {vector['name']}")

    # ── the fail-closed half of the documented asymmetry ─────────────────────
    checker.check(len(inputs["reject_python_only"]) > 0, "fixtures must carry reject_python_only vectors")
    for vector in inputs["reject_python_only"]:
        # The fixture records what JavaScript legitimately emits. Python must refuse
        # the same input, and the error must name the float -- not trip over some
        # unrelated guard that happens to fire first.
        checker.check(
            "js_canonical" in vector, f"{vector['name']} must record its JavaScript output"
        )
        checker.raises(
            lambda v=vector: canonicalize(v["value"]),
            f"python-only reject {vector['name']} (JavaScript emits {vector.get('js_canonical')!r})",
            "CANONICAL_FLOAT",
        )

    # The spellings a JSON transport turns into floats, asserted directly as well as
    # through the fixtures, so the gate does not depend on the fixture file listing them.
    for label, value in (
        ("integral float 2.0", 2.0),
        ("negative float zero", -0.0),
        ("float zero", 0.0),
        ("exponent form 1e2", 1e2),
        ("nested integral float", {"a": 2.0}),
        ("integral float in array", [1, 2.0, 3]),
        ("deeply nested float", {"a": {"b": [{"c": 4.0}]}}),
        ("non-integral float", 1.5),
    ):
        checker.raises(lambda v=value: canonicalize(v), f"must refuse {label}", "CANONICAL_FLOAT")

    # ── Python-local illegal values ──────────────────────────────────────────
    for label, value, code in (
        ("NaN", float("nan"), "CANONICAL_FLOAT"),
        ("Infinity", float("inf"), "CANONICAL_FLOAT"),
        ("-Infinity", float("-inf"), "CANONICAL_FLOAT"),
        ("unsafe integer above", 9007199254740992, "CANONICAL_UNSAFE_INTEGER"),
        ("unsafe integer below", -9007199254740992, "CANONICAL_UNSAFE_INTEGER"),
        ("bytes", b"abc", "CANONICAL_UNSUPPORTED_TYPE"),
        ("bytearray", bytearray(b"abc"), "CANONICAL_UNSUPPORTED_TYPE"),
        ("set", {1, 2}, "CANONICAL_UNSUPPORTED_TYPE"),
        ("complex", 1 + 2j, "CANONICAL_UNSUPPORTED_TYPE"),
        ("non-string key", {1: "a"}, "CANONICAL_NON_STRING_KEY"),
        ("None key", {None: "a"}, "CANONICAL_NON_STRING_KEY"),
        ("key with dash", {"a-b": 1}, "CANONICAL_BAD_KEY"),
        ("key with dot", {"a.b": 1}, "CANONICAL_BAD_KEY"),
        ("key with space", {"a b": 1}, "CANONICAL_BAD_KEY"),
        ("empty key", {"": 1}, "CANONICAL_BAD_KEY"),
        ("non-ascii key", {"é": 1}, "CANONICAL_BAD_KEY"),
        ("astral key", {"\U0001F600": 1}, "CANONICAL_BAD_KEY"),
        ("nested bad key", {"a": {"b c": 1}}, "CANONICAL_BAD_KEY"),
        ("bad key inside array", [{"b-c": 1}], "CANONICAL_BAD_KEY"),
        ("object", object(), "CANONICAL_UNSUPPORTED_TYPE"),
    ):
        checker.raises(lambda v=value: canonicalize(v), f"python-local reject: {label}", code)

    # Depth is bounded in both directions, so the boundary is pinned rather than only
    # the failing side.
    def nest(depth: int):
        value = 1
        for _ in range(depth):
            value = {"a": value}
        return value

    checker.check(isinstance(canonicalize(nest(120)), str), "120 levels of nesting must be accepted")
    checker.raises(lambda: canonicalize(nest(200)), "over-depth", "CANONICAL_DEPTH")

    # ── what must still be accepted ──────────────────────────────────────────
    # True/False must encode as JSON booleans, not as the integers they subclass.
    checker.equal(canonicalize(True), "true", "True encodes as a boolean")
    checker.equal(canonicalize(False), "false", "False encodes as a boolean")
    checker.equal(canonicalize({"a": True}), '{"a":true}', "nested boolean")
    checker.equal(canonicalize(None), "null", "None encodes as null")
    checker.equal(canonicalize(9007199254740991), "9007199254740991", "the safe integer boundary")
    checker.equal(canonicalize(-9007199254740991), "-9007199254740991", "the negative safe boundary")
    # A tuple is a list on the wire. Accepting it is a convenience, and it must
    # produce the same bytes as the list, or two call sites would hash differently.
    checker.equal(canonicalize((1, 2)), "[1,2]", "a tuple encodes as an array")
    checker.equal(canonicalize((1, 2)), canonicalize([1, 2]), "tuple and list agree")

    # Errors are typed.
    try:
        canonicalize(1.5)
        checker.check(False, "canonicalize(1.5) must raise")
    except CanonicalError as error:
        checker.equal(error.code, "CANONICAL_FLOAT", "the error carries a stable code")
        checker.check(isinstance(error, TypeError), "CanonicalError subclasses TypeError")

    checker.finish("GENLIB-REJECTS OK")


if __name__ == "__main__":
    main()
