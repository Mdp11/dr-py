"""Inline artifact references inside a NavigationDefinition.

`Operand.ref` names a stored `kind="navigation"` artifact. The evaluator is
deliberately ref-free (pure over the definition it is handed), so the API
layer resolves refs first via this module, injecting a `fetch` callable that
loads+parses an artifact's payload. Cycle detection is by the PATH of ids
being expanded (`_seen`): the same artifact may appear twice as a sibling
(diamond), but not on its own expansion path.

`ScriptStep.snippet.ref` is resolved here too, via a second, independently
injected `snippet_fetch` callable — but with the OPPOSITE failure stance from
navigation refs. A dangling `Operand.ref` makes the whole definition
unevaluable (`RefNotFoundError`, 422 at the API layer): a navigation with a
step missing is nonsense. A dangling `ScriptStep.snippet.ref`, by contrast, is
left in place as a DANGLING MARKER and never raises here — the evaluator
(Task 9) prunes that one chain step with a warning instead, matching the
degraded-content stance PropertyStep already takes for a missing property def.
`snippet_fetch` is optional (defaults to `None`) so callers that never resolve
navigations carrying script steps (none exist yet pre-Task-9/11) don't need
to thread a snippet fetcher through.
"""

from __future__ import annotations

from collections.abc import Callable

from data_rover.core.script.schema import SnippetDefinition, SnippetSource

from .schema import (
    NavigationDefinition,
    Operand,
    PathNavigation,
    RowStart,
    Scope,
    ScriptStep,
    SetExpression,
    StepItem,
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
SnippetFetch = Callable[[str], SnippetDefinition]


def _resolve_script_step(
    step: StepItem, snippet_fetch: SnippetFetch | None
) -> StepItem:
    """Inline a ScriptStep's snippet ref. A LookupError leaves the ref in
    place as a DANGLING MARKER — evaluation prunes that step with a warning
    instead of the request 422ing (degraded-content stance; unlike navigation
    refs, whose absence makes the whole definition unevaluable)."""
    if (
        not isinstance(step, ScriptStep)
        or step.snippet.ref is None
        or snippet_fetch is None
    ):
        return step
    try:
        sd = snippet_fetch(step.snippet.ref)
    except LookupError:
        return step
    return step.model_copy(update={"snippet": SnippetSource(definition=sd)})


def resolve_refs(
    defn: NavigationDefinition,
    fetch: Fetch,
    _seen: frozenset[str] = frozenset(),
    *,
    snippet_fetch: SnippetFetch | None = None,
) -> NavigationDefinition:
    """A copy of `defn` with every `Operand.ref` replaced by its fetched,
    recursively-resolved definition, and every `ScriptStep.snippet.ref`
    inlined via `snippet_fetch` (dangling snippet refs stay in place — see
    module docstring). `fetch` raises LookupError for unknown ids. Never
    mutates its input."""
    if isinstance(defn, PathNavigation):
        steps = [_resolve_script_step(s, snippet_fetch) for s in defn.steps]
        if isinstance(defn.start, (Scope, RowStart)):
            return defn.model_copy(update={"steps": steps})
        return defn.model_copy(
            update={
                "start": _resolve_expr(defn.start, fetch, _seen, snippet_fetch),
                "steps": steps,
            }
        )
    return _resolve_expr(defn, fetch, _seen, snippet_fetch)


def _resolve_expr(
    expr: SetExpression,
    fetch: Fetch,
    seen: frozenset[str],
    snippet_fetch: SnippetFetch | None,
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
            inner = resolve_refs(
                fetched, fetch, seen | {op.ref}, snippet_fetch=snippet_fetch
            )
            operands.append(Operand(definition=inner, step_index=op.step_index))
        else:
            assert op.definition is not None  # schema: exactly one source
            inner = resolve_refs(
                op.definition, fetch, seen, snippet_fetch=snippet_fetch
            )
            operands.append(op.model_copy(update={"definition": inner}))
    return expr.model_copy(update={"operands": operands})


def navigation_has_script(defn: NavigationDefinition) -> bool:
    """True when evaluating `defn` may invoke a snippet (a ScriptStep with a
    non-empty snippet anywhere in the tree) — the route layer's cue to open a
    ScriptEvalContext and take a concurrency slot."""
    if isinstance(defn, PathNavigation):
        if any(
            isinstance(s, ScriptStep) and not s.snippet.is_empty for s in defn.steps
        ):
            return True
        if isinstance(defn.start, SetExpression):
            return _set_has_script(defn.start)
        return False
    return _set_has_script(defn)


def _set_has_script(expr: SetExpression) -> bool:
    return any(
        op.definition is not None and navigation_has_script(op.definition)
        for op in expr.operands
    )
