"""Server-side lint for snippet code. Single source of truth so editor
diagnostics match the executor exactly (spec section 8).

Syntax errors block; unknown names, disallowed imports and bad entry-point
signatures are non-blocking warnings (Python scope analysis has honest false
positives — conditionally-defined names, comprehension scoping).
"""
from __future__ import annotations

import ast
import builtins
from dataclasses import dataclass
from typing import Literal

IMPORT_ALLOWLIST: frozenset[str] = frozenset(
    {"re", "math", "itertools", "collections", "functools", "json",
     "statistics", "datetime", "string"}
)
DR_NAMES: frozenset[str] = frozenset({"dr"})
_ENTRY_NAMES = ("value", "step")


@dataclass(frozen=True)
class Diagnostic:
    line: int
    col: int
    severity: Literal["error", "warning"]
    message: str


def _parse(code: str) -> tuple[ast.Module | None, Diagnostic | None]:
    try:
        return ast.parse(code), None
    except SyntaxError as e:
        return None, Diagnostic(e.lineno or 1, (e.offset or 1) - 1, "error", f"syntax error: {e.msg}")


def derive_entry_points(code: str) -> list[str]:
    tree, _ = _parse(code)
    if tree is None:
        return []
    eps = ["script"]
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _ENTRY_NAMES:
            if len(node.args.posonlyargs) + len(node.args.args) == 1:
                eps.append(node.name)
    # stable, de-duped
    return list(dict.fromkeys(eps))


def lint_code(code: str) -> list[Diagnostic]:
    tree, err = _parse(code)
    if err is not None:
        return [err]
    assert tree is not None
    diags: list[Diagnostic] = []

    # disallowed imports
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root not in IMPORT_ALLOWLIST:
                    diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                            f"module {root!r} is not available in the sandbox"))
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root not in IMPORT_ALLOWLIST:
                diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                        f"module {root!r} is not available in the sandbox"))

    # entry-point signature checks
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _ENTRY_NAMES:
            argc = len(node.args.posonlyargs) + len(node.args.args)
            if argc != 1:
                diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                        f"{node.name}() must take exactly one argument (the element), got {argc}"))

    # unknown-name resolution (module scope only; conservative)
    known = set(dir(builtins)) | set(DR_NAMES) | set(IMPORT_ALLOWLIST)
    _collect_bound_names(tree, known)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id not in known:
                diags.append(Diagnostic(node.lineno, node.col_offset, "warning",
                                        f"unknown name {node.id!r}"))
    return diags


def _collect_bound_names(tree: ast.Module, known: set[str]) -> None:
    """Add every name the module binds (defs, assignments, imports, comprehension
    targets, function args) so we don't flag legitimate locals. Deliberately
    over-approximates 'known' to keep unknown-name a low-false-positive warning."""
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            known.add(node.name)
        elif isinstance(node, ast.arg):
            known.add(node.arg)
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            known.add(node.id)
        elif isinstance(node, ast.alias):
            known.add((node.asname or node.name).split(".")[0])
        elif isinstance(node, ast.Global) or isinstance(node, ast.Nonlocal):
            known.update(node.names)
