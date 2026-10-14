"""pytest/gltest configuration for the direct-mode Intelligent Contract suites.

Driver-owned shared scaffolding. Leaves own their `test_*.py` files; this file exists
so every direct-mode gate can assert on a token that **only a fully passing run can
print**.

Why that matters
----------------
The obvious expectation for a pytest gate is the word "passed". It is also useless:
pytest prints `1 failed, 4 passed` on failure, so a gate expecting "passed" goes green
while tests are red. `gate-lint.mjs` flags exactly this, and it flagged it here.

So the token below is emitted only when the session exited zero, nothing failed, and
at least one test was collected. It also carries the `-k` expression, so a gate written
as

    CHECK:  gltest contracts/genlayer/tests/direct/test_registry.py -v -k agent
    EXPECT: DIRECT-SUITE OK k=agent

measures "every test matching `agent` passed, and there was at least one". A typo in
the filter collects nothing, pytest exits 5, no token is printed, and the gate fails
instead of passing over an empty set.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

GENLAYER_ROOT = Path(__file__).resolve().parents[2]
if str(GENLAYER_ROOT) not in sys.path:
    sys.path.insert(0, str(GENLAYER_ROOT))


def pytest_sessionfinish(session, exitstatus) -> None:
    collected = getattr(session, "testscollected", 0)
    failed = getattr(session, "testsfailed", 0)
    if int(exitstatus) != 0 or collected == 0 or failed:
        return

    keyword = getattr(session.config.option, "keyword", "") or ""
    label = f"k={keyword} " if keyword else ""
    lines = [f"DIRECT-SUITE OK {label}{collected} tests"]

    # The cross-contract integration suite gets its own token, so node-1.2:N6 can assert
    # on the integration specifically rather than on "some direct-mode suite passed".
    # Printed only when every collected test came from that file, so a wider run cannot
    # satisfy the narrower claim.
    files = {item.path.name for item in session.items} if getattr(session, "items", None) else set()
    if files == {"test_cross_contract.py"}:
        lines.append(f"CROSS-CONTRACT OK {collected} tests")

    terminal = session.config.pluginmanager.get_plugin("terminalreporter")
    for line in lines:
        if terminal is not None:
            terminal.write_line("")
            terminal.write_line(line)
        else:
            print(f"\n{line}")


# ── direct-mode SDK pin ──────────────────────────────────────────────────────

#: The GenVM runner used for every direct-mode deployment in this suite.
#:
#: Pinned deliberately. Two runners are cached locally and they do not behave the same:
#:
#:   v0.2.16      works
#:   v0.3.0-rc7   fails every deployment with
#:                genlayer.calldata.DecodingError: unexpected end of memory
#:
#: The default (no `sdk_version`) resolves the newest release and therefore also fails,
#: which is why this is pinned rather than left implicit. The failure is in the runner's
#: own calldata decoder, not in any contract — a one-field contract with no imports fails
#: identically — so there is nothing to fix on this side.
#:
#: Established by probing both runners against a minimal contract. The same probe proved
#: the two facts this project's design rests on: an Intelligent Contract CAN import a
#: local package (so `lib/` is importable from all four contracts), and the vendored
#: pure-Python keccak runs inside the GenVM.
DIRECT_SDK_VERSION = "v0.2.16"


@pytest.fixture
def deploy(direct_deploy):
    """Deploys a contract from contracts/genlayer/ against the pinned runner.

    Every test uses this rather than `direct_deploy` so the pin lives in one place and a
    new test cannot silently pick the broken runner.
    """

    def _deploy(contract_file: str, *args, **kwargs):
        return direct_deploy(
            str(GENLAYER_ROOT / contract_file), *args, sdk_version=DIRECT_SDK_VERSION, **kwargs
        )

    return _deploy
