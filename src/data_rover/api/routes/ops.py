"""POST /model/ops and POST /model/undo — the delta mutation protocol.

Phase C1 of the large-model overhaul: the session model is the source of
truth and clients mutate it by sending small op batches (mirroring the
frontend op union in ``frontend/src/lib/state/ops.ts``) instead of pushing
whole-model snapshots. Each accepted batch returns a delta (changed/deleted
entities + validation-issue delta), bumps ``session.model_rev`` once, and is
appended to ``session.op_log`` so /model/undo can walk history backwards.

Atomicity without deep copies
-----------------------------
Batches are atomic, but the model is NOT deep-copied per request (it can be
~80 MB): ops are applied directly to the live session model while inverse
ops are collected per completed mutation. If an op fails mid-batch, the
collected inverses are applied in reverse to roll the live model back to its
pre-batch state, and the request fails with 422. This trades a tiny rollback
path for O(batch) request cost instead of O(model).

Validation seeding
------------------
Incremental validation needs a full-run baseline (``session.validation``).
If none exists yet, one full validation of the PRE-batch model is run to
seed it — a transitional cost: the C3 load endpoints will seed the store at
load time, making this a no-op in practice.

Undo and rev counters
---------------------
Undo pops the last batch and applies its ``inverse_ops`` through the same
machinery (in restore mode, so original entity ids are reinstated exactly
via ``Model.restore_element`` / ``restore_relationship``). The undo itself
is NOT pushed to the op log, so repeated undos walk further back through
history. Undo restores entity STATE (ids, types, endpoints, properties) but
per-entity ``rev`` counters continue forward: nothing uses ``rev`` for
conflict detection (CR matching explicitly ignores it, see
``core/model/change_request.py``), it is only a change ticker.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# typing.assert_never exists from 3.11, but pyright checks against the 3.10
# floor pinned in pyrightconfig.json — typing_extensions works everywhere
from typing_extensions import assert_never

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import DirtyCollector, containment_closure
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

from ..deps import Session, get_session, require_model
from ..schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ElementOut,
    IssueOut,
    OpIn,
    OpsRequest,
    OpsResponse,
    RelationshipOut,
    UpdateElementOp,
    UpdateRelationshipOp,
)
from ..session import AppliedBatch

router = APIRouter()

#: Client-generated provisional ids carry this prefix (mirrors
#: ``TEMP_ID_PREFIX`` in ``frontend/src/lib/state/ops.ts``). A create op whose
#: ``temp_id`` lacks the prefix is rejected on the public endpoint; in restore
#: mode (undo/rollback) it means "reinstate this exact canonical id".
TEMP_ID_PREFIX = "tmp_"


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
    """

    canonical_ops: list[OpIn] = field(default_factory=list)
    #: one inner list per completed mutation, in application order; an inner
    #: list's internal order matters (delete-element inverses recreate
    #: elements before relationships) and must never be reversed
    inverse_units: list[list[OpIn]] = field(default_factory=list)
    id_map: dict[str, str] = field(default_factory=dict)
    dirty: DirtyCollector = field(default_factory=DirtyCollector)
    changed_element_ids: dict[str, None] = field(default_factory=dict)
    changed_relationship_ids: dict[str, None] = field(default_factory=dict)
    deleted_element_ids: dict[str, None] = field(default_factory=dict)
    deleted_relationship_ids: dict[str, None] = field(default_factory=dict)

    def mark_element_changed(self, element_id: str) -> None:
        self.changed_element_ids[element_id] = None
        self.deleted_element_ids.pop(element_id, None)

    def mark_relationship_changed(self, rel_id: str) -> None:
        self.changed_relationship_ids[rel_id] = None
        self.deleted_relationship_ids.pop(rel_id, None)

    def mark_element_deleted(self, element_id: str) -> None:
        self.deleted_element_ids[element_id] = None
        self.changed_element_ids.pop(element_id, None)

    def mark_relationship_deleted(self, rel_id: str) -> None:
        self.deleted_relationship_ids[rel_id] = None
        self.changed_relationship_ids.pop(rel_id, None)

    def inverse_ops(self) -> list[OpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def _check_patch_keys(
    model: Model, type_name: str, *, element: bool, patch: dict[str, Any]
) -> None:
    """Reject unknown patch keys upfront so a patch can never fail half-applied
    (set/delete_property on an attached entity only fails on unknown keys)."""
    if element:
        defs = model.metamodel.effective_element_properties(type_name)
    else:
        defs = model.metamodel.effective_relationship_properties(type_name)
    valid = {p.name for p in defs}
    for key in patch:
        if key not in valid:
            raise KeyError(f"{type_name!r} has no property {key!r}")


def _apply_one(model: Model, op: OpIn, res: _BatchResult, *, restore: bool) -> None:
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
            element = d.create_element(model, op.type_name)
            res.id_map[op.temp_id] = element.id
        elif restore:
            element = model.restore_element(op.temp_id, op.type_name)
            d.after_element_create(model, element.id)
        else:
            raise ValueError(
                f"create_element temp_id {op.temp_id!r} must start with "
                f"{TEMP_ID_PREFIX!r}"
            )
        # inverse recorded BEFORE the property sets: if one of them fails,
        # rollback must delete the half-initialized element
        res.inverse_units.append(
            [DeleteElementOp(kind="delete_element", id=element.id)]
        )
        for key, value in props.items():
            d.set_property(model, element, key, value)
        res.canonical_ops.append(
            op.model_copy(update={"temp_id": element.id, "properties": props})
        )
        res.mark_element_changed(element.id)
        return

    if isinstance(op, UpdateElementOp):
        eid = res.id_map.get(op.id, op.id)
        element = model.get_element(eid)
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
        unit: list[OpIn] = []
        for ce in closure:
            e = model.elements[ce]
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
            rel = d.connect(model, op.type_name, source_id, target_id)
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
                }
            )
        )
        res.mark_relationship_changed(rel.id)
        return

    if isinstance(op, UpdateRelationshipOp):
        rid = res.id_map.get(op.id, op.id)
        rel = model.get_relationship(rid)
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


