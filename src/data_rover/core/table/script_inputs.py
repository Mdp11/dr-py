"""Resolve a script column's named inputs for one row, and the ONE wrapper
every `value()` call site goes through.

An input resolves to exactly what the referenced column's cell holds for the
row — elements for an element-producing column, scalars for a property or
scalar-script column, this row's single binding for an expand column — as
the tagged wire shape the guest turns into `inputs[name]` (always a list).
Display caps (`cell_cap`/`max_cell_elements`, `truncated`) do not apply: an
input carries the complete set the referenced column holds, never a
UI-truncated view of it.

A pending or errored input never reaches the guest: `evaluate_script_column`
returns a synthetic result instead, which — because it never goes through
`ScriptEvalContext.call` — is neither memoized nor cell-cached, so the column
self-heals the moment the input computes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.navigation.evaluate import PropertyValue
from data_rover.core.script.runner import (
    CallResult,
    ElementsInput,
    ScalarsInput,
    ScriptError,
    WireInput,
)

from .evaluate import (
    RowKey,
    TableLimits,
    _expand_slot_of,
    _navigation_reached,
    resolve_source_elements,
)
from .nav_memo import NavMemo
from .schema import Column, PropertyColumn, ScriptColumn, ScriptInput, TableDefinition

if TYPE_CHECKING:
    from data_rover.core.script.embed import ScriptEvalContext


@dataclass(frozen=True)
class InputFailure:
    name: str
    kind: Literal["pending", "error"]
    message: str
    traceback: str | None = None


ResolvedInputs = dict[str, WireInput]


def _elements(ids: list[str]) -> ElementsInput:
    return {"kind": "elements", "ids": ids}


def _scalars(values: list[object]) -> ScalarsInput:
    return {"kind": "scalars", "values": values}


#: The two "script column can't produce anything" messages, shared verbatim
#: between an input's failure (`_script_result`) and the cell's own render
#: (`cells._script_cell`) so the two can never drift apart.
RUNNER_UNAVAILABLE_MESSAGE = "script runner unavailable"


def dangling_ref_message(ref: str) -> str:
    return f"snippet artifact {ref!r} not found"


def navigation_display_values(
    model: Model, reached: list[str | PropertyValue]
) -> list[object]:
    """Render a value-projected navigation frontier for display: a
    `PropertyValue` terminal contributes its value; an element node (a mixed
    frontier — the same property scalar on one type, element-typed on
    another) degrades to its display name so nothing silently drops. Shared
    between a navigation input and `cells._navigation_cell` so an input's
    values and the rendered cell cannot drift."""
    return [
        n.value if isinstance(n, PropertyValue) else display_name(model.elements[n])
        for n in reached
    ]


def property_input_values(
    mm: Metamodel, model: Model, col: PropertyColumn, els: list[str]
) -> list[object]:
    """The values a COLLAPSE property column holds over `els`: list values
    flattened, None skipped, elements whose type lacks the property
    contributing nothing. Shared with `cells._property_cell` so an input and
    the rendered cell cannot drift."""
    vals: list[object] = []
    for eid in els:
        el = model.elements[eid]
        if not any(
            pd.name == col.name for pd in mm.effective_element_properties(el.type_name)
        ):
            continue
        v = el.properties.get(col.name)
        if isinstance(v, (list, tuple)):
            vals.extend(v)
        elif v is not None:
            vals.append(v)
    return vals


def failure_result(f: InputFailure) -> CallResult:
    kind: Literal["pending", "runtime"] = (
        "pending" if f.kind == "pending" else "runtime"
    )
    return CallResult(
        value=None,
        error=ScriptError(
            kind=kind, message=f"input {f.name!r}: {f.message}", traceback=f.traceback
        ),
        duration_ms=0,
    )


def resolve_script_inputs(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None = None,
) -> ResolvedInputs | InputFailure | None:
    """`None` when the column declares no inputs (one-arg `value()`); the
    first failing input otherwise, in declaration order."""
    if not col.inputs:
        return None
    out: ResolvedInputs = {}
    for inp in col.inputs:
        r = _resolve_one(mm, model, defn, key, inp, base_slots, limits, script, memo)
        if isinstance(r, InputFailure):
            return r
        out[inp.name] = r
    return out


def _resolve_one(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    inp: ScriptInput,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None,
) -> WireInput | InputFailure:
    ref_col = defn.columns[inp.ref.index]
    if inp.ref.step_index is not None:
        # navigation ref at a chain step: element-producing by contract
        return _elements(
            resolve_source_elements(
                mm,
                model,
                defn,
                key,
                inp.ref,
                base_slots,
                limits,
                script=script,
                memo=memo,
            )
        )
    if getattr(ref_col, "mode", "collapse") == "expand":
        return _resolve_expand_input(
            mm, model, defn, key, inp, ref_col, base_slots, limits, script, memo
        )
    roots = resolve_source_elements(
        mm,
        model,
        defn,
        key,
        ref_col.source,
        base_slots,
        limits,
        script=script,
        memo=memo,
    )
    if isinstance(ref_col, PropertyColumn):
        return _scalars(property_input_values(mm, model, ref_col, roots))
    if ref_col.kind == "element":
        return _elements(roots)
    if ref_col.kind == "navigation":
        reached = _navigation_reached(
            mm, model, ref_col, roots, limits, script=script, memo=memo
        )
        if any(isinstance(n, PropertyValue) for n in reached):
            # value-projected navigation: the cell shows VALUES (mixed
            # frontiers degrade element nodes to display names, as the cell does)
            return _scalars(navigation_display_values(model, reached))
        return _elements([n for n in reached if isinstance(n, str)])
    assert isinstance(ref_col, ScriptColumn)
    res = _script_result(
        mm, model, defn, key, ref_col, roots, base_slots, limits, script, memo
    )
    if res.error is not None:
        return _failure(inp.name, res)
    p = res.value
    assert p is not None
    if p["kind"] == "scalar":
        return _scalars([] if p["value"] is None else [p["value"]])
    if p["kind"] == "scalars":
        return _scalars(list(p["values"]))
    if p["kind"] == "element":
        return _elements([p["id"]] if p["id"] in model.elements else [])
    return _elements([i for i in dict.fromkeys(p["ids"]) if i in model.elements])


def _resolve_expand_input(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    inp: ScriptInput,
    ref_col: Column,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None,
) -> WireInput | InputFailure:
    b = key[_expand_slot_of(defn, base_slots, inp.ref.index)]
    if isinstance(ref_col, PropertyColumn):
        # An expand PROPERTY column's slot carries the raw value (never a
        # PropertyValue wrapper — see evaluate.py's Binding docstring), so a
        # string tag value must not be mistaken for an element id here.
        return _scalars([] if b is None else [b])
    if isinstance(b, str):
        return _elements([b])
    if isinstance(b, PropertyValue):
        return _scalars([b.value])
    if isinstance(ref_col, ScriptColumn):
        # None slot: keep_empty row OR an errored/pending cell — the
        # cache-only re-derive tells them apart (mirrors cells._script_cell).
        roots = resolve_source_elements(
            mm,
            model,
            defn,
            key,
            ref_col.source,
            base_slots,
            limits,
            script=script,
            memo=memo,
        )
        res = _script_result(
            mm,
            model,
            defn,
            key,
            ref_col,
            roots,
            base_slots,
            limits,
            script,
            memo,
            cache_only=True,
        )
        if res.error is not None:
            return _failure(inp.name, res)
    return _scalars([])


def _failure(name: str, res: CallResult) -> InputFailure:
    assert res.error is not None
    kind: Literal["pending", "error"] = (
        "pending" if res.error.kind == "pending" else "error"
    )
    return InputFailure(name, kind, res.error.message, res.error.traceback)


def _script_result(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    roots: list[str],
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None,
    *,
    cache_only: bool | None = None,
) -> CallResult:
    """A script column's raw call result for one row, dangling-ref,
    unconfigured, no-roots and unavailable-runner cases all handled here —
    ahead of the actual call — so an input's failure shape matches the
    cell's regardless of the order a caller happens to check things in."""
    if col.snippet.ref is not None:
        return CallResult(
            value=None,
            error=ScriptError(
                kind="runtime",
                message=dangling_ref_message(col.snippet.ref),
            ),
            duration_ms=0,
        )
    if col.snippet.definition is None or not roots:
        return CallResult(
            value={"kind": "scalars", "values": []}, error=None, duration_ms=0
        )
    if script is None:
        return CallResult(
            value=None,
            error=ScriptError(kind="unavailable", message=RUNNER_UNAVAILABLE_MESSAGE),
            duration_ms=0,
        )
    return evaluate_script_column(
        mm,
        model,
        defn,
        key,
        col,
        roots,
        base_slots,
        limits,
        script,
        memo,
        cache_only=cache_only,
    )


def evaluate_script_column(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    roots: list[str],
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext,
    memo: NavMemo | None = None,
    *,
    cache_only: bool | None = None,
) -> CallResult:
    """THE `value()` call site for a script column: resolves the column's
    inputs, then calls through the context. Callers have already handled the
    dangling-ref / unconfigured / no-roots cases the way their cell renders."""
    assert col.snippet.definition is not None
    code = col.snippet.definition.code
    arity = script.value_arity(code)
    n = len(col.inputs)
    if arity == 1 and n:
        return _arity_error(
            f"value() takes 1 argument but column declares {n} input{'s' if n != 1 else ''}"
        )
    if arity == 2 and not n:
        return _arity_error("value() takes 2 arguments but column declares no inputs")
    inputs = resolve_script_inputs(
        mm, model, defn, key, col, base_slots, limits, script, memo
    )
    if isinstance(inputs, InputFailure):
        return failure_result(inputs)
    return script.call(code, "value", roots, inputs=inputs, cache_only=cache_only)


def _arity_error(message: str) -> CallResult:
    return CallResult(
        value=None, error=ScriptError(kind="runtime", message=message), duration_ms=0
    )
