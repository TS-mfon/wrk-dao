#!/usr/bin/env python3
"""Emit the Python side of the canonical-JSON parity proof as JSON on stdout.

Usage: python3 scripts/canonical-cli.py fixtures/canonical-inputs.json

Output shape:
    {
      "accept":             [{"name": str, "canonical": str} | {"name": str, "error": str}],
      "reject":             [{"name": str, "rejected": bool, "error": str | null}],
      "reject_python_only": [{"name": str, "rejected": bool, "error": str | null}],
      "local":              [{"name": str, "rejected": bool, "error": str | null}]
    }

"local" holds cases that cannot travel through JSON (NaN, Infinity) and so are
constructed here. The JavaScript harness has its own equivalent list for
undefined, -0 and bigint. Both sides must reject their own list; the shared
vectors are what prove byte parity.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from canonical_reference import canonicalize  # noqa: E402


def _run(value: object) -> dict[str, object]:
    try:
        return {"canonical": canonicalize(value)}
    except Exception as exc:  # noqa: BLE001 - the error text is the observation
        return {"error": f"{type(exc).__name__}: {exc}"}


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2

    raw = Path(sys.argv[1]).read_text(encoding="utf-8")
    fixtures = json.loads(raw)

    accept = []
    for vector in fixtures["accept"]:
        accept.append({"name": vector["name"], **_run(vector["value"])})

    reject = []
    for vector in fixtures["reject"]:
        outcome = _run(vector["value"])
        reject.append(
            {
                "name": vector["name"],
                "rejected": "error" in outcome,
                "error": outcome.get("error"),
            }
        )

    # Cases JavaScript legitimately accepts because it has no float/int split.
    # Python must still refuse them; see the comment block in the fixtures file.
    reject_python_only = []
    for vector in fixtures["reject_python_only"]:
        outcome = _run(vector["value"])
        reject_python_only.append(
            {
                "name": vector["name"],
                "rejected": "error" in outcome,
                "error": outcome.get("error"),
            }
        )

    local = []
    for name, value in (
        ("nan", float("nan")),
        ("positive_infinity", float("inf")),
        ("negative_infinity", float("-inf")),
        ("float_zero", 0.0),
        ("negative_float_zero", -0.0),
        ("bytes_value", b"raw"),
        ("set_value", {1, 2}),
        ("non_string_key", {1: "one"}),
    ):
        outcome = _run(value)
        local.append(
            {"name": name, "rejected": "error" in outcome, "error": outcome.get("error")}
        )

    # ensure_ascii keeps the transport itself ASCII, so the JS side reads exactly
    # the code units Python produced with no encoding negotiation in between.
    json.dump(
        {
            "accept": accept,
            "reject": reject,
            "reject_python_only": reject_python_only,
            "local": local,
        },
        sys.stdout,
        ensure_ascii=True,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
