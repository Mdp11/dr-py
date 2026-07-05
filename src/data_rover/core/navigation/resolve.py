"""Inline artifact references inside a NavigationDefinition.

`Operand.ref` names a stored `kind="navigation"` artifact. The evaluator is
deliberately ref-free (pure over the definition it is handed), so the API
layer resolves refs first via this module, injecting a `fetch` callable that
loads+parses an artifact's payload. Cycle detection is by the PATH of ids
being expanded (`_seen`): the same artifact may appear twice as a sibling
(diamond), but not on its own expansion path.
"""

from __future__ import annotations

from collections.abc import Callable

from .schema import (
    NavigationDefinition,
    Operand,
    PathNavigation,
    Scope,
    SetExpression,
)


class NavigationResolveError(Exception):
    def __init__(self, artifact_id: str, message: str) -> None:
        super().__init__(message)
        self.artifact_id = artifact_id


class RefNotFoundError(NavigationResolveError):
    def __init__(self, artifact_id: str) -> None:
        super().__init__(artifact_id, f"unknown navigation artifact {artifact_id!r}")


class RefCycleError(NavigationResolveError):
    def __init__(self, artifact_id: str) -> None:
        super().__init__(
            artifact_id, f"navigation reference cycle through {artifact_id!r}"
        )


Fetch = Callable[[str], NavigationDefinition]


def resolve_refs(
    defn: NavigationDefinition, fetch: Fetch, _seen: frozenset[str] = frozenset()
) -> NavigationDefinition:
    """A copy of `defn` with every `Operand.ref` replaced by its fetched,
    recursively-resolved definition. `fetch` raises LookupError for unknown
    ids. Never mutates its input."""
    if isinstance(defn, PathNavigation):
        if isinstance(defn.start, Scope):
            return defn
        return defn.model_copy(
            update={"start": _resolve_expr(defn.start, fetch, _seen)}
        )
    return _resolve_expr(defn, fetch, _seen)


def _resolve_expr(
    expr: SetExpression, fetch: Fetch, seen: frozenset[str]
) -> SetExpression:
    operands: list[Operand] = []
    for op in expr.operands:
        if op.ref is not None:
            if op.ref in seen:
                raise RefCycleError(op.ref)
            try:
                fetched = fetch(op.ref)
            except LookupError:
                raise RefNotFoundError(op.ref) from None
            inner = resolve_refs(fetched, fetch, seen | {op.ref})
            operands.append(
                Operand(definition=inner, step_index=op.step_index)
            )
        else:
            assert op.definition is not None  # schema: exactly one source
            inner = resolve_refs(op.definition, fetch, seen)
            operands.append(op.model_copy(update={"definition": inner}))
    return expr.model_copy(update={"operands": operands})
