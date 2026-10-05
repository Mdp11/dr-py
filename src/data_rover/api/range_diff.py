"""History range diff: the model-entity changes between two revisions.

The fold reads the ``entity_states`` each commit in ``(from, to]`` captured
(``commit_states``) and keeps, per id, the FIRST row's ``before`` and the LAST
row's ``after``: an entity created in the range has a null first ``before``
whatever later rows say, and one deleted and created again keeps its original
``before``. It loads no model and touches no live ``Session``; its cost is the
rows' JSON, so it applies only when the range is at most
``RANGE_DIFF_MAX_REVS`` commits, contiguous, every row carries states and none
is a rebind (``can_fold``).

Any other range is answered by rebuilding the model at both ends
(``reconstruct_model_at``, O(model) twice) and comparing entity by entity, so
the cost of a range the journal cannot express is that of
``reconstruct_model_at`` twice. Both paths feed ``render_range``, whose
equality ignores ``id`` and ``rev``: an entity that returns to its earlier
state, with a newer ``rev``, is no change.

This module is deliberately route-free: nothing here depends on FastAPI, a
request, or a live ``Session``.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Literal

from sqlalchemy.orm import Session as DbSession

from data_rover.core.model.element import Element
from data_rover.core.model.relationship import Relationship

from . import content
from .commit_states import ElementPair, EntityStates, RelationshipPair
from .hydration import reconstruct_model_at
from .schemas import (
    CrElementOps,
    CrRelationshipOps,
    ElementOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    RangeDiffOut,
    RelationshipOut,
)

#: longest span (``to - from``) the journal fold answers; a longer one is
#: reconstructed
RANGE_DIFF_MAX_REVS = 1000

RangeSource = Literal["journal", "reconstruction"]


def can_fold(
    marks: Sequence[tuple[int, bool, bool]], from_rev: int, to_rev: int
) -> bool:
    """Whether the journal answers ``(from_rev, to_rev]``. ``marks`` are
    ``content.commit_range_marks`` for it: the span is within the cap, the
    revs are exactly ``from_rev + 1 … to_rev`` in order, every row carries
    states and none is a rebind. An empty range is foldable."""
    if to_rev - from_rev > RANGE_DIFF_MAX_REVS:
        return False
    if len(marks) != to_rev - from_rev:
        return False
    return all(
        rev == from_rev + 1 + i and has_states and not is_rebind
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


def _same_element(before: ElementOut | Element, after: ElementOut | Element) -> bool:
    return before.type_name == after.type_name and before.properties == after.properties


def _same_relationship(
    before: RelationshipOut | Relationship, after: RelationshipOut | Relationship
) -> bool:
    return (
        before.type_name == after.type_name
        and before.source_id == after.source_id
        and before.target_id == after.target_id
        and before.properties == after.properties
    )


def reconstruct_range(project_id: str, from_rev: int, to_rev: int) -> EntityStates:
    """(before, after) per id that exists on one side only or differs between
    the models rebuilt at ``from_rev`` and ``to_rev``. Entities are compared as
    core objects, so a large model with few changes builds few typed bodies."""
    old = reconstruct_model_at(project_id, from_rev)
    new = reconstruct_model_at(project_id, to_rev)
    old_els = old.elements if old is not None else {}
    new_els = new.elements if new is not None else {}
    old_rels = old.relationships if old is not None else {}
    new_rels = new.relationships if new is not None else {}

    elements: dict[str, ElementPair] = {}
    for eid, b in old_els.items():
        a = new_els.get(eid)
        if a is None or not _same_element(b, a):
            elements[eid] = (
                ElementOut.from_core(b),
                ElementOut.from_core(a) if a is not None else None,
            )
    for eid, a in new_els.items():
        if eid not in old_els:
            elements[eid] = (None, ElementOut.from_core(a))

    relationships: dict[str, RelationshipPair] = {}
    for rid, rb in old_rels.items():
        ra = new_rels.get(rid)
        if ra is None or not _same_relationship(rb, ra):
            relationships[rid] = (
                RelationshipOut.from_core(rb),
                RelationshipOut.from_core(ra) if ra is not None else None,
            )
    for rid, ra in new_rels.items():
        if rid not in old_rels:
            relationships[rid] = (None, RelationshipOut.from_core(ra))
    return EntityStates(elements=elements, relationships=relationships)


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


def render_range(
    states: EntityStates, from_rev: int, to_rev: int, source: RangeSource
) -> RangeDiffOut:
    """The change-request shaped answer for ``states``, ids in sorted order.
    A pair whose sides are equal in type, properties and (for a relationship)
    endpoints renders nothing."""
    return RangeDiffOut(
        from_rev=from_rev,
        to_rev=to_rev,
        source=source,
        elements=_element_ops(states.elements),
        relationships=_relationship_ops(states.relationships),
    )


def diff_range(
    db: DbSession, project_id: str, from_rev: int, to_rev: int
) -> RangeDiffOut:
    """The diff of ``(from_rev, to_rev]``: folded from the journal when
    ``can_fold`` allows, else reconstructed. Assumes
    ``0 <= from_rev <= to_rev <= head``."""
    marks = (
        content.commit_range_marks(db, project_id, after_rev=from_rev, max_rev=to_rev)
        if to_rev - from_rev <= RANGE_DIFF_MAX_REVS
        else []
    )
    if can_fold(marks, from_rev, to_rev):
        return render_range(
            fold_range(db, project_id, from_rev, to_rev), from_rev, to_rev, "journal"
        )
    return render_range(
        reconstruct_range(project_id, from_rev, to_rev),
        from_rev,
        to_rev,
        "reconstruction",
    )
