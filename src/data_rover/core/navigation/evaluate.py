"""Pure navigation evaluator over (Metamodel, Model).

Read-only and session-free: relationship hops go through `model.indexes`
adjacency (never a model scan); property hops instead read the frontier
element's `element.properties` dict directly (an element-reference property
is not indexed as adjacency), so a property hop's cost is per-element, not
per-edge. Scopes filter with the shared search matchers, and type checks use
the Metamodel's cached descendant/ancestor sets — so one hop is O(edges
touching the frontier) or O(1) per property step, matching the read-layer
O(entity) rule.
Like routes/read.py, callers do NOT take the session write_mutex: reads race
benignly against in-memory mutation.

Enumeration is depth-first over SORTED element ids with per-expansion
dedup (parallel edges to the same endpoint yield one continuation), which
makes the chain order deterministic — that determinism is what lets the API
layer do stateless offset/limit paging by re-evaluating.

Two caps bound the work on 80 MB models: `max_visited` counts every edge
examined; `max_chains` bounds the collected output. Hitting either stops
enumeration and flags the result `truncated`.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.search.criteria import (
    AnyOfCriterion,
    PropertyCriterion,
    match_element,
)

from .schema import (
    FilterStep,
    NavigationDefinition,
    PathNavigation,
    PropertyStep,
    RelationshipStep,
    RowStart,
    Scope,
    ScriptStep,
    SetExpression,
    StepItem,
)

if TYPE_CHECKING:
    from ..script.embed import ScriptEvalContext


@dataclass(frozen=True)
class EvalLimits:
    max_visited: int = 100_000
    max_chains: int = 5_000


@dataclass(frozen=True)
class PropertyValue:
    """Terminal chain node for a SCALAR property step: when the stepped-on
    property is not element-typed, navigation ends AT the property's value(s)
    instead of hopping to another element. Wrapped (rather than carried raw)
    so a string value can never be mistaken for an element id by downstream
    consumers — every consumer discriminates with ``isinstance(node, str)``.
    Frozen (hashable) because chain nodes are deduped through dict keys."""

    value: str | int | float | bool


#: One position in a chain: an element id, or a terminal scalar value.
ChainNode = str | PropertyValue


@dataclass
class ChainResult:
    """Chains INCLUDE the start element at index 0 (see schema docstring).
    Every node is an element id except a possible trailing `PropertyValue`
    (a scalar property step is always terminal). `warnings` carries script-
    step degradations (pruned chains, dropped ids) generated during THIS
    evaluate call — missing-property prunes stay silent, unchanged."""

    step_types: list[str]
    chains: list[tuple[ChainNode, ...]]
    truncated: bool
    warnings: list[str] = field(default_factory=list)


@dataclass
class _Budget:
    max_visited: int
    visited: int = 0
    exhausted: bool = field(default=False)

    def spend(self, n: int) -> bool:
        """Charge n edge-examinations; False once the budget is gone."""
        self.visited += n
        if self.visited > self.max_visited:
            self.exhausted = True
        return not self.exhausted


def evaluate(
    metamodel: Metamodel,
    model: Model,
    defn: NavigationDefinition,
    limits: EvalLimits = EvalLimits(),
    *,
    row_elements: Sequence[str] | None = None,
    script: ScriptEvalContext | None = None,
) -> ChainResult:
    """Evaluate a ref-free definition (run `resolve_refs` first).

    `row_elements`, when given, binds any `RowStart` sentinel encountered
    (top-level or nested inside a `set_op` operand) to those element ids —
    table columns supply their row's element(s) here. A `RowStart` reached
    with no binding raises `ValueError` (see `RowStart`'s docstring).

    `script`, when given, backs any `ScriptStep` hop encountered (top-level
    or nested); its shared warnings channel is snapshotted at entry so the
    returned `ChainResult.warnings` carries only what THIS call generated."""
    budget = _Budget(max_visited=limits.max_visited)
    w0 = len(script.warnings) if script is not None else 0
    if isinstance(defn, SetExpression):
        members, truncated = _evaluate_set(
            metamodel,
            model,
            defn,
            limits,
            budget,
            row_elements=row_elements,
            script=script,
        )
        return ChainResult(
            step_types=[],
            chains=[(i,) for i in sorted(members)],
            truncated=truncated or budget.exhausted,
            warnings=list(script.warnings[w0:]) if script is not None else [],
        )
    start_ids = _start_ids(
        metamodel, model, defn, limits, budget, row_elements=row_elements, script=script
    )
    chains: list[tuple[ChainNode, ...]] = []
    truncated = False
    for start_id in start_ids:
        if _walk(
            metamodel,
            model,
            defn.steps,
            0,
            (start_id,),
            chains,
            limits,
            budget,
            defn.exclude_visited,
            script,
        ):
            truncated = True
            break
    return ChainResult(
        step_types=[
            s.relationship_type
            if isinstance(s, RelationshipStep)
            else s.property_name
            if isinstance(s, PropertyStep)
            else (s.comment or "script")  # ScriptStep: label per its own docstring
            for s in defn.steps
            if not isinstance(s, FilterStep)
        ],
        chains=chains,
        truncated=truncated or budget.exhausted,
        warnings=list(script.warnings[w0:]) if script is not None else [],
    )


def _start_ids(
    metamodel: Metamodel,
    model: Model,
    defn: PathNavigation,
    limits: EvalLimits,
    budget: _Budget,
    *,
    row_elements: Sequence[str] | None = None,
    script: ScriptEvalContext | None = None,
) -> list[str]:
    if isinstance(defn.start, RowStart):
        if row_elements is None:
            raise ValueError("navigation is row-rooted; no row element bound")
        return sorted(dict.fromkeys(row_elements))
    if isinstance(defn.start, SetExpression):
        members, truncated = _evaluate_set(
            metamodel,
            model,
            defn.start,
            limits,
            budget,
            row_elements=row_elements,
            script=script,
        )
        if truncated:
            budget.exhausted = True
        return sorted(members)
    return _scope_ids(metamodel, model, defn.start)


def _scope_ids(metamodel: Metamodel, model: Model, scope: Scope) -> list[str]:
    if scope.types:
        ids: set[str] = set()
        for type_name in scope.types:
            for concrete in metamodel.element_descendants(type_name):
                ids |= model.indexes.elements_by_type.get(concrete, set())
    else:
        ids = set(model.elements.keys())
    return sorted(i for i in ids if _matches_criteria(model, model.elements[i], scope))


def _match_nav_criterion(model: Model, element: Element, criterion) -> bool:
    """Navigation criterion match. Property criteria are EXISTENCE-GATED: the
    element must actually carry the property (except `exists`/`is_empty`, which
    handle absence explicitly). This intentionally diverges from the shared
    search matcher's coerce-missing-to-'' semantics — `core/search` is
    untouched, so `/model/search` stays byte-identical. An `any_of` group
    recurses HERE (not through the shared matcher) so each member is gated
    exactly as a top-level criterion would be; an empty group stays the
    shared no-op (matches everything)."""
    if isinstance(criterion, AnyOfCriterion):
        return not criterion.criteria or any(
            _match_nav_criterion(model, element, m) for m in criterion.criteria
        )
    if isinstance(criterion, PropertyCriterion) and criterion.op not in (
        "exists",
        "is_empty",
    ):
        if criterion.name not in element.properties:
            return False
    return match_element(model, element, criterion)


def _matches_criteria(model: Model, element: Element, scope: Scope) -> bool:
    return all(_match_nav_criterion(model, element, c) for c in scope.criteria)


def _matches_filter(model: Model, element: Element, step: FilterStep) -> bool:
    return all(_match_nav_criterion(model, element, c) for c in step.criteria)


def _matches_target_types(
    metamodel: Metamodel, element: Element, target_types: list[str]
) -> bool:
    if not target_types:
        return True
    return any(metamodel.is_element_subtype(element.type_name, t) for t in target_types)


def _hop(
    metamodel: Metamodel,
    model: Model,
    element_id: str,
    step: RelationshipStep,
    budget: _Budget,
) -> list[str]:
    idx = model.indexes
    if step.direction == "out":
        rel_ids = set(idx.outgoing_ids(element_id))
    elif step.direction == "in":
        rel_ids = set(idx.incoming_ids(element_id))
    else:  # either — union dedupes self-loops present in both directions
        rel_ids = set(idx.outgoing_ids(element_id)) | set(idx.incoming_ids(element_id))
    if not budget.spend(len(rel_ids)):
        return []
    nxt: set[str] = set()
    for rid in rel_ids:
        rel = model.relationships[rid]
        if not metamodel.is_relationship_subtype(rel.type_name, step.relationship_type):
            continue
        other = rel.target_id if rel.source_id == element_id else rel.source_id
        el = model.elements.get(other)
        if el is not None and _matches_target_types(metamodel, el, step.target_types):
            nxt.add(other)
    return sorted(nxt)


def _hop_property(
    metamodel: Metamodel,
    model: Model,
    element_id: str,
    step: PropertyStep,
    budget: _Budget,
) -> list[ChainNode]:
    """Continuations of a property hop. For an ELEMENT-typed effective property
    def, the element's `property_name` value(s) resolve to existing elements —
    gated on the def's datatype so a string that merely looks like an id must
    not navigate. For a SCALAR property the chain terminates AT the value(s):
    each scalar item becomes a `PropertyValue` terminal (list order preserved —
    it is the stored order, already deterministic), so the value is displayable
    downstream instead of the chain silently vanishing. Absent/unset/dangling
    cases still prune silently (never raise): navigation stays inspectable on
    odd models, mirroring FilterStep's existence-gating. Deliberately NOT
    checked: the RESOLVED element's own type against `prop.datatype` — a
    dangling-conformance id still navigates, since conformance is the
    validation pipeline's job, so the UI's frontier typing (frontierTypesAt)
    may be narrower than the actual frontier."""
    element = model.elements[element_id]
    prop = next(
        (
            p
            for p in metamodel.effective_element_properties(element.type_name)
            if p.name == step.property_name
        ),
        None,
    )
    if prop is None:
        return []
    value = element.properties.get(step.property_name)
    if value is None:
        return []
    candidates = value if isinstance(value, list) else [value]
    if not budget.spend(len(candidates)):
        return []
    if not metamodel.is_element_type(prop.datatype):
        return [
            PropertyValue(item)
            for item in candidates
            if isinstance(item, (str, int, float, bool))
        ]
    resolved: list[ChainNode] = []
    resolved.extend(
        sorted(
            item
            for item in set(candidates)
            if isinstance(item, str) and item in model.elements
        )
    )
    return resolved


def _hop_script(
    model: Model,
    element_id: str,
    step: ScriptStep,
    script: ScriptEvalContext | None,
    budget: _Budget,
) -> list[ChainNode]:
    """Continuations of a script hop: `step(el)` returns the next frontier's
    ids. DEGRADED, NEVER RAISING: a dangling ref, a per-element error, or an
    unknown returned id prunes/drops with a warning on the shared context; an
    unconfigured snippet or absent context prunes silently (mirroring an
    unconfigured navigation source). Dedup preserves the snippet's own return
    order — deterministic because guest output is deterministic."""
    if step.snippet.ref is not None:
        if script is not None:
            script.add_warning(
                f"script step: snippet artifact {step.snippet.ref!r} not found"
            )
        return []
    if step.snippet.definition is None or script is None:
        return []
    res = script.call(step.snippet.definition.code, "step", [element_id])
    if res.error is not None:
        script.add_warning(f"script step failed: {res.error.message}")
        return []
    assert res.value is not None
    raw = list(dict.fromkeys(res.value["ids"]))
    if not budget.spend(len(raw)):
        return []
    known = [i for i in raw if i in model.elements]
    if len(known) != len(raw):
        script.add_warning(
            f"script step returned {len(raw) - len(known)} unknown element id(s)"
        )
    return list(known)


def _walk(
    metamodel: Metamodel,
    model: Model,
    steps: Sequence[StepItem],
    item_idx: int,
    chain: tuple[ChainNode, ...],
    chains: list[tuple[ChainNode, ...]],
    limits: EvalLimits,
    budget: _Budget,
    exclude_visited: bool,
    script: ScriptEvalContext | None = None,
) -> bool:
    """DFS over the interleaved step-item list. A RelationshipStep or
    PropertyStep extends the chain by one hop (deterministic, sorted-id); a
    FilterStep keeps the chain iff its current endpoint matches all criteria,
    adding no column. Returns True when enumeration stopped early (chain cap or
    budget)."""
    if item_idx == len(steps):
        if len(chains) >= limits.max_chains:
            return True
        chains.append(chain)
        return False
    step = steps[item_idx]
    current = chain[-1]
    if not isinstance(current, str):
        # A PropertyValue is TERMINAL — the UI blocks adding steps past a
        # scalar property step, but a hand-written definition may still carry
        # them; such chains prune silently (same stance as absent properties).
        return False
    if isinstance(step, FilterStep):
        if _matches_filter(model, model.elements[current], step):
            return _walk(
                metamodel,
                model,
                steps,
                item_idx + 1,
                chain,
                chains,
                limits,
                budget,
                exclude_visited,
                script,
            )
        return False
    nxt: list[ChainNode]
    if isinstance(step, RelationshipStep):
        nxt = list(_hop(metamodel, model, current, step, budget))
    elif isinstance(step, PropertyStep):
        nxt = _hop_property(metamodel, model, current, step, budget)
    else:  # ScriptStep
        nxt = _hop_script(model, current, step, script, budget)
        if script is not None and exclude_visited:
            # The generic cycle guard below drops silently -- correct for
            # relationship hops (revisits are expected navigation semantics)
            # but a silent mystery for script steps, where an identity return
            # ("keep this element") is the natural idiom. Warn with a count.
            dropped = sum(1 for o in nxt if o in chain)
            if dropped:
                script.add_warning(
                    f"script step: {dropped} element(s) dropped "
                    "(already visited in this chain)"
                )
    if budget.exhausted:
        return True
    for other in nxt:
        if exclude_visited and other in chain:
            continue  # cycle guard: a chain never revisits its own elements
        if _walk(
            metamodel,
            model,
            steps,
            item_idx + 1,
            chain + (other,),
            chains,
            limits,
            budget,
            exclude_visited,
            script,
        ):
            return True
    return False


def _evaluate_set(
    metamodel: Metamodel,
    model: Model,
    expr: SetExpression,
    limits: EvalLimits,
    budget: _Budget,
    *,
    row_elements: Sequence[str] | None = None,
    script: ScriptEvalContext | None = None,
) -> tuple[set[str], bool]:
    """(member ids, any-operand-truncated). `difference` folds left-to-right
    over the operand list; the other ops are order-insensitive.

    Each operand's inner path is evaluated with a FRESH `_Budget` (see
    `_operand_members`) — limits are per-navigation, so one operand hitting
    `max_visited`/`max_chains` never starves a sibling operand's budget.
    Truncation on any operand still propagates into this call's return value
    (and from there into the outer `ChainResult.truncated`).

    `row_elements` passes through to every operand so a `RowStart` nested
    inside a set operand also binds (see `evaluate`). `script` likewise
    passes through so a `ScriptStep` nested inside a set operand's path can
    still hop and report warnings on the shared context."""
    truncated = False
    result: set[str] | None = None
    for operand in expr.operands:
        assert operand.definition is not None  # resolver inlined every ref
        members, op_truncated = _operand_members(
            metamodel,
            model,
            operand.definition,
            operand.step_index,
            limits,
            budget,
            row_elements=row_elements,
            script=script,
        )
        truncated = truncated or op_truncated
        if result is None:
            result = members
        elif expr.op == "union":
            result |= members
        elif expr.op == "intersection":
            result &= members
        elif expr.op == "difference":
            result -= members
        else:  # symmetric_difference
            result ^= members
    return result or set(), truncated


def _operand_members(
    metamodel: Metamodel,
    model: Model,
    defn: NavigationDefinition,
    step_index: int | None,
    limits: EvalLimits,
    budget: _Budget,
    *,
    row_elements: Sequence[str] | None = None,
    script: ScriptEvalContext | None = None,
) -> tuple[set[str], bool]:
    if isinstance(defn, SetExpression):
        # a set has no steps; any explicit index other than 0 is an error
        if step_index not in (None, 0):
            raise ValueError(f"step_index {step_index} out of range for a set operand")
        return _evaluate_set(
            metamodel,
            model,
            defn,
            limits,
            budget,
            row_elements=row_elements,
            script=script,
        )
    inner = evaluate(
        metamodel, model, defn, limits, row_elements=row_elements, script=script
    )
    n_steps = len(inner.step_types)
    index = n_steps if step_index is None else step_index
    if index > n_steps:
        raise ValueError(
            f"step_index {step_index} out of range: path has {n_steps} steps"
        )
    # Set members are ELEMENTS; a PropertyValue terminal at the projected step
    # contributes nothing (a scalar cannot participate in id-set algebra).
    return {
        node for chain in inner.chains if isinstance((node := chain[index]), str)
    }, inner.truncated