def _rollback(model: Model, inverse_units: list[list[OpIn]]) -> None:
    """Undo the completed mutations of a failed batch on the live model.

    Applies the recorded inverse units newest-first (preserving each unit's
    internal order) in restore mode. The dirty/delta bookkeeping is thrown
    away — the request fails, so no validation or response delta is built.
    """
    scratch = _BatchResult()
    for unit in reversed(inverse_units):
        for op in unit:
            _apply_one(model, op, scratch, restore=True)


def _error_detail(exc: BaseException) -> str:
    # KeyError's str() wraps the message in quotes; strip them like the
    # app-level handler in api/errors.py does
    return str(exc).strip("'\"") if isinstance(exc, KeyError) else str(exc)


def _apply_batch(model: Model, ops: list[OpIn], *, restore: bool) -> _BatchResult:
    """Apply *ops* atomically to the live model.

    On ANY op failure the completed mutations are rolled back via their
    recorded inverses — the model, its indexes, and the validation store are
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
        _rollback(model, res.inverse_units)
        if isinstance(exc, (KeyError, ValueError)):
            raise HTTPException(status_code=422, detail=_error_detail(exc)) from exc
        raise
    return res


def _ensure_validation_seeded(session: Session, model: Model) -> ValidationState:
    """Make sure a full-run issue baseline exists BEFORE mutating.

    Transitional: once the C3 load endpoints seed the store at load time
    this only ever runs for sessions populated through legacy snapshot
    routes. Seeding pre-batch keeps the post-batch replace() delta exact.
    """
    if session.validation is None:
        state = ValidationState()
        state.set_full(default_pipeline().validate(model, Scope.all()))
        session.validation = state
    return session.validation


def _finalize(
    session: Session, state: ValidationState, model: Model, res: _BatchResult
) -> OpsResponse:
    """Scoped re-validation + issue-store splice + response assembly.

    ``state`` is the seeded issue store returned by
    ``_ensure_validation_seeded`` (threaded through instead of re-read from
    the session). ``session.model_rev`` must already be bumped.
    Deterministic ordering throughout: changed/deleted ids in first-touch op
    application order, issues in dirty-set / scoped-pipeline order.
    """
    scoped_issues = default_pipeline().validate(model, res.dirty.to_scope())
    delta = state.replace(res.dirty.ids, scoped_issues)
    return OpsResponse(
        model_rev=session.model_rev,
        id_map=dict(res.id_map),
        changed_elements=[
            ElementOut.from_core(model.elements[eid]) for eid in res.changed_element_ids
        ],
        changed_relationships=[
            RelationshipOut.from_core(model.relationships[rid])
            for rid in res.changed_relationship_ids
        ],
        deleted_element_ids=list(res.deleted_element_ids),
        deleted_relationship_ids=list(res.deleted_relationship_ids),
        issues_removed_owner_ids=delta.removed_owner_ids,
        issues_added=[IssueOut.from_core(i) for i in delta.added],
        issue_counts=state.counts(),
    )


@router.post("/model/ops", response_model=None)
def apply_ops(
    payload: OpsRequest,
    session: Session = Depends(get_session),
) -> OpsResponse | JSONResponse:
    _, model = require_model(session)
    if payload.base_rev != session.model_rev:
        return JSONResponse(
            status_code=409,
            content={
                "detail": (
                    f"base_rev {payload.base_rev} does not match current "
                    f"model_rev {session.model_rev}"
                ),
                "model_rev": session.model_rev,
            },
        )
    state = _ensure_validation_seeded(session, model)
    if not payload.ops:
        # Empty batch: nothing to apply. Report the current state WITHOUT
        # bumping model_rev or recording an op_log entry — an accidental
        # empty POST must not invalidate clients or burn an undo step.
        return OpsResponse(model_rev=session.model_rev, issue_counts=state.counts())
    res = _apply_batch(model, payload.ops, restore=False)
    session.model_rev += 1
    session.record_batch(
        AppliedBatch(
            ops=res.canonical_ops,
            inverse_ops=res.inverse_ops(),
            id_map=dict(res.id_map),
        )
    )
    return _finalize(session, state, model, res)


@router.post("/model/undo", response_model=None)
def undo(session: Session = Depends(get_session)) -> OpsResponse | JSONResponse:
    _, model = require_model(session)
    if not session.op_log:
        return JSONResponse(
            status_code=409,
            content={"detail": "Nothing to undo", "model_rev": session.model_rev},
        )
    state = _ensure_validation_seeded(session, model)
    batch = session.op_log.pop()
    try:
        res = _apply_batch(model, batch.inverse_ops, restore=True)
    except Exception:
        # _apply_batch already rolled the model back; keep history intact
        session.op_log.append(batch)
        raise
    # NOT recorded in op_log: undo walks history backwards, it does not
    # create new history (no redo in C1)
    session.model_rev += 1
    return _finalize(session, state, model, res)
