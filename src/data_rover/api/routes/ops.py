"""The op applier and the journal append behind ``POST /commits``.

The session model is the source of truth and clients mutate it by sending
small op batches (the op union in ``schemas.py``) instead of pushing
whole-model snapshots.

Atomicity without deep copies
-----------------------------
Batches are atomic, but the model is NOT deep-copied per request (it can be
~80 MB): ops are applied directly to the live session model while the state
of every entity is noted before its first touch. If an op fails mid-batch,
``_rollback`` puts each touched entity back from that before-image —
properties, ``rev`` and place in insertion order — and the request fails with
422. Every other path that applies a batch and takes it back (a preview, a
commit refused or not persisted) rolls back the same way, so none of them
leaves a trace. This trades a small rollback path for O(batch) request cost
instead of O(model).

``rev`` counters are a change ticker, not part of the state a restore
reinstates; with the id they are one half of every pair the state digest
folds (``api/state_digest.py``).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, assert_never

from fastapi import HTTPException
from sqlalchemy.orm import Session as DbSession

from data_rover.core.model.element import Element
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.validation.dirty import DirtyCollector, containment_closure

from .. import content
from ..deps import Session
from ..hydration import serialize_ops
from ..settings import get_settings
from ..snapshot_job import schedule_periodic_snapshot
from ..schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ElementOut,
    is_reserved_id,
    ModelOpIn,
    OpIn,
    RelationshipOut,
    TEMP_ID_PREFIX,
    UpdateElementOp,
    UpdateRelationshipOp,
)

# ``TEMP_ID_PREFIX`` is imported from ``schemas`` above — its single source,
# living with the op union it is part of — and re-exported through this module
# for its long-standing importers (``routes/commits.py`` among them). A create
# op whose ``temp_id`` lacks the prefix is rejected on the public endpoint; in
# restore mode (undo/rollback) it means "reinstate this exact canonical id".


def _resolve_value(value: Any, id_map: dict[str, str]) -> Any:
    """Port of ``remapValue`` in ``frontend/src/lib/state/save.ts``.

    Strings matching a known temp id are replaced by their canonical id;
    lists are remapped item-wise; everything else (including unknown temp
    ids — they stay as dangling references for validation to flag) passes
    through unchanged.
    """
    if isinstance(value, str):
        return id_map.get(value, value)
    if isinstance(value, list):
        return [_resolve_value(v, id_map) for v in value]
    return value


def _resolve_props(props: dict[str, Any], id_map: dict[str, str]) -> dict[str, Any]:
    return {k: _resolve_value(v, id_map) for k, v in props.items()}


@dataclass
class _BatchResult:
    """Everything one batch application produced (see ``_apply_batch``).

    The four id dicts are ordered sets (dict-of-None idiom) in first-touch op
    application order; deleting an entity removes it from the changed set and
    re-creating it removes it from the deleted set, so the two are disjoint.
    The two ``recreated_*`` sets name, among the changed ids, the ones the
    batch deleted and then created again: such an entity is a new one at the
    END of its dict, which its changed state alone cannot say.
    """

    canonical_ops: list[ModelOpIn] = field(default_factory=list)
    #: one inner list per completed mutation, in application order; an inner
    #: list's internal order matters (delete-element inverses recreate
    #: elements before relationships) and must never be reversed
    inverse_units: list[list[ModelOpIn]] = field(default_factory=list)
    id_map: dict[str, str] = field(default_factory=dict)
    dirty: DirtyCollector = field(default_factory=DirtyCollector)
    changed_element_ids: dict[str, None] = field(default_factory=dict)
    changed_relationship_ids: dict[str, None] = field(default_factory=dict)
    deleted_element_ids: dict[str, None] = field(default_factory=dict)
    deleted_relationship_ids: dict[str, None] = field(default_factory=dict)
    recreated_element_ids: dict[str, None] = field(default_factory=dict)
    recreated_relationship_ids: dict[str, None] = field(default_factory=dict)
    #: pre-batch state per touched id, captured on FIRST touch (None = did
    #: not exist). Later touches in the same batch never overwrite, so an
    #: entity created-then-updated stays None and one deleted-then-restored
    #: keeps its original state. Every id in changed_*/deleted_* has an entry.
    before_elements: dict[str, ElementOut | None] = field(default_factory=dict)
    before_relationships: dict[str, RelationshipOut | None] = field(
        default_factory=dict
    )
    #: insertion sequence number of every before-image that is not None
    #: (``IndexSet.element_order`` / ``relationship_order``): where a rollback
    #: puts the entity back, and how it tells a survivor from an entity
    #: created again under the same id
    before_element_orders: dict[str, int] = field(default_factory=dict)
    before_relationship_orders: dict[str, int] = field(default_factory=dict)

    def mark_element_changed(self, element_id: str) -> None:
        self.changed_element_ids[element_id] = None
        self.deleted_element_ids.pop(element_id, None)

    def mark_relationship_changed(self, rel_id: str) -> None:
        self.changed_relationship_ids[rel_id] = None
        self.deleted_relationship_ids.pop(rel_id, None)

    def mark_element_created(self, element_id: str) -> None:
        if element_id in self.deleted_element_ids:
            self.recreated_element_ids[element_id] = None
        self.mark_element_changed(element_id)

    def mark_relationship_created(self, rel_id: str) -> None:
        if rel_id in self.deleted_relationship_ids:
            self.recreated_relationship_ids[rel_id] = None
        self.mark_relationship_changed(rel_id)

    def mark_element_deleted(self, element_id: str) -> None:
        self.deleted_element_ids[element_id] = None
        self.changed_element_ids.pop(element_id, None)
        self.recreated_element_ids.pop(element_id, None)

    def mark_relationship_deleted(self, rel_id: str) -> None:
        self.deleted_relationship_ids[rel_id] = None
        self.changed_relationship_ids.pop(rel_id, None)
        self.recreated_relationship_ids.pop(rel_id, None)

    def note_element_before(
        self, model: Model, element_id: str, element: Element | None
    ) -> None:
        """Record ``element``'s current state as its pre-batch state unless an
        earlier op in this batch already did. Call BEFORE mutating it."""
        if element_id in self.before_elements:
            return
        if element is None:
            self.before_elements[element_id] = None
            return
        self.before_elements[element_id] = ElementOut.from_core(element)
        self.before_element_orders[element_id] = model.indexes.element_order[element_id]

    def note_relationship_before(
        self, model: Model, rel_id: str, rel: Relationship | None
    ) -> None:
        if rel_id in self.before_relationships:
            return
        if rel is None:
            self.before_relationships[rel_id] = None
            return
        self.before_relationships[rel_id] = RelationshipOut.from_core(rel)
        self.before_relationship_orders[rel_id] = model.indexes.relationship_order[
            rel_id
        ]

    def inverse_ops(self) -> list[ModelOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def _check_patch_keys(
    model: Model, type_name: str, *, element: bool, patch: dict[str, Any]
) -> None:
    """Reject unknown patch keys upfront so a patch can never fail half-applied
    (set/delete_property on an attached entity only fails on unknown keys)."""
    if element:
        valid = model.metamodel.effective_element_property_names(type_name)
    else:
        valid = model.metamodel.effective_relationship_property_names(type_name)
    for key in patch:
        if key not in valid:
            raise KeyError(f"{type_name!r} has no property {key!r}")


def _reject_reserved_hint(hint: str) -> None:
    """An id hint must never look like a temp id: the restore-mode replay
    branches on the prefix, so a journalled ``tmp_`` id would be ambiguous."""
    if is_reserved_id(hint):
        raise ValueError(
            f"id hint {hint!r} must not use the reserved {TEMP_ID_PREFIX!r} prefix"
        )


def _apply_one(
    model: Model, op: ModelOpIn, res: _BatchResult, *, restore: bool
) -> None:
    """Apply one op to the live model, recording inverse unit(s) and deltas.

    Every mutation goes through the DirtyCollector wrappers (or the raw
    dirty hooks around the ``restore_*`` Model methods) so the dirty set is
    collected automatically. Inverse units are appended only for mutations
    that actually happened, so on mid-op failure (e.g. a create op whose
    third property key is unknown) the already-recorded units cover exactly
    the applied effects.
    """
    d = res.dirty
    if isinstance(op, CreateElementOp):
        props = _resolve_props(op.properties, res.id_map)
        if op.temp_id.startswith(TEMP_ID_PREFIX):
            if op.id is None:
                element = d.create_element(model, op.type_name)
            else:
                # restore_element raises ValueError when the id is taken;
                # _apply_batch maps it to the 422 + rollback every other
                # mutation-boundary error gets
                _reject_reserved_hint(op.id)
                element = model.restore_element(op.id, op.type_name)
                d.after_element_create(model, element.id)
            res.id_map[op.temp_id] = element.id
        elif restore:
            element = model.restore_element(op.temp_id, op.type_name)
            d.after_element_create(model, element.id)
        else:
            raise ValueError(
                f"create_element temp_id {op.temp_id!r} must start with "
                f"{TEMP_ID_PREFIX!r}"
            )
        res.note_element_before(model, element.id, None)
        # inverse recorded BEFORE the property sets, so the unit list never
        # lags a mutation that happened
        res.inverse_units.append(
            [DeleteElementOp(kind="delete_element", id=element.id)]
        )
        for key, value in props.items():
            d.set_property(model, element, key, value)
        res.canonical_ops.append(
            op.model_copy(
                update={"temp_id": element.id, "properties": props, "id": None}
            )
        )
        res.mark_element_created(element.id)
        return

    if isinstance(op, UpdateElementOp):
        eid = res.id_map.get(op.id, op.id)
        element = model.get_element(eid)
        res.note_element_before(model, eid, element)
        patch = _resolve_props(op.properties_patch, res.id_map)
        _check_patch_keys(model, element.type_name, element=True, patch=patch)
        # mergePatch semantics (frontend apply.ts): None deletes the key,
        # anything else replaces it; the inverse patch restores prior values
        # and None-deletes keys that did not exist before
        inverse_patch = {
            k: element.properties[k] if k in element.properties else None for k in patch
        }
        for key, value in patch.items():
            if value is None:
                d.delete_property(model, element, key)
            else:
                d.set_property(model, element, key, value)
        res.inverse_units.append(
            [
                UpdateElementOp(
                    kind="update_element", id=eid, properties_patch=inverse_patch
                )
            ]
        )
        res.canonical_ops.append(
            op.model_copy(update={"id": eid, "properties_patch": patch})
        )
        res.mark_element_changed(eid)
        return

    if isinstance(op, DeleteElementOp):
        eid = res.id_map.get(op.id, op.id)
        if eid not in model.elements:
            raise KeyError(f"No element with id {eid!r}")
        # snapshot the cascade BEFORE deleting: the containment closure is
        # exactly what Model.delete_element removes, plus every relationship
        # incident to a closure element. Deterministic order: closure walk
        # order, then per element sorted outgoing + incoming rel ids.
        closure = containment_closure(model, eid)
        removed_rel_ids: dict[str, None] = {}
        for ce in closure:
            for rid in sorted(model.indexes.outgoing_ids(ce)):
                removed_rel_ids[rid] = None
            for rid in sorted(model.indexes.incoming_ids(ce)):
                removed_rel_ids[rid] = None
        # inverse unit recreates elements BEFORE relationships (endpoints
        # must exist when relationships are reinstated); internal order of
        # this unit is preserved by inverse_ops()/rollback
        unit: list[ModelOpIn] = []
        for ce in closure:
            e = model.elements[ce]
            res.note_element_before(model, ce, e)
            unit.append(
                CreateElementOp(
                    kind="create_element",
                    temp_id=e.id,
                    type_name=e.type_name,
                    properties=dict(e.properties),
                )
            )
        for rid in removed_rel_ids:
            r = model.relationships[rid]
            res.note_relationship_before(model, rid, r)
            unit.append(
                CreateRelationshipOp(
                    kind="create_relationship",
                    temp_id=r.id,
                    type_name=r.type_name,
                    source_id=r.source_id,
                    target_id=r.target_id,
                    properties=dict(r.properties),
                )
            )
        d.delete_element(model, eid)
        res.inverse_units.append(unit)
        res.canonical_ops.append(op.model_copy(update={"id": eid}))
        for ce in closure:
            res.mark_element_deleted(ce)
        for rid in removed_rel_ids:
            res.mark_relationship_deleted(rid)
        return

    if isinstance(op, CreateRelationshipOp):
        source_id = res.id_map.get(op.source_id, op.source_id)
        target_id = res.id_map.get(op.target_id, op.target_id)
        props = _resolve_props(op.properties, res.id_map)
        if op.temp_id.startswith(TEMP_ID_PREFIX):
            if op.id is None:
                rel = d.connect(model, op.type_name, source_id, target_id)
            else:
                _reject_reserved_hint(op.id)
                d.before_connect(model, op.type_name, source_id, target_id)
                rel = model.restore_relationship(
                    op.id, op.type_name, source_id, target_id
                )
                d.after_connect(model, rel.id)
            res.id_map[op.temp_id] = rel.id
        elif restore:
            d.before_connect(model, op.type_name, source_id, target_id)
            rel = model.restore_relationship(
                op.temp_id, op.type_name, source_id, target_id
            )
            d.after_connect(model, rel.id)
        else:
            raise ValueError(
                f"create_relationship temp_id {op.temp_id!r} must start with "
                f"{TEMP_ID_PREFIX!r}"
            )
        res.note_relationship_before(model, rel.id, None)
        res.inverse_units.append(
            [DeleteRelationshipOp(kind="delete_relationship", id=rel.id)]
        )
        for key, value in props.items():
            d.set_property(model, rel, key, value)
        res.canonical_ops.append(
            op.model_copy(
                update={
                    "temp_id": rel.id,
                    "source_id": source_id,
                    "target_id": target_id,
                    "properties": props,
                    "id": None,
                }
            )
        )
        res.mark_relationship_created(rel.id)
        return

    if isinstance(op, UpdateRelationshipOp):
        rid = res.id_map.get(op.id, op.id)
        rel = model.get_relationship(rid)
        res.note_relationship_before(model, rid, rel)
        patch = _resolve_props(op.properties_patch, res.id_map)
        _check_patch_keys(model, rel.type_name, element=False, patch=patch)
        inverse_patch = {
            k: rel.properties[k] if k in rel.properties else None for k in patch
        }
        for key, value in patch.items():
            if value is None:
                d.delete_property(model, rel, key)
            else:
                d.set_property(model, rel, key, value)
        res.inverse_units.append(
            [
                UpdateRelationshipOp(
                    kind="update_relationship", id=rid, properties_patch=inverse_patch
                )
            ]
        )
        res.canonical_ops.append(
            op.model_copy(update={"id": rid, "properties_patch": patch})
        )
        res.mark_relationship_changed(rid)
        return

    if isinstance(op, DeleteRelationshipOp):
        rid = res.id_map.get(op.id, op.id)
        rel = model.get_relationship(rid)
        res.note_relationship_before(model, rid, rel)
        unit = [
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id=rel.id,
                type_name=rel.type_name,
                source_id=rel.source_id,
                target_id=rel.target_id,
                properties=dict(rel.properties),
            )
        ]
        d.disconnect(model, rid)
        res.inverse_units.append(unit)
        res.canonical_ops.append(op.model_copy(update={"id": rid}))
        res.mark_relationship_deleted(rid)
        return

    assert_never(op)  # a new OpIn variant without a branch fails type-checking


def _rollback(model: Model, res: _BatchResult) -> None:
    """Put every entity the batch touched back exactly as its before-image
    has it: properties, ``rev`` and place in insertion order. ``res`` may be
    the result of a batch that failed midway; the batch must be the newest
    change still applied to the model.

    An entity that outlived the batch still carries the sequence number of
    its image — one created again under the same id never does, creation
    always takes a new number — and is rewritten where it is. Whatever else
    the batch left under a touched id goes, relationships first, so that no
    element delete cascades into anything the batch did not touch; then what
    is missing comes back, elements first, because a relationship needs its
    ends. Replaying inverse ops instead would count ``rev`` up again and
    leave every restored entity last in its dict.
    """
    indexes = model.indexes
    for rid, rel_image in res.before_relationships.items():
        rel = model.relationships.get(rid)
        if rel is None:
            continue
        if (
            rel_image is not None
            and indexes.relationship_order[rid] == res.before_relationship_orders[rid]
        ):
            model.overwrite(rel, dict(rel_image.properties), rel_image.rev)
        else:
            model.disconnect(rid)
    for eid, image in res.before_elements.items():
        element = model.elements.get(eid)
        if element is None:
            continue
        if (
            image is not None
            and indexes.element_order[eid] == res.before_element_orders[eid]
        ):
            model.overwrite(element, dict(image.properties), image.rev)
        else:
            model.delete_element(eid)
    for eid, image in res.before_elements.items():
        if image is not None and eid not in model.elements:
            model.insert_element(
                eid,
                image.type_name,
                dict(image.properties),
                image.rev,
                res.before_element_orders[eid],
            )
    for rid, rel_image in res.before_relationships.items():
        if rel_image is not None and rid not in model.relationships:
            model.insert_relationship(
                rid,
                rel_image.type_name,
                rel_image.source_id,
                rel_image.target_id,
                dict(rel_image.properties),
                rel_image.rev,
                res.before_relationship_orders[rid],
            )
    model.settle_order()


def _error_detail(exc: BaseException) -> str:
    # KeyError's str() wraps the message in quotes; strip them like the
    # app-level handler in api/errors.py does
    return str(exc).strip("'\"") if isinstance(exc, KeyError) else str(exc)


def _apply_batch(model: Model, ops: list[ModelOpIn], *, restore: bool) -> _BatchResult:
    """Apply *ops* atomically to the live model.

    On ANY op failure every touched entity is put back from its before-image
    (``_rollback``) — the model, its indexes, and the validation store are
    left exactly as before the batch. The expected validation failures
    (KeyError/ValueError from the mutation boundary) become a 422; anything
    else is a bug and propagates (as a 500) AFTER the rollback, so even an
    unforeseen exception cannot leave the model half-mutated.
    """
    res = _BatchResult()
    try:
        for op in ops:
            _apply_one(model, op, res, restore=restore)
    except Exception as exc:
        _rollback(model, res)
        if isinstance(exc, (KeyError, ValueError)):
            raise HTTPException(status_code=422, detail=_error_detail(exc)) from exc
        raise
    return res


def _persist_commit(
    db: DbSession,
    project_id: str,
    *,
    rev: int,
    author_id: str | None,
    ops: Sequence[OpIn],
    inverse_ops: Sequence[OpIn],
    id_map: dict[str, str],
    _commit_id: str | None = None,
    _message: str = "",
    _validation_error_count: int | None = 0,
    _issues: list | None = None,
    _from_metamodel_id: str | None = None,
    _to_metamodel_id: str | None = None,
    _entity_states: dict[str, Any] | None = None,
    _state_digest: str | None = None,
) -> bool:
    """Append the accepted batch to the durable journal and advance model_rev.

    The batch arrives as three explicit lists rather than a ``_BatchResult``
    because a commit can span BOTH content families: ``POST /commits`` merges
    the model applier's result with the artifact applier's (``artifact_ops.
    ArtifactBatchResult``) into one journal entry, and neither result type is
    a superset of the other. ``Sequence[OpIn]`` (covariant) rather than
    ``list[OpIn]`` for the same reason ``hydration.serialize_ops`` uses it:
    the model-only caller passes a ``list[ModelOpIn]``, which is not a
    ``list[OpIn]`` under list invariance.

    Only persists when the project actually has a durable model row (an
    in-memory-only session has none yet — it persists a baseline when it is installed). Keeps DB model_rev in lockstep with the
    just-bumped session.model_rev.

    The keyword-only ``_commit_id``/``_message``/``_validation_error_count``/
    ``_issues`` parameters are optional metadata carried by the structured
    commit endpoint (``POST /commits``); a caller that omits them gets an
    append-only row with no message and no issues.

    ``_from_metamodel_id``/``_to_metamodel_id`` are the rebind FK columns: a
    ``metamodel.rebind`` op in the batch sets both, and every reader keyed
    off them — the staleness guard's unconditional-conflict branch,
    ``content.first_rebind_after``, history's ``is_rebind``,
    ``commit_diff``'s metamodel arm — is what MAKES a journal row a rebind.

    ``_entity_states`` is ``capture_entity_states(model, res)`` for the
    applied batch — the diff reader's journal-only input; None (over-cap or
    a writer that has no model batch) means the reader reconstructs.
    ``_state_digest`` is the session's state digest after the batch.

    Returns True if a durable row existed and the commit was persisted,
    False when the project has no model row (in-memory-only session)."""
    if content.get_model_row(db, project_id) is None:
        return False
    content.append_commit(
        db,
        project_id,
        rev=rev,
        commit_id=_commit_id or uuid.uuid4().hex,
        author_id=author_id,
        ops=serialize_ops(ops),
        inverse_ops=serialize_ops(inverse_ops),
        id_map=dict(id_map),
        message=_message,
        validation_error_count=_validation_error_count,
        issues=_issues or [],
        from_metamodel_id=_from_metamodel_id,
        to_metamodel_id=_to_metamodel_id,
        entity_states=_entity_states,
        state_digest=_state_digest,
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
    return True


def _maybe_periodic_snapshot(
    db: DbSession, project_id: str, session: Session, rev: int
) -> None:
    """Schedule a full-model snapshot every settings.snapshot_every commits so
    the hydration replay tail stays bounded for a hot, never-evicted session
    (on-evict + baseline snapshots otherwise leave it unbounded). The write
    happens on the snapshot job's thread, off this request's critical
    section; ``snapshot_sync`` (tests) runs it inline instead."""
    every = get_settings().snapshot_every
    if every > 0 and rev % every == 0:
        schedule_periodic_snapshot(project_id, session)
