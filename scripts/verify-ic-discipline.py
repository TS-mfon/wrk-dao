#!/usr/bin/env python3
"""Structural discipline checks for the GenLayer Intelligent Contracts.

    python3 scripts/verify-ic-discipline.py nondet [--only FILE ...]
    python3 scripts/verify-ic-discipline.py payment FILE [FILE ...]
    python3 scripts/verify-ic-discipline.py reputation [--only FILE ...]
    python3 scripts/verify-ic-discipline.py consolidation

Each mode prints exactly one success line and exits non-zero otherwise.

Why these are structural rather than behavioural
-----------------------------------------------
``docs/ARCHITECTURE.md`` §1 separates four authorities, and the failure mode it guards
against is one component acquiring two. Those failures do not show up as failing tests
— the suite keeps passing and the system simply means something different. A contract
that gains a payout function still orchestrates work correctly; a contract that reads
reputation still adjudicates; a nondet block in ``wrk_work`` still returns the right
answer most of the time. So each of these is checked by reading the code's shape.

Why AST and not grep
--------------------
These contracts' own docstrings discuss ``gl.nondet``, payment and reputation at
length, because explaining a boundary is part of documenting it. A text scanner fires
on the prose and has to be loosened until it stops catching anything. An AST walk sees
code and is blind to comments and strings.

Every mode runs its scanner against a positive control first and fails if the control
does not trip. An absence assertion that has never fired proves nothing by staying
quiet.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENLAYER = ROOT / "contracts" / "genlayer"

#: The four consolidated Intelligent Contracts (docs/ARCHITECTURE.md §3.1, owner decision).
CONTRACTS = ("wrk_registry.py", "wrk_work.py", "wrk_adjudicator.py", "wrk_reputation.py")

#: The only contract permitted to contain non-deterministic blocks.
NONDET_OWNER = "wrk_adjudicator.py"


# ── shared AST helpers ──────────────────────────────────────────────────────


def root_name(node: ast.AST) -> str | None:
    """Leftmost Name of an attribute chain: ``gl.nondet.web.get`` -> ``gl``."""
    while isinstance(node, ast.Attribute):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def dotted(node: ast.AST) -> str:
    parts: list[str] = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def parse(source: str, label: str) -> ast.AST | list[dict]:
    try:
        return ast.parse(source, filename=label)
    except SyntaxError as error:
        return [{"label": label, "line": error.lineno or 0, "kind": "syntax", "detail": str(error)}]


class Finding(dict):
    pass


def finding(label: str, node: ast.AST, kind: str, detail: str) -> dict:
    return {"label": label, "line": getattr(node, "lineno", 0), "kind": kind, "detail": detail}


# ── mode: nondet ────────────────────────────────────────────────────────────

NONDET_ROOTS = ("gl.nondet", "gl.eq_principle", "gl.vm.run_nondet_unsafe", "gl.vm.run_nondet")


def scan_nondet(source: str, label: str) -> list[dict]:
    """Every reference to GenLayer's non-deterministic surface."""
    tree = parse(source, label)
    if isinstance(tree, list):
        return tree
    out: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and root_name(node) == "gl":
            path = dotted(node)
            if any(path == r or path.startswith(r + ".") for r in NONDET_ROOTS):
                out.append(finding(label, node, "nondet", path))
    return out


# ── mode: payment ───────────────────────────────────────────────────────────

#: Value-moving surface. `gl.message.value` and balance reads are fine to *observe*;
#: what must not exist is a transfer, a balance mutation, or a payout decision.
PAYMENT_CALLS = (
    "transfer",
    "send_value",
    "send",
    "pay",
    "payout",
    "release",
    "release_funds",
    "withdraw",
    "deposit",
    "settle",
    "execute_settlement",
)
PAYMENT_GL_PATHS = ("gl.send_value", "gl.transfer", "gl.eth.send", "gl.balance.transfer")
PAYMENT_STATE = ("balance", "balances", "escrow", "treasury_balance", "funds", "payout")


def scan_payment(source: str, label: str) -> list[dict]:
    tree = parse(source, label)
    if isinstance(tree, list):
        return tree
    out: list[dict] = []
    for node in ast.walk(tree):
        # A public method whose name is a payment verb.
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            public = any(root_name(d.func if isinstance(d, ast.Call) else d) == "gl"
                         for d in node.decorator_list)
            if public and node.name.lstrip("_") in PAYMENT_CALLS:
                out.append(finding(label, node, "payment_function", f"@gl.public {node.name}"))
        # A call into GenLayer's value-transfer surface.
        elif isinstance(node, ast.Attribute):
            if root_name(node) == "gl" and dotted(node) in PAYMENT_GL_PATHS:
                out.append(finding(label, node, "payment_call", dotted(node)))
        # Storage that holds money.
        elif isinstance(node, ast.ClassDef):
            for statement in node.body:
                if isinstance(statement, ast.AnnAssign):
                    name = dotted(statement.target)
                    if name.split(".")[-1] in PAYMENT_STATE:
                        out.append(
                            finding(label, statement, "payment_state", f"{node.name}.{name}")
                        )
    return out


