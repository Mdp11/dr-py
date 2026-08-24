"""Static reverse-reach: which elements can a mutation's dirty set affect
through user rules?

Each relationship atom in a rule contributes one root-first path of
(rel-type closure, direction, far-type closure) steps. Expansion walks
dirty elements backwards along every path suffix they could sit on and
adds the reached applies_to-typed elements. Over-approximation is safe
(the scoped rerun just revalidates a few extra elements); too-small is
the only correctness hazard.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from .schema import (
    AllCond,
    AnyCond,
    Condition,
    NotCond,
    RelationshipCond,
    Rule,
)

if TYPE_CHECKING:
    from ...metamodel.schema import Metamodel
    from ...model.model import Model
    from .compile import CompiledRules


@dataclass(frozen=True)
class ReverseStep:
    rel_types: frozenset[str]
    #: direction as written in the rule: owner -> far
    direction: Literal["outgoing", "incoming"]
    far_types: frozenset[str] | None


@dataclass(frozen=True)
class ReversePath:
    steps: tuple[ReverseStep, ...]  # root-first


def derive_paths(rule: Rule, metamodel: Metamodel) -> list[ReversePath]:
    paths: list[ReversePath] = []

    def walk(cond: Condition, prefix: tuple[ReverseStep, ...]) -> None:
        match cond:
            case AllCond(all=subs) | AnyCond(any=subs):
                for c in subs:
                    walk(c, prefix)
            case NotCond(not_=sub):
                walk(sub, prefix)
            case RelationshipCond(relationship=spec):
                step = ReverseStep(
                    rel_types=metamodel.relationship_descendants(spec.type),
                    direction=spec.direction,
                    far_types=(
                        None
                        if spec.to is None
                        else metamodel.element_descendants(spec.to)
                    ),
                )
                paths.append(ReversePath(steps=(*prefix, step)))
                if spec.where is not None:
                    walk(spec.where, (*prefix, step))
            case _:
                pass  # property atoms reach only the element itself

    for cond in (rule.when, rule.then):
        if cond is not None:
            walk(cond, ())
    return paths


def _owners(model: Model, frontier: set[str], step: ReverseStep) -> set[str]:
    """One reverse hop: the elements whose `step` hop reaches `frontier`."""
    out: set[str] = set()
    for eid in frontier:
        rel_ids = (
            model.indexes.incoming_ids(eid)
            if step.direction == "outgoing"
            else model.indexes.outgoing_ids(eid)
        )
        for rid in rel_ids:
            rel = model.relationships[rid]
            if rel.type_name not in step.rel_types:
                continue
            out.add(rel.source_id if step.direction == "outgoing" else rel.target_id)
    return out


def expand_scope(
    model: Model, compiled: CompiledRules, dirty_ids: Iterable[str]
) -> list[str]:
    if not compiled.rules:
        return []
    extra: dict[str, None] = {}
    dirty_elements = [
        el for eid in dirty_ids if (el := model.elements.get(eid)) is not None
    ]
    for cr in compiled.rules:
        for path in cr.paths:
            steps = path.steps
            for d in range(1, len(steps) + 1):
                far = steps[d - 1].far_types
                seeds = {
                    el.id for el in dirty_elements if far is None or el.type_name in far
                }
                if not seeds:
                    continue
                frontier = seeds
                for i in range(d - 1, -1, -1):
                    frontier = _owners(model, frontier, steps[i])
                    gate = steps[i - 1].far_types if i > 0 else cr.applies_types
                    if gate is not None:
                        frontier = {
                            fid
                            for fid in frontier
                            if (fel := model.elements.get(fid)) is not None
                            and fel.type_name in gate
                        }
                    if not frontier:
                        break
                for fid in sorted(frontier):
                    extra[fid] = None
    return list(extra)
