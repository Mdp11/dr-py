"""History range diff: the model-entity changes between two revisions.

The fold reads the ``entity_states`` each commit in ``(from, to]`` captured
(``commit_states``) and keeps, per id, the FIRST row's ``before`` and the LAST
row's ``after``: an entity created in the range has a null first ``before``
whatever later rows say, and one deleted and created again keeps its original
``before``. It loads no model and touches no live ``Session``; its cost is the
rows' JSON, so it applies only when the range is at most
``RANGE_DIFF_MAX_REVS`` commits and the rows are contiguous and carry states
(``can_fold``). A rebind row changes no entity, so it contributes nothing and
does not stop the fold. A range the journal cannot answer has no answer
(``diff_range`` raises ``DiffUnavailable``): the server holds no model to rebuild one
from. ``render_range``'s equality ignores ``id`` and ``rev``: an entity that
returns to its earlier state, with a newer ``rev``, is no change.

This module is deliberately route-free: nothing here depends on FastAPI, a
request, or a live ``Session``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy.orm import Session as DbSession

from . import content
from .commit_states import DiffUnavailable, ElementPair, EntityStates, RelationshipPair
from .schemas import (
    CrElementOps,
    CrRelationshipOps,
    ElementOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    RangeDiffOut,
    RelationshipOut,
)

#: longest span (``to - from``) the journal fold answers
RANGE_DIFF_MAX_REVS = 1000


def can_fold(
    marks: Sequence[tuple[int, bool, bool]], from_rev: int, to_rev: int
) -> bool:
    """Whether the journal answers ``(from_rev, to_rev]``. ``marks`` are
    ``content.commit_range_marks`` for it: the span is within the cap, the
    revs are exactly ``from_rev + 1 … to_rev`` in order, and every row carries
    states or is a rebind (which has none to give). An empty range is
    foldable."""
    if to_rev - from_rev > RANGE_DIFF_MAX_REVS:
        return False
    if len(marks) != to_rev - from_rev:
        return False
    return all(
        rev == from_rev + 1 + i and (has_states or is_rebind)
        for i, (rev, has_states, is_rebind) in enumerate(marks)
    )


def _element(raw: Any) -> ElementOut | None:
    return ElementOut.model_validate(raw) if raw is not None else None


def _relationship(raw: Any) -> RelationshipOut | None:
    return RelationshipOut.model_validate(raw) if raw is not None else None


def fold_range(
    db: DbSession, project_id: str, from_rev: int, to_rev: int
) -> EntityStates:
    """(before, after) per id touched in ``(from_rev, to_rev]``, folded from
    the commits' captured states. The caller has checked ``can_fold``. Only
    the surviving pairs are validated into typed bodies; a pair with both
    sides absent (created and deleted inside the range) is dropped."""
    if from_rev == to_rev:
        return EntityStates(elements={}, relationships={})
    first_before: dict[str, dict[str, Any]] = {"elements": {}, "relationships": {}}
    last_after: dict[str, dict[str, Any]] = {"elements": {}, "relationships": {}}
    for raw in content.commit_states_between(
        db, project_id, after_rev=from_rev, max_rev=to_rev
    ):
        if raw is None:  # a rebind row without states
            continue
        for family in ("elements", "relationships"):
            for eid, entry in raw.get(family, {}).items():
                first_before[family].setdefault(eid, entry["before"])
                last_after[family][eid] = entry["after"]

    elements: dict[str, ElementPair] = {}
    for eid, after in last_after["elements"].items():
        before = first_before["elements"][eid]
        if before is not None or after is not None:
            elements[eid] = (_element(before), _element(after))
    relationships: dict[str, RelationshipPair] = {}
    for rid, after in last_after["relationships"].items():
        before = first_before["relationships"][rid]
        if before is not None or after is not None:
            relationships[rid] = (_relationship(before), _relationship(after))
    return EntityStates(elements=elements, relationships=relationships)


def _same_element(before: ElementOut, after: ElementOut) -> bool:
    return before.type_name == after.type_name and before.properties == after.properties


def _same_relationship(before: RelationshipOut, after: RelationshipOut) -> bool:
    return (
        before.type_name == after.type_name
        and before.source_id == after.source_id
        and before.target_id == after.target_id
        and before.properties == after.properties
    )


def _element_ops(states: Mapping[str, ElementPair]) -> CrElementOps:
    out = CrElementOps()
    for eid in sorted(states):
        before, after = states[eid]
        if before is None and after is not None:
            out.added.append(after)
        elif before is not None and after is None:
            out.deleted.append(before)
        elif before is not None and after is not None:
            if not _same_element(before, after):
                out.modified.append(
                    ModifiedElementOut(id=eid, before=before, after=after)
                )
    return out


def _relationship_ops(states: Mapping[str, RelationshipPair]) -> CrRelationshipOps:
    out = CrRelationshipOps()
    for rid in sorted(states):
        before, after = states[rid]
        if before is None and after is not None:
            out.added.append(after)
        elif before is not None and after is None:
            out.deleted.append(before)
        elif before is not None and after is not None:
            if not _same_relationship(before, after):
                out.modified.append(
                    ModifiedRelationshipOut(id=rid, before=before, after=after)
                )
    return out


def render_range(states: EntityStates, from_rev: int, to_rev: int) -> RangeDiffOut:
    """The change-request shaped answer for ``states``, ids in sorted order.
    A pair whose sides are equal in type, properties and (for a relationship)
    endpoints renders nothing."""
    return RangeDiffOut(
        from_rev=from_rev,
        to_rev=to_rev,
        source="journal",
        elements=_element_ops(states.elements),
        relationships=_relationship_ops(states.relationships),
    )


def diff_range(
    db: DbSession, project_id: str, from_rev: int, to_rev: int
) -> RangeDiffOut:
    """The diff of ``(from_rev, to_rev]`` folded from the journal. Raises
    ``DiffUnavailable`` when ``can_fold`` refuses the range (a gap in the
    journal, or a row without states). Assumes ``0 <= from_rev <= to_rev <=
    head`` and a span of at most ``RANGE_DIFF_MAX_REVS``."""
    marks = content.commit_range_marks(
        db, project_id, after_rev=from_rev, max_rev=to_rev
    )
    if not can_fold(marks, from_rev, to_rev):
        raise DiffUnavailable("diff unavailable for this range")
    return render_range(fold_range(db, project_id, from_rev, to_rev), from_rev, to_rev)
