"""Shared plumbing for the verify_* gates.

Each gate script prints its success token last and only after every assertion has
passed. Anything else exits non-zero with a diagnosis. No gate copies a count out of
the fixtures as its own proof -- counts are measured at runtime.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

#: contracts/genlayer -- so `import lib` works however the script was invoked.
GENLAYER_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = GENLAYER_ROOT.parents[1]

if str(GENLAYER_ROOT) not in sys.path:
    sys.path.insert(0, str(GENLAYER_ROOT))


def load_json(relative_to_repo: str):
    return json.loads((REPO_ROOT / relative_to_repo).read_text(encoding="utf-8"))


def load_frozen_vectors():
    """Pair every frozen vector with its input, refusing an unpaired set either way."""
    frozen = load_json("fixtures/canonical-vectors.json")
    inputs = load_json("fixtures/canonical-inputs.json")

    algorithm = frozen.get("algorithm", {})
    if algorithm.get("canonical_json") != "wrk/canonical-json/v1":
        raise SystemExit(
            f"frozen vectors declare canonical_json {algorithm.get('canonical_json')!r}, "
            "expected wrk/canonical-json/v1"
        )
    if algorithm.get("digest") != "keccak256":
        raise SystemExit(f"frozen vectors declare digest {algorithm.get('digest')!r}, expected keccak256")

    vectors = frozen.get("vectors")
    if not isinstance(vectors, list) or not vectors:
        raise SystemExit("frozen vectors file has no vectors")
    if frozen.get("vector_count") != len(vectors):
        raise SystemExit(
            f"frozen vector_count {frozen.get('vector_count')} disagrees with the array length {len(vectors)}"
        )

    by_name = {entry["name"]: entry for entry in inputs["accept"]}
    paired = []
    for vector in vectors:
        entry = by_name.pop(vector["name"], None)
        if entry is None:
            raise SystemExit(f"frozen vector {vector['name']} has no matching accept input")
        paired.append(
            {
                "name": vector["name"],
                "value": entry["value"],
                "canonical": vector["canonical"],
                "keccak256": vector["keccak256"],
            }
        )
    if by_name:
        raise SystemExit(f"accept inputs with no frozen vector: {', '.join(sorted(by_name))}")

    return paired, inputs


class Checker:
    def __init__(self) -> None:
        self.failures = 0

    def check(self, condition: bool, message: str) -> None:
        if not condition:
            self.failures += 1
            print(f"  FAIL {message}", file=sys.stderr)

    def equal(self, actual, expected, message: str) -> None:
        if actual != expected:
            self.failures += 1
            print(
                f"  FAIL {message}\n       expected: {expected!r}\n       actual:   {actual!r}",
                file=sys.stderr,
            )

    def raises(self, fn, message: str, code: str | None = None) -> None:
        """Assert `fn` raises, and that the error carries `code` when given."""
        try:
            fn()
        except Exception as error:  # noqa: BLE001 - any refusal counts, the code is checked below
            actual = getattr(error, "code", None)
            if code is not None and actual != code:
                self.failures += 1
                print(
                    f"  FAIL {message}: expected code {code}, got {actual or type(error).__name__}: {error}",
                    file=sys.stderr,
                )
            return
        self.failures += 1
        print(f"  FAIL {message}: expected a raise, got a return", file=sys.stderr)

    def finish(self, token: str) -> None:
        if self.failures:
            print(f"\n{self.failures} check(s) failed", file=sys.stderr)
            raise SystemExit(1)
        print(token)
