"""G5: the library is pure, so every Intelligent Contract can safely import it.

Two claims, both checked by AST analysis rather than by grepping text:

1. **No GenLayer runtime surface.** Nothing under `lib/` imports `genlayer`, touches
   the `gl` namespace, declares GenVM storage, subclasses `gl.Contract`, or carries a
   `@gl.public` decorator. Every non-deterministic block lives in
   `wrk_adjudicator.py` (docs/ARCHITECTURE.md §3.1), which is what makes "which code
   can be non-deterministic" answerable by looking at one file.

2. **No undeclared non-determinism.** A consensus system cannot tolerate a library
   function that returns something different on each validator. `time.time()`,
   `os.urandom()` and -- less obviously -- Python's `hash()` of a string, which is
   salted per process, would each break consensus silently. The scanner reports every
   such call and the set must equal a declared allowlist, so an exception is a pinned
   visible fact rather than a thing someone noticed later.

Why AST and not grep: this library's own docstrings discuss `gl.nondet` at length,
because explaining the boundary is part of documenting it. A text scanner would fire
on the prose and have to be loosened until it stopped catching anything. An AST walk
sees code and is blind to comments and strings.

The gate carries its own proof. Before trusting a clean result it runs the same
scanner against a positive control that deliberately contains every violation, and
fails if the scanner stays quiet -- an absence check that has never fired proves
nothing.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _common import Checker, GENLAYER_ROOT  # noqa: E402

LIB_DIR = GENLAYER_ROOT / "lib"

#: GenVM storage type constructors. A class-body annotation using one of these is a
#: storage declaration.
STORAGE_TYPES = frozenset(
    {"DynArray", "TreeMap", "Address", "bigint"}
    | {f"u{bits}" for bits in (8, 16, 32, 64, 128, 256)}
    | {f"i{bits}" for bits in (8, 16, 32, 64, 128, 256)}
)

#: Calls whose result differs between processes or over time.
NONDETERMINISTIC_CALLS = {
    ("time", "time"),
    ("time", "time_ns"),
    ("time", "monotonic"),
    ("time", "perf_counter"),
    ("os", "urandom"),
    ("os", "getpid"),
    ("random", "random"),
    ("random", "randint"),
    ("random", "choice"),
    ("random", "shuffle"),
    ("random", "randrange"),
    ("secrets", "token_bytes"),
    ("secrets", "token_hex"),
    ("secrets", "randbelow"),
    ("uuid", "uuid1"),
    ("uuid", "uuid4"),
    ("datetime", "now"),
    ("datetime", "today"),
    ("datetime", "utcnow"),
}

#: Builtins that are non-deterministic across processes. `hash` is salted for str and
#: bytes, so hash("x") differs per run -- a trap that looks pure.
NONDETERMINISTIC_BUILTINS = frozenset({"hash", "id", "input", "open"})

#: The one place non-determinism is allowed, with its reason. `new_id` mints
#: identifiers for off-chain tooling and tests; its docstring states that calling it
#: inside a contract's deterministic path would break consensus.
ALLOWED_NONDETERMINISM = {("ids.py", "new_id")}


def _root_name(node: ast.AST) -> str | None:
    """The leftmost Name of an attribute chain: gl.nondet.web.get -> 'gl'."""
    while isinstance(node, ast.Attribute):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def _dotted(node: ast.AST) -> str:
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def _enclosing_function(tree: ast.AST, target: ast.AST) -> str:
    """Name of the innermost function containing `target`, or '<module>'."""
    best = "<module>"
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = getattr(node, "lineno", 0)
            end = getattr(node, "end_lineno", start)
            if start <= getattr(target, "lineno", -1) <= end:
                best = node.name
    return best


def scan_source(source: str, label: str) -> list[dict]:
    """Return every purity finding in one Python source string."""
    findings: list[dict] = []
    try:
        tree = ast.parse(source, filename=label)
    except SyntaxError as error:
        return [{"kind": "syntax", "file": label, "line": error.lineno or 0, "detail": str(error)}]

    def add(kind: str, node: ast.AST, detail: str) -> None:
        findings.append({"kind": kind, "file": label, "line": getattr(node, "lineno", 0), "detail": detail})

    for node in ast.walk(tree):
        # 1a. importing the GenLayer runtime
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "genlayer" or alias.name.startswith("genlayer."):
                    add("genlayer_import", node, f"import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if module == "genlayer" or module.startswith("genlayer."):
                add("genlayer_import", node, f"from {module} import ...")

        # 1b. any code reference to the gl namespace
        elif isinstance(node, ast.Attribute):
            if _root_name(node) == "gl":
                add("gl_reference", node, _dotted(node))

        # 1c. gl.Contract subclasses and @gl.public decorators
        elif isinstance(node, ast.ClassDef):
            for base in node.bases:
                if _root_name(base) == "gl":
                    add("gl_contract", node, f"class {node.name}({_dotted(base)})")
            for decorator in node.decorator_list:
                target = decorator.func if isinstance(decorator, ast.Call) else decorator
                if _root_name(target) == "gl":
                    add("gl_decorator", node, f"@{_dotted(target)} on class {node.name}")
            # 1d. storage declarations: annotated class-body fields using GenVM types
            for statement in node.body:
                if isinstance(statement, ast.AnnAssign):
                    annotation = statement.annotation
                    name = annotation.value if isinstance(annotation, ast.Subscript) else annotation
                    if isinstance(name, ast.Name) and name.id in STORAGE_TYPES:
                        add("storage_declaration", statement, f"{node.name}.{_dotted(statement.target)}: {name.id}")

        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for decorator in node.decorator_list:
                target = decorator.func if isinstance(decorator, ast.Call) else decorator
                if _root_name(target) == "gl":
                    add("gl_decorator", node, f"@{_dotted(target)} on {node.name}")

        # 2. non-determinism
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                root = _root_name(func)
                if (root, func.attr) in NONDETERMINISTIC_CALLS:
                    add("nondeterminism", node, f"{_dotted(func)}() in {_enclosing_function(tree, node)}")
            elif isinstance(func, ast.Name) and func.id in NONDETERMINISTIC_BUILTINS:
                add("nondeterminism", node, f"{func.id}() in {_enclosing_function(tree, node)}")

    return findings


POSITIVE_CONTROL = '''
# { "Depends": "py-genlayer:test" }
from genlayer import *
import random


class BadContract(gl.Contract):
    balances: TreeMap[Address, u256]
    history: DynArray[str]

    @gl.public.write
    def judge(self, url: str) -> None:
        def leader_fn():
            return gl.nondet.exec_prompt("is this good?")

        verdict = gl.eq_principle.strict_eq(leader_fn)
        self.history.append(verdict)
        self.balances[Address("0x0")] = u256(random.randint(0, 10))
        token = hash(url)
'''

CLEAN_CONTROL = '''
"""A docstring that talks about gl.nondet.exec_prompt and gl.eq_principle.strict_eq
and TreeMap[Address, u256] storage, none of which is code."""

BP = 10000


def split(total: int, share: int) -> int:
    # gl.nondet.web.get would be illegal here, but a comment is not code.
    return (total * share) // BP
'''


def main() -> None:
    checker = Checker()

    # ── the positive control must trip the scanner ───────────────────────────
    control = scan_source(POSITIVE_CONTROL, "<positive-control>")
    kinds = {finding["kind"] for finding in control}
    for expected in (
        "genlayer_import",
        "gl_reference",
        "gl_contract",
        "gl_decorator",
        "storage_declaration",
        "nondeterminism",
    ):
        checker.check(expected in kinds, f"positive control must trip the {expected} detector")
    checker.check(
        len(control) >= 8, f"positive control should produce many findings, produced {len(control)}"
    )

    # ── and the clean control must not, despite discussing all of it in prose ─
    clean = scan_source(CLEAN_CONTROL, "<clean-control>")
    checker.equal(
        [f"{f['kind']}:{f['detail']}" for f in clean],
        [],
        "the clean control must produce no findings -- prose about gl.nondet is not a violation",
    )

    # ── now the real library ─────────────────────────────────────────────────
    files = sorted(LIB_DIR.glob("*.py"))
    checker.check(len(files) >= 8, f"expected at least 8 library modules, found {len(files)}")

    nondeterminism: set[tuple[str, str]] = set()
    for path in files:
        findings = scan_source(path.read_text(encoding="utf-8"), path.name)
        for finding in findings:
            if finding["kind"] == "nondeterminism":
                function = finding["detail"].split(" in ")[-1]
                nondeterminism.add((path.name, function))
            else:
                checker.check(
                    False,
                    f"{path.name}:{finding['line']} {finding['kind']}: {finding['detail']}",
                )

    checker.equal(
        sorted(nondeterminism),
        sorted(ALLOWED_NONDETERMINISM),
        "non-determinism in lib/ must match the declared allowlist exactly",
    )

    # The library must also be importable without the GenLayer runtime present, which
    # is the practical form of "pure": these tests run under plain CPython.
    import importlib

    for module in (
        "lib",
        "lib.canonical",
        "lib.hashing",
        "lib.ids",
        "lib.keccak",
        "lib.money",
        "lib.prompts",
        "lib.states",
        "lib.types",
        "lib.validation",
    ):
        try:
            importlib.import_module(module)
        except Exception as error:  # noqa: BLE001
            checker.check(False, f"{module} must import without the GenLayer runtime: {error}")

    checker.finish("GENLIB-PURITY OK")


if __name__ == "__main__":
    main()