# ── mode: reputation ────────────────────────────────────────────────────────

REPUTATION_READS = ("reputation", "get_reputation", "reputation_of", "score_of", "standing")


def scan_reputation(source: str, label: str) -> list[dict]:
    """Any read of reputation. Invariant I9: it is never an adjudication input."""
    tree = parse(source, label)
    if isinstance(tree, list):
        return tree
    out: list[dict] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            target = node.func
            name = target.attr if isinstance(target, ast.Attribute) else (
                target.id if isinstance(target, ast.Name) else ""
            )
            if name in REPUTATION_READS:
                out.append(finding(label, node, "reputation_read", f"{dotted(target)}()"))
        elif isinstance(node, ast.Attribute) and node.attr in REPUTATION_READS:
            out.append(finding(label, node, "reputation_read", dotted(node)))
    return out


# ── controls ────────────────────────────────────────────────────────────────

NONDET_CONTROL = '''
# { "Depends": "py-genlayer:test" }
from genlayer import *


class Bad(gl.Contract):
    @gl.public.write
    def judge(self) -> str:
        def leader_fn():
            return gl.nondet.exec_prompt("good?")
        return gl.eq_principle.strict_eq(leader_fn)
'''

PAYMENT_CONTROL = '''
# { "Depends": "py-genlayer:test" }
from genlayer import *


class Bad(gl.Contract):
    balances: TreeMap[Address, u256]

    @gl.public.write
    def release(self, to: Address, amount: u256) -> None:
        gl.send_value(to, amount)
'''

REPUTATION_CONTROL = '''
from genlayer import *


class Bad(gl.Contract):
    @gl.public.view
    def decide(self, agent: str) -> int:
        rep = gl.get_contract_at(self.rep).view().get_reputation(agent)
        return rep
'''

CLEAN_CONTROL = '''
"""Prose that discusses gl.nondet.exec_prompt, gl.eq_principle.strict_eq, releasing
funds, transfer, balances: TreeMap[Address, u256] and get_reputation -- all of which
this module explains and none of which it does. A string literal too:
"gl.send_value(to, amount)".
"""

BP = 10000


def split(total: int, share: int) -> int:
    # gl.nondet.web.get and a transfer would both be illegal here, but a comment is
    # not code.
    return (total * share) // BP
'''


def require_control(scanner, source: str, name: str, kinds: tuple[str, ...]) -> None:
    hits = scanner(source, f"<{name}-control>")
    seen = {h["kind"] for h in hits}
    missing = [k for k in kinds if k not in seen]
    if missing:
        print(
            f"IC-DISCIPLINE BROKEN: the {name} positive control did not trip: "
            f"{', '.join(missing)}",
            file=sys.stderr,
        )
        print("  The check cannot be trusted until its own control fails.", file=sys.stderr)
        raise SystemExit(1)

    clean = scanner(CLEAN_CONTROL, "<clean-control>")
    if clean:
        print(
            f"IC-DISCIPLINE BROKEN: the {name} scanner fired on prose: "
            f"{[c['detail'] for c in clean]}",
            file=sys.stderr,
        )
        raise SystemExit(1)


def resolve_targets(args: list[str], default: tuple[str, ...]) -> list[Path]:
    explicit = [a for a in args if not a.startswith("--")]
    if "--only" in args:
        index = args.index("--only")
        explicit = [a for a in args[index + 1 :] if not a.startswith("--")]
    names = explicit or [str(GENLAYER / c) for c in default]
    paths = []
    for name in names:
        path = Path(name)
        if not path.is_absolute():
            path = ROOT / name
        paths.append(path)
    return paths


def report(findings: list[dict], name: str, scanned: int, suffix: str = "") -> None:
    """Prints `<NAME> OK <n> file(s)` with the count MEASURED, never copied.

    A token carrying a literal count would stay green while the scanner silently stopped
    looking at a file -- which is the failure these checks exist to notice.
    """
    if findings:
        print(f"{name} FAILED ({len(findings)})", file=sys.stderr)
        for f in findings:
            print(f"  - {f['label']}:{f['line']}  {f['kind']}: {f['detail']}", file=sys.stderr)
        raise SystemExit(1)
    if scanned == 0:
        print(f"{name} FAILED: nothing was scanned, so a clean result means nothing", file=sys.stderr)
        raise SystemExit(1)
    print(f"{name} OK {scanned} file(s){suffix}")


# ── modes ───────────────────────────────────────────────────────────────────


