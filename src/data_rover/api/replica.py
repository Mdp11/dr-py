"""What a replica catches up by: the commit tail from a revision it holds to
head, each commit as the feed's ``commit`` event of its journal row.

One rule governs a tail: a range is served whole or not at all. Every
revision in it must have a journal row that can be expressed as a delta — a
row with entity states and a state digest, and no metamodel rebind — and the
range must be no longer than ``TAIL_MAX_REVS``; otherwise the tail is
``complete: false`` and the client opens a snapshot instead.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from sqlalchemy.orm import Session as DbSession

from . import content
from .artifact_ops import ARTIFACT_OP_KINDS
from .db_models import Commit
from .feed import commit_event
from .schemas import METAMODEL_OP_KINDS, VIEW_OP_KINDS

#: the most revisions one tail spans
TAIL_MAX_REVS = 1000


def tail_is_complete(
    marks: Sequence[tuple[int, bool]], from_rev: int, head_rev: int
) -> bool:
    """True iff ``marks`` (``commit_tail_marks`` over ``(from_rev, head_rev]``)
    hold every revision of the range, each expressible, and the range is
    within ``TAIL_MAX_REVS``. A ``from_rev`` beyond head is incomplete."""
    if not 0 <= head_rev - from_rev <= TAIL_MAX_REVS:
        return False
    return [rev for rev, _ in marks] == list(range(from_rev + 1, head_rev + 1)) and all(
        ok for _, ok in marks
    )


def scope_of_ops(raw_ops: Sequence[Mapping[str, Any]]) -> list[str]:
    """The feed ``scope`` of a journal row's raw ops."""
    kinds = {op.get("kind") for op in raw_ops}
    scope = set()
    if any(
        k not in ARTIFACT_OP_KINDS | VIEW_OP_KINDS | METAMODEL_OP_KINDS for k in kinds
    ):
        scope.add("model")
    if kinds & ARTIFACT_OP_KINDS:
        scope.add("artifact")
    if kinds & VIEW_OP_KINDS:
        scope.add("view")
    if "metamodel.move_node" in kinds:
        scope.add("metamodel-layout")
    return sorted(scope) or ["model"]


def delta_from_commit(row: Commit, prev_rev: int) -> dict[str, Any]:
    """The ``commit_event`` of an expressible journal row, read from its raw
    ``entity_states``: every non-null ``after`` is a changed entity and every
    null one a deleted id, both in the row's key order, which is the batch's."""
    raw: Mapping[str, Any] = row.entity_states or {}
    elements: Mapping[str, Any] = raw.get("elements", {})
    relationships: Mapping[str, Any] = raw.get("relationships", {})
    recreated: Mapping[str, Any] = raw.get("recreated", {})
    assert row.state_digest is not None
    return commit_event(
        rev=row.rev,
        prev_rev=prev_rev,
        state_digest=row.state_digest,
        scope=scope_of_ops(row.ops),
        commit_id=row.commit_id,
        author_id=row.author_id or "",
        message=row.message,
        validation_error_count=row.validation_error_count,
        changed_elements=[
            p["after"] for p in elements.values() if p["after"] is not None
        ],
        changed_relationships=[
            p["after"] for p in relationships.values() if p["after"] is not None
        ],
        deleted_element_ids=[i for i, p in elements.items() if p["after"] is None],
        deleted_relationship_ids=[
            i for i, p in relationships.items() if p["after"] is None
        ],
        recreated_element_ids=list(recreated.get("elements", [])),
        recreated_relationship_ids=list(recreated.get("relationships", [])),
    )


def build_tail(
    db: DbSession, project_id: str, from_rev: int, head_rev: int
) -> dict[str, Any]:
    """The tail from ``from_rev`` to ``head_rev``; no row is loaded unless the
    range is complete."""
    marks = content.commit_tail_marks(
        db, project_id, after_rev=from_rev, max_rev=head_rev
    )
    if not tail_is_complete(marks, from_rev, head_rev):
        return {
            "from_rev": from_rev,
            "head_rev": head_rev,
            "complete": False,
            "deltas": [],
        }
    rows = content.commits_between(db, project_id, after_rev=from_rev, max_rev=head_rev)
    return {
        "from_rev": from_rev,
        "head_rev": head_rev,
        "complete": True,
        "deltas": [delta_from_commit(row, row.rev - 1) for row in rows],
    }
