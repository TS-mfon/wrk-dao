"""Build a single-file GenVM artifact from a WRK contract and its pure local libs.

The pinned multi-file source remains authoritative. This deploy artifact preserves its
implementation while inlining local modules for the single-file GenLayer RPC upload API.
"""

from __future__ import annotations

import argparse
import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CONTRACTS = {
    "registry": ("wrk_registry.py", "WrkRegistry"),
    "work": ("wrk_work.py", "WrkWork"),
    "adjudicator": ("wrk_adjudicator.py", "WrkAdjudicator"),
    "reputation": ("wrk_reputation.py", "WrkReputation"),
}
RUNNER = "# { \"Depends\": \"py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6\" }"


def flatten(entry: Path) -> str:
    entry_text = entry.read_text()
    module_paths = {entry.stem: entry, **{f"lib.{p.stem}": p for p in (ROOT / "lib").glob("*.py") if p.name != "__init__.py"}}
    parsed: dict[str, tuple[Path, str, ast.Module]] = {}
    for module, path in module_paths.items():
        text = path.read_text()
        parsed[module] = (path, text, ast.parse(text, filename=str(path)))

    def local_module(node: ast.ImportFrom, current: str) -> str | None:
        if node.level:
            parent = current.rpartition(".")[0]
            target = f"{parent}.{node.module}" if node.module else parent
            return target if target in parsed else None
        target = node.module or ""
        return target if target in parsed else None

    definitions: dict[str, dict[str, ast.stmt]] = {}
    local_imports: dict[str, dict[str, tuple[str, str]]] = {}
    import_nodes: dict[str, list[ast.stmt]] = {}
    for module, (_, _, tree) in parsed.items():
        definitions[module] = {}
        local_imports[module] = {}
        import_nodes[module] = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                definitions[module][node.name] = node
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    for child in ast.walk(target):
                        if isinstance(child, ast.Name):
                            definitions[module][child.id] = node
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                import_nodes[module].append(node)
                if isinstance(node, ast.ImportFrom):
                    target_module = local_module(node, module)
                    if target_module:
                        for alias in node.names:
                            local_imports[module][alias.asname or alias.name] = (target_module, alias.name)

    selected: dict[str, set[int]] = {module: set() for module in parsed}
    pending: list[tuple[str, str]] = []
    for node in import_nodes[entry.stem]:
        if isinstance(node, ast.ImportFrom):
            target_module = local_module(node, entry.stem)
            if target_module:
                pending.extend((target_module, alias.name) for alias in node.names)

    # The contract module itself is included in full except imports and its docstring.
    for node in parsed[entry.stem][2].body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)) and not (
            node is parsed[entry.stem][2].body[0] and isinstance(node, ast.Expr)
            and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
        ):
            selected[entry.stem].add(id(node))

    while pending:
        module, symbol = pending.pop()
        node = definitions.get(module, {}).get(symbol)
        if node is None or id(node) in selected[module]:
            continue
        selected[module].add(id(node))
        used = {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
        for name in used:
            target = local_imports[module].get(name)
            if target:
                pending.append(target)
            elif name in definitions[module]:
                pending.append((module, name))

    # Keep only standard/GenLayer imports referenced by the selected declarations.
    external_imports: list[str] = []
    for module, (_, _, tree) in parsed.items():
        used: set[str] = set()
        for node in tree.body:
            if id(node) in selected[module]:
                used.update(item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load))
        for node in import_nodes[module]:
            if isinstance(node, ast.ImportFrom) and node.module == "__future__":
                continue
            if isinstance(node, ast.ImportFrom) and local_module(node, module):
                continue
            if isinstance(node, ast.Import):
                aliases = [alias for alias in node.names if (alias.asname or alias.name.split(".")[0]) in used]
                if aliases:
                    external_imports.append(ast.unparse(ast.Import(names=aliases)))
            elif isinstance(node, ast.ImportFrom):
                aliases = [alias for alias in node.names if alias.name == "*" or (alias.asname or alias.name) in used]
                if aliases:
                    external_imports.append(ast.unparse(ast.ImportFrom(module=node.module, names=aliases, level=node.level)))

    module_order: list[str] = []
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(module: str) -> None:
        if module in visited or module == entry.stem:
            return
        if module in visiting:
            raise ValueError(f"circular local import involving {module}")
        visiting.add(module)
        for name in selected[module]:
            node = next(node for node in parsed[module][2].body if id(node) == name)
            used = {item.id for item in ast.walk(node) if isinstance(item, ast.Name) and isinstance(item.ctx, ast.Load)}
            for alias, (target_module, _) in local_imports[module].items():
                if alias in used:
                    visit(target_module)
            for referenced in used:
                if referenced in definitions[module] and id(definitions[module][referenced]) in selected[module]:
                    # Dependencies within one module are emitted in their original order.
                    pass
        visiting.remove(module)
        visited.add(module)
        module_order.append(module)

    for module in parsed:
        if selected[module]:
            visit(module)
    module_order.append(entry.stem)

    result = [RUNNER]
    result.extend(dict.fromkeys(external_imports))
    for module in module_order:
        path, text, tree = parsed[module]
        selected_ids = selected[module]
        lines = text.splitlines()
        for node in tree.body:
            if id(node) not in selected_ids:
                start = min([node.lineno, *(decorator.lineno for decorator in getattr(node, "decorator_list", []))])
                for line_no in range(start, node.end_lineno + 1):
                    lines[line_no - 1] = ""
        result.extend(["", f"# Inlined from {path.relative_to(ROOT).as_posix()}", *lines])
    return "\n".join(result).rstrip() + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("contract", choices=CONTRACTS)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    entry_name, _ = CONTRACTS[args.contract]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(flatten(ROOT / entry_name))
