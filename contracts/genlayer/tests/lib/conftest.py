"""pytest/gltest configuration for the shared-library suite.

Two jobs:

* put `contracts/genlayer` on `sys.path` so `import lib` works regardless of where
  the runner was invoked from;
* print the gate's success token, once, and only when the whole session passed with
  at least one test collected.

The token is printed from `pytest_sessionfinish` rather than from inside a test
because a test that prints a token proves only that the test ran. Here it is gated on
`exitstatus == 0`, zero failures, and a non-zero collected count, so a configuration
change that silently stopped collecting the suite reports failure rather than a quiet
pass over an empty set.
"""

from __future__ import annotations

import sys
from pathlib import Path

GENLAYER_ROOT = Path(__file__).resolve().parents[2]
if str(GENLAYER_ROOT) not in sys.path:
    sys.path.insert(0, str(GENLAYER_ROOT))


def pytest_sessionfinish(session, exitstatus) -> None:
    collected = getattr(session, "testscollected", 0)
    failed = getattr(session, "testsfailed", 0)
    if int(exitstatus) == 0 and collected > 0 and failed == 0:
        terminal = session.config.pluginmanager.get_plugin("terminalreporter")
        line = f"GENLIB-SUITE OK {collected} tests"
        if terminal is not None:
            terminal.write_line("")
            terminal.write_line(line)
        else:
            print(f"\n{line}")
