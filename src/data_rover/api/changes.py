"""CR compaction engine: op log -> ``datarover.cr/v1`` change set.

Shared API-layer logic (sibling of :mod:`.session`, following the
``routes/_snapshot.py`` precedent): GET /model/changes and /model/changes/
summary render its output today, and the Phase C3 save-with-CR flow reuses
it to persist the pending change set alongside a saved model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from typing_extensions import assert_never

from data_rover.core.model.model import Model

from .schemas import (
    CrElementOps,
    CrOps,
    CrRelationshipOps,
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ElementOut,
    ModifiedElementOut,
    ModifiedRelationshipOut,
    OpIn,
    RelationshipOut,
    UpdateElementOp,
    UpdateRelationshipOp,
)
from .session import AppliedBatch


@dataclass
class _ElState:
    type_name: str
    properties: dict[str, Any]


@dataclass
class _RelState:
    type_name: str
    source_id: str
    target_id: str
    properties: dict[str, Any]


def _el_out(eid: str, state: _ElState) -> ElementOut:
    """Serialize a scratch BASE element state (``rev=0``; see compact_changes)."""
    return ElementOut(id=eid, type_name=state.type_name, properties=state.properties)


def _rel_out(rid: str, state: _RelState) -> RelationshipOut:
    """Serialize a scratch BASE relationship state (``rev=0``)."""
    return RelationshipOut(
        id=rid,
        type_name=state.type_name,
        source_id=state.source_id,
        target_id=state.target_id,
        properties=state.properties,
    )


def _merge_patch(props: dict[str, Any], patch: dict[str, Any]) -> None:
    """JSON-merge-patch over a scratch property dict (None deletes the key)."""
    for key, value in patch.items():
        if value is None:
            props.pop(key, None)
        else:
            props[key] = value


def _touch(
    op: OpIn, touched_els: dict[str, None], touched_rels: dict[str, None]
) -> None:
    if isinstance(op, CreateElementOp):
        touched_els.setdefault(op.temp_id)
    elif isinstance(op, (UpdateElementOp, DeleteElementOp)):
        touched_els.setdefault(op.id)
    elif isinstance(op, CreateRelationshipOp):
        touched_rels.setdefault(op.temp_id)
    elif isinstance(op, (UpdateRelationshipOp, DeleteRelationshipOp)):
        touched_rels.setdefault(op.id)
    else:
        assert_never(op)


def _apply_inverse(
    op: OpIn, el_state: dict[str, _ElState], rel_state: dict[str, _RelState]
) -> None:
    """Step the scratch entity states one inverse op backwards in history.

    Inverse create ops carry the full pre-delete snapshot (the ops layer
    records properties on the inverse unit), so a "create" here reinstates
    the complete state; updates are merge patches; deletes drop the entity
    (it was created later in history than the point we are rewinding to).
    """
    if isinstance(op, CreateElementOp):
        el_state[op.temp_id] = _ElState(op.type_name, dict(op.properties))
    elif isinstance(op, UpdateElementOp):
        _merge_patch(el_state[op.id].properties, op.properties_patch)
    elif isinstance(op, DeleteElementOp):
        el_state.pop(op.id, None)
    elif isinstance(op, CreateRelationshipOp):
        rel_state[op.temp_id] = _RelState(
            op.type_name, op.source_id, op.target_id, dict(op.properties)
        )
    elif isinstance(op, UpdateRelationshipOp):
        _merge_patch(rel_state[op.id].properties, op.properties_patch)
    elif isinstance(op, DeleteRelationshipOp):
        rel_state.pop(op.id, None)
    else:
        assert_never(op)


def compact_changes(model: Model, op_log: list[AppliedBatch]) -> CrOps:
    """Compact the op log into one base-vs-current change set.

    Two passes over the RETAINED log, O(logged ops), no model copy:

    1. collect every touched entity id (inverse ops included — containment
       cascades appear only there) in first-touch order;
    2. rewind a scratch state map from the CURRENT model back through every
       batch's inverse ops (newest batch first) to recover each touched
       entity's BASE state — the model as of the oldest retained batch's
       pre-state.

    Classification per entity then yields the compaction rules for free:
    absent->present = added (final state; create-then-modify collapses into
    one add), present->absent = deleted (first before-state), changed
    present->present = modified (first before, last after), absent->absent
    (created and deleted within history) or unchanged = omitted. Before
    states are serialized with ``rev=0``: the session model's rev counters
    only ever move forward, the base rev is unrecoverable — and the CR apply
    path explicitly ignores rev when matching.
    """
    touched_els: dict[str, None] = {}
    touched_rels: dict[str, None] = {}
    for batch in op_log:
        for op in batch.ops:
            _touch(op, touched_els, touched_rels)
        for op in batch.inverse_ops:
            _touch(op, touched_els, touched_rels)

    el_state: dict[str, _ElState] = {}
    rel_state: dict[str, _RelState] = {}
    for eid in touched_els:
        element = model.elements.get(eid)
        if element is not None:
            el_state[eid] = _ElState(element.type_name, dict(element.properties))
    for rid in touched_rels:
        rel = model.relationships.get(rid)
        if rel is not None:
            rel_state[rid] = _RelState(
                rel.type_name, rel.source_id, rel.target_id, dict(rel.properties)
            )
    for batch in reversed(op_log):
        for op in batch.inverse_ops:
            _apply_inverse(op, el_state, rel_state)

    elements = CrElementOps()
    for eid in touched_els:
        base = el_state.get(eid)
        current = model.elements.get(eid)
        if base is None and current is not None:
            elements.added.append(ElementOut.from_core(current))
        elif base is not None and current is None:
            elements.deleted.append(_el_out(eid, base))
        elif base is not None and current is not None:
            if (
                base.type_name != current.type_name
                or base.properties != current.properties
            ):
                elements.modified.append(
                    ModifiedElementOut(
                        id=eid,
                        before=_el_out(eid, base),
                        after=ElementOut.from_core(current),
                    )
                )

    relationships = CrRelationshipOps()
    for rid in touched_rels:
        rbase = rel_state.get(rid)
        rcurrent = model.relationships.get(rid)
        if rbase is None and rcurrent is not None:
            relationships.added.append(RelationshipOut.from_core(rcurrent))
        elif rbase is not None and rcurrent is None:
            relationships.deleted.append(_rel_out(rid, rbase))
        elif rbase is not None and rcurrent is not None:
            if (
                rbase.type_name != rcurrent.type_name
                or rbase.source_id != rcurrent.source_id
                or rbase.target_id != rcurrent.target_id
                or rbase.properties != rcurrent.properties
            ):
                relationships.modified.append(
                    ModifiedRelationshipOut(
                        id=rid,
                        before=_rel_out(rid, rbase),
                        after=RelationshipOut.from_core(rcurrent),
                    )
                )

    return CrOps(elements=elements, relationships=relationships)
