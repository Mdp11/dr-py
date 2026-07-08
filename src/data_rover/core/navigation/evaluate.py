"""Pure navigation evaluator over (Metamodel, Model).

Read-only and session-free: hops go through `model.indexes` adjacency (never
a model scan), scopes filter with the shared search matchers, and type checks
use the Metamodel's cached descendant/ancestor sets — so one hop is
O(edges touching the frontier), matching the read-layer O(entity) rule.
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

from dataclasses import dataclass, field

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.search.criteria import match_element

from .schema import (
    NavigationDefinition,
    PathNavigation,
    Scope,
    SetExpression,
    Step,
)


@dataclass(frozen=True)
class EvalLimits:
    max_visited: int = 100_000
    max_chains: int = 5_000


@dataclass
class ChainResult:
    """Chains INCLUDE the start element at index 0 (see schema docstring)."""

    step_types: list[str]
    chains: list[tuple[str, ...]]
    truncated: bool


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
) -> ChainResult:
    """Evaluate a ref-free definition (run `resolve_refs` first)."""
    budget = _Budget(max_visited=limits.max_visited)
    if isinstance(defn, SetExpression):
        members, truncated = _evaluate_set(metamodel, model, defn, limits, budget)
        return ChainResult(
            step_types=[],
            chains=[(i,) for i in sorted(members)],
            truncated=truncated or budget.exhausted,
        )
    start_ids = _start_ids(metamodel, model, defn, limits, budget)
    chains: list[tuple[str, ...]] = []
    truncated = _walk(
        metamodel, model, defn.steps, start_ids, (), chains, limits, budget,
        defn.exclude_visited,
    )
    return ChainResult(
        step_types=[s.relationship_type for s in defn.steps],
        chains=chains,
        truncated=truncated or budget.exhausted,
    )


def _start_ids(
    metamodel: Metamodel,
    model: Model,
    defn: PathNavigation,
    limits: EvalLimits,
    budget: _Budget,
) -> list[str]:
    if isinstance(defn.start, SetExpression):
        members, truncated = _evaluate_set(metamodel, model, defn.start, limits, budget)
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


def _matches_criteria(model: Model, element: Element, scope: Scope) -> bool:
    return all(match_element(model, element, c) for c in scope.criteria)


def _matches_target(
    metamodel: Metamodel, model: Model, element: Element, scope: Scope
) -> bool:
    if scope.types and not any(
        metamodel.is_element_subtype(element.type_name, t) for t in scope.types
    ):
        return False
    return _matches_criteria(model, element, scope)


def _next_ids(
    metamodel: Metamodel,
    model: Model,
    element_id: str,
    step: Step,
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
        if el is not None and _matches_target(metamodel, model, el, step.target):
            nxt.add(other)
    return sorted(nxt)


def _walk(
    metamodel: Metamodel,
    model: Model,
    steps: list[Step],
    frontier: list[str],
    prefix: tuple[str, ...],
    chains: list[tuple[str, ...]],
    limits: EvalLimits,
    budget: _Budget,
    exclude_visited: bool,
) -> bool:
    """DFS continuation; returns True when enumeration stopped early.

    `exclude_visited` is per-navigation (`PathNavigation.exclude_visited`):
    when True, a chain never revisits its own elements (the historical,
    still-default behavior); when False, revisits are allowed and
    termination still holds because chain length is capped at
    `len(steps) + 1` regardless."""
    for element_id in frontier:
        if exclude_visited and element_id in prefix:
            continue  # cycle guard: a chain never revisits its own elements
        chain = prefix + (element_id,)
        if len(chain) == len(steps) + 1:
            if len(chains) >= limits.max_chains:
                return True
            chains.append(chain)
            continue
        step = steps[len(chain) - 1]
        nxt = _next_ids(metamodel, model, element_id, step, budget)
        if budget.exhausted:
            return True
        if _walk(
            metamodel, model, steps, nxt, chain, chains, limits, budget,
            exclude_visited,
        ):
            return True
    return False


def _evaluate_set(
    metamodel: Metamodel,
    model: Model,
    expr: SetExpression,
    limits: EvalLimits,
    budget: _Budget,
) -> tuple[set[str], bool]:
    """(member ids, any-operand-truncated). `difference` folds left-to-right
    over the operand list; the other ops are order-insensitive.

    Each operand's inner path is evaluated with a FRESH `_Budget` (see
    `_operand_members`) — limits are per-navigation, so one operand hitting
    `max_visited`/`max_chains` never starves a sibling operand's budget.
    Truncation on any operand still propagates into this call's return value
    (and from there into the outer `ChainResult.truncated`)."""
    truncated = False
    result: set[str] | None = None
    for operand in expr.operands:
        assert operand.definition is not None  # resolver inlined every ref
        members, op_truncated = _operand_members(
            metamodel, model, operand.definition, operand.step_index, limits, budget
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
) -> tuple[set[str], bool]:
    if isinstance(defn, SetExpression):
        # a set has no steps; any explicit index other than 0 is an error
        if step_index not in (None, 0):
            raise ValueError(f"step_index {step_index} out of range for a set operand")
        return _evaluate_set(metamodel, model, defn, limits, budget)
    inner = evaluate(metamodel, model, defn, limits)
    n_steps = len(inner.step_types)
    index = n_steps if step_index is None else step_index
    if index > n_steps:
        raise ValueError(
            f"step_index {step_index} out of range: path has {n_steps} steps"
        )
    return {chain[index] for chain in inner.chains}, inner.truncated
