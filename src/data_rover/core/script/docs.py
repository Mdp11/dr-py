"""Structured docs extracted from the facade source — the single source of truth.

`FACADE_SOURCE` is AST-parsed (never executed, mirroring `lint.py`'s stance)
into `FacadeDocEntry` rows. Docstrings live ON the facade members, so the
reference the UI shows cannot drift from the API snippets actually get: the
tripwire below makes an undocumented public member a hard failure, which
means adding a facade method forces writing its docs in the same commit.

Stays `data_rover.core.*`-pure: stdlib only, no api/wasmtime imports.
"""

from __future__ import annotations

import ast
import textwrap
from dataclasses import dataclass
from functools import lru_cache

from data_rover.core.script.facade_src import FACADE_SOURCE

#: Return-type suffixes for members where the return matters. The facade
#: source carries no annotations (it must stay plain guest-side Python), so
#: this map is the one hand-maintained piece — keyed by PUBLIC name, checked
#: against extraction by the test suite.
_RETURNS: dict[str, str] = {
    "dr.element": "Element",
    "dr.elements": "iterator of Element",
    "dr.types": "list[str]",
    "dr.type": "dict",
    "dr.create": "str (temp id)",
    "dr.connect": "str (temp id)",
    "Element.id": "str",
    "Element.type": "str",
    "Element.name": "str",
    "Element.get": "value or default",
    "Element.props": "dict",
    "Element.out": "list[dict]",
    "Element.in_": "list[dict]",
    "Element.parent": "Element | None",
    "Element.children": "list[Element]",
}


@dataclass(frozen=True)
class FacadeDocEntry:
    """One documented public facade member."""

    name: str
    kind: str  # "function" | "method" | "property" | "exception"
    signature: str
    doc: str
    example: str | None


def _split_doc(raw: str | None, name: str) -> tuple[str, str | None]:
    """Split a docstring into (doc, example) on the `Example:` marker.

    Raises ValueError naming the member when the summary is missing — the
    drift tripwire this module exists for.
    """
    if raw is None or not raw.strip():
        raise ValueError(f"facade member {name!r} lacks a docstring")
    doc_part, sep, example_part = raw.partition("Example:")
    doc = textwrap.dedent(doc_part).strip()
    if not doc:
        raise ValueError(f"facade member {name!r} has an Example but no summary")
    example = textwrap.dedent(example_part).strip() if sep else None
    return doc, example or None


def _signature(public_name: str, fn: ast.FunctionDef, *, drop_self: bool) -> str:
    pos = list(fn.args.posonlyargs) + list(fn.args.args)
    if drop_self and pos and pos[0].arg == "self":
        pos = pos[1:]
    defaults = list(fn.args.defaults)
    pad = len(pos) - len(defaults)
    params = [
        f"{a.arg}={ast.unparse(defaults[i - pad])}" if i >= pad else a.arg
        for i, a in enumerate(pos)
    ]
    sig = f"{public_name}({', '.join(params)})"
    ret = _RETURNS.get(public_name)
    return f"{sig} -> {ret}" if ret else sig


def _entry(name: str, kind: str, signature: str, raw_doc: str | None) -> FacadeDocEntry:
    doc, example = _split_doc(raw_doc, name)
    return FacadeDocEntry(
        name=name, kind=kind, signature=signature, doc=doc, example=example
    )


@lru_cache(maxsize=1)
def get_facade_docs() -> tuple[FacadeDocEntry, ...]:
    """Parse `FACADE_SOURCE` into the public doc model. Cached — the source
    is a static string."""
    tree = ast.parse(FACADE_SOURCE)
    module_fns = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}

    entries: list[FacadeDocEntry] = []

    # dr.* members come from the _Dr class body: `name = staticmethod(_fn)`
    # maps a public name to a module function; `Name = ExcName` aliases an
    # exception class.
    for stmt in classes["_Dr"].body:
        if not (
            isinstance(stmt, ast.Assign)
            and len(stmt.targets) == 1
            and isinstance(stmt.targets[0], ast.Name)
        ):
            continue
        public = f"dr.{stmt.targets[0].id}"
        value = stmt.value
        if (
            isinstance(value, ast.Call)
            and isinstance(value.func, ast.Name)
            and value.func.id == "staticmethod"
            and isinstance(value.args[0], ast.Name)
        ):
            fn = module_fns[value.args[0].id]
            entries.append(
                _entry(
                    public,
                    "function",
                    _signature(public, fn, drop_self=False),
                    ast.get_docstring(fn),
                )
            )
        elif isinstance(value, ast.Name) and value.id in classes:
            entries.append(
                _entry(
                    public, "exception", public, ast.get_docstring(classes[value.id])
                )
            )

    # Element members: public methods and properties; dunders skipped
    # (`__getitem__` is documented under `get`).
    for stmt in classes["Element"].body:
        if not isinstance(stmt, ast.FunctionDef) or stmt.name.startswith("_"):
            continue
        public = f"Element.{stmt.name}"
        is_property = any(
            isinstance(d, ast.Name) and d.id == "property" for d in stmt.decorator_list
        )
        if is_property:
            ret = _RETURNS.get(public)
            sig = f"{public} -> {ret}" if ret else public
            entries.append(_entry(public, "property", sig, ast.get_docstring(stmt)))
        else:
            entries.append(
                _entry(
                    public,
                    "method",
                    _signature(public, stmt, drop_self=True),
                    ast.get_docstring(stmt),
                )
            )

    return tuple(entries)