def mode_nondet(args: list[str]) -> None:
    require_control(scan_nondet, NONDET_CONTROL, "nondet", ("nondet",))
    targets = resolve_targets(args, CONTRACTS)

    findings: list[dict] = []
    owner_has_nondet = False
    for path in targets:
        if not path.exists():
            findings.append({"label": str(path), "line": 0, "kind": "missing", "detail": "does not exist"})
            continue
        hits = scan_nondet(path.read_text(encoding="utf-8"), path.name)
        if path.name == NONDET_OWNER:
            # The adjudicator is where nondet belongs, and it must actually contain some:
            # an adjudicator with no non-deterministic block is not adjudicating.
            owner_has_nondet = bool([h for h in hits if h["kind"] == "nondet"])
            findings.extend(h for h in hits if h["kind"] != "nondet")
        else:
            findings.extend(hits)

    scanning_owner = any(p.name == NONDET_OWNER for p in targets)
    if scanning_owner and not owner_has_nondet:
        findings.append(
            {
                "label": NONDET_OWNER,
                "line": 0,
                "kind": "no_nondet_in_owner",
                "detail": "the adjudicator contains no non-deterministic block, so either it is "
                "not adjudicating or the judgment moved somewhere this check does not look",
            }
        )

    suffix = f", nondet confined to {NONDET_OWNER}" if owner_has_nondet else ""
    report(findings, "NONDET-ISOLATION", len(targets), suffix)


def mode_payment(args: list[str]) -> None:
    require_control(scan_payment, PAYMENT_CONTROL, "payment",
                    ("payment_function", "payment_call", "payment_state"))
    targets = resolve_targets(args, CONTRACTS)
    findings: list[dict] = []
    for path in targets:
        if not path.exists():
            findings.append({"label": str(path), "line": 0, "kind": "missing", "detail": "does not exist"})
            continue
        findings.extend(scan_payment(path.read_text(encoding="utf-8"), path.name))
    report(findings, "NO-PAYMENT-SURFACE", len(targets))


def mode_reputation(args: list[str]) -> None:
    require_control(scan_reputation, REPUTATION_CONTROL, "reputation", ("reputation_read",))
    # wrk_reputation.py owns reputation, so it is excluded from its own prohibition.
    default = tuple(c for c in CONTRACTS if c != "wrk_reputation.py")
    targets = resolve_targets(args, default)
    findings: list[dict] = []
    for path in targets:
        if not path.exists():
            findings.append({"label": str(path), "line": 0, "kind": "missing", "detail": "does not exist"})
            continue
        if path.name == "wrk_reputation.py":
            continue  # reading reputation is this contract's job
        findings.extend(scan_reputation(path.read_text(encoding="utf-8"), path.name))
    report(findings, "REPUTATION-ISOLATION", len(targets))


#: Every §96 responsibility, and which consolidated contract absorbed it
#: (docs/ARCHITECTURE.md §3.1). The consolidation reduced cross-contract calls; it did
#: not drop behaviour, and this is where that claim is checked rather than asserted.
RESPONSIBILITIES = {
    "wrk_registry.py": ("register_agent", "create_dao", "dao", "capabilit", "member"),
    "wrk_work.py": ("mission", "proposal", "mandate", "deliverable", "evidence"),
    "wrk_adjudicator.py": ("select", "adjudicat", "criteri"),
    "wrk_reputation.py": ("reputation",),
}


def mode_consolidation(args: list[str]) -> None:
    findings: list[dict] = []

    present = sorted(p.name for p in GENLAYER.glob("wrk_*.py"))
    if present != sorted(CONTRACTS):
        findings.append(
            {
                "label": "contracts/genlayer",
                "line": 0,
                "kind": "contract_set",
                "detail": f"expected exactly {sorted(CONTRACTS)}, found {present}",
            }
        )

    for name, markers in RESPONSIBILITIES.items():
        path = GENLAYER / name
        if not path.exists():
            findings.append({"label": name, "line": 0, "kind": "missing", "detail": "does not exist"})
            continue
        tree = parse(path.read_text(encoding="utf-8"), name)
        if isinstance(tree, list):
            findings.extend(tree)
            continue
        # Public method names only: a responsibility mentioned in a docstring is not a
        # responsibility the contract discharges.
        public = []
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and any(
                root_name(d.func if isinstance(d, ast.Call) else d) == "gl"
                for d in node.decorator_list
            ):
                public.append(node.name)
        joined = " ".join(public).lower()
        for marker in markers:
            if marker not in joined:
                findings.append(
                    {
                        "label": name,
                        "line": 0,
                        "kind": "dropped_responsibility",
                        "detail": f"no public method covers '{marker}'; §96 responsibility unaccounted for",
                    }
                )

    report(findings, "IC-CONSOLIDATION", len(CONTRACTS), " = exactly the four consolidated ICs")


MODES = {
    "nondet": mode_nondet,
    "payment": mode_payment,
    "reputation": mode_reputation,
    "consolidation": mode_consolidation,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in MODES:
        print(f"usage: verify-ic-discipline.py {{{'|'.join(MODES)}}} [FILE ...]", file=sys.stderr)
        raise SystemExit(2)
    MODES[sys.argv[1]](sys.argv[2:])


if __name__ == "__main__":
    main()
