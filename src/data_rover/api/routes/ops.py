"""POST /model/ops and POST /model/undo — the delta mutation protocol.

The session model is the source of truth and clients mutate it by sending
small op batches (mirroring the frontend op union in
``frontend/src/lib/state/ops.ts``) instead of pushing whole-model snapshots.
Each accepted batch returns a delta (changed/deleted entities + validation-
issue delta), bumps ``session.model_rev`` once, and is appended to
``session.op_log`` so /model/undo can walk history backwards.

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
seed it; a session whose load endpoint already seeded the store at load
time pays nothing here.

Undo and rev counters
---------------------
Undo pops the last batch and applies its ``inverse_ops`` through the same
machinery (in restore mode, so original entity ids are reinstated exactly
via ``Model.restore_element`` / ``restore_relationship``). The undo itself
is popped from the in-memory op_log (so repeated undos walk back through
in-memory history), but with durable persistence each undo ALSO appends a
compensating forward commit to the journal (append-only; ``model_rev`` moves
forward) so hydration replays to the post-undo state.

A batch recorded by POST /commits can span all four content families, so
undo splits the inverse ops and replays the artifact half through
``artifact_ops.apply_artifact_ops``, the view half through
``view_ops.apply_view_ops_atomic`` (both in restore mode), and — LAYOUT ops
only — the metamodel half through ``metamodel_ops.apply_metamodel_ops``: one
compensating commit covers all four, and every failure path unwinds every
half that was live (in-memory model rollback + ``rollback_view`` +
``db.rollback()``) AND pushes the popped batch back so undo history is never
silently eaten. A popped batch whose metamodel half carries a
``metamodel.rebind`` is refused outright with a 409 (see the 409 branch's
own comment for why) rather than replayed —
restore-mode model inverses are schema-checked at the core mutation boundary,
so no single replay order is correct across a schema swap in either
direction. The view blob (when touched) rides the SAME DB transaction as the
compensating Commit row — see ``_persist_undo_commit``'s caller below, which
stages it inside the same try/except for the same reason ``create_commit``
does (a staging failure must not escape with ``model_rev`` already bumped and
the batch already off the op_log).

Undo restores entity STATE (ids, types, endpoints, properties) but per-entity
``rev`` counters continue forward: nothing uses ``rev`` for conflict detection
(CR matching explicitly ignores it, see ``core/model/change_request.py``), it
is only a change ticker.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, assert_never

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import DirtyCollector, containment_closure
from data_rover.core.validation.scope import Scope
from data_rover.core.validation.state import ValidationState

from .. import content
from ..artifact_ops import (
    apply_artifact_ops,
    artifact_delta_headers,
    artifact_op_ids,
    broadcast_artifact_events,
    split_ops,
)
from ..db import get_db
from ..db_models import User
from ..deps import Session, get_request_session, require_model
from ..hydration import serialize_ops, write_snapshot
from ..identity import get_current_user
from ..invalidation import touched_keys
from ..locking import METAMODEL_RESOURCE, artifact_resource, folder_resource
from ..metamodel_ops import MetamodelBatchResult, apply_metamodel_ops
from ..rules import (
    applies_population,
    expand_dirty,
    load_compiled_rules,
    rules_touched,
    session_pipeline,
)
from ..settings import get_settings
from ..view_ops import (
    ViewBatchResult,
    apply_view_ops_atomic,
    load_or_create_view,
    rollback_view,
    view_op_folder_ids,
)
from ..schemas import (
    TEMP_ID_PREFIX,
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ElementOut,
    IssueOut,
    ModelOpIn,
    OpIn,
    OpsRequest,
    OpsResponse,
    RelationshipOut,
    UpdateElementOp,
    UpdateRelationshipOp,
    is_reserved_id,
)
from ..session import AppliedBatch

router = APIRouter()

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

    def inverse_ops(self) -> list[ModelOpIn]:
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
        # inverse recorded BEFORE the property sets: if one of them fails,
        # rollback must delete the half-initialized element
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
        unit: list[ModelOpIn] = []
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


def _rollback(model: Model, inverse_units: list[list[ModelOpIn]]) -> None:
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


def _apply_batch(model: Model, ops: list[ModelOpIn], *, restore: bool) -> _BatchResult:
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

    Shared by every endpoint that validates against the issue store: the ops
    and commit endpoints, ``POST /model/validate`` (routes/validation.py) and
    the metamodel diff (routes/metamodel_swap.py). Load endpoints that seed
    the store at load time make this a no-op; it only does work for sessions
    populated through the legacy snapshot routes. Seeding pre-batch keeps
    the post-batch replace() delta exact.
    """
    if session.validation is None:
        state = ValidationState()
        state.set_full(session_pipeline(session).validate(model, Scope.all()))
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

    A user rule reports on the element it applies to but reads across
    relationship hops, so the dirty set is first widened to every element the
    compiled rules can reach back from this batch's own touched entities —
    otherwise an edit to a FAR element would leave the owning element's rule
    verdict stale in the store.
    """
    expand_dirty(session, model, res.dirty)
    scoped_issues = session_pipeline(session).validate(model, res.dirty.to_scope())
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
    _validation_error_count: int = 0,
    _issues: list | None = None,
    _from_metamodel_id: str | None = None,
    _to_metamodel_id: str | None = None,
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
    in-memory-only session has none yet — it persists a baseline via the
    load/upload routes). Keeps DB model_rev in lockstep with the
    just-bumped session.model_rev.

    The keyword-only ``_commit_id``/``_message``/``_validation_error_count``/
    ``_issues`` parameters are optional metadata carried by the structured
    commit endpoint (``POST /commits``); the plain ``/model/ops`` path omits
    them and gets the same defaults as before (append-only, no message/issues).

    ``_from_metamodel_id``/``_to_metamodel_id`` are the rebind FK columns: a
    ``metamodel.rebind`` op in the batch sets both, and every reader keyed
    off them — the staleness guard's unconditional-conflict branch,
    ``content.first_rebind_after``, history's ``is_rebind``,
    ``commit_diff``'s metamodel arm — is what MAKES a journal row a rebind.

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
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
    return True


def _persist_undo_commit(
    db: DbSession,
    project_id: str,
    *,
    rev: int,
    author_id: str | None,
    ops: Sequence[OpIn],
    inverse_ops: Sequence[OpIn],
    id_map: dict[str, str],
) -> bool:
    """Record an undo as a forward compensating commit (append-only journal).

    ``ops`` are the ops that reproduce the undo on replay (the applied inverse
    batch, canonicalized) and ``inverse_ops`` redo the original change. They
    arrive as explicit lists rather than a ``_BatchResult`` for the same reason
    ``_persist_commit`` does: an undone batch can span BOTH content families,
    so the model applier's result has to be merged with the artifact applier's
    (``artifact_ops.ArtifactBatchResult``) and neither type is a superset of
    the other.

    Returns True if a durable row existed and the commit was persisted,
    False when the project has no model row (in-memory-only legacy flow)."""
    if content.get_model_row(db, project_id) is None:
        return False
    content.append_commit(
        db,
        project_id,
        rev=rev,
        commit_id=uuid.uuid4().hex,
        author_id=author_id,
        ops=serialize_ops(ops),
        inverse_ops=serialize_ops(inverse_ops),
        id_map=dict(id_map),
    )
    content.set_model_rev(db, project_id, rev)
    db.commit()
    return True


def _maybe_periodic_snapshot(
    db: DbSession, project_id: str, session: Session, rev: int
) -> None:
    """Write a full-model snapshot every settings.snapshot_every commits so the
    hydration replay tail stays bounded for a hot, never-evicted session
    (on-evict + baseline snapshots otherwise leave it unbounded)."""
    every = get_settings().snapshot_every
    if every > 0 and rev % every == 0:
        write_snapshot(project_id, session, rev)


@router.post("/model/ops", response_model=None)
def apply_ops(
    payload: OpsRequest,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
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
    model_ops, artifact_ops, view_ops, metamodel_ops = split_ops(payload.ops)
    if artifact_ops:
        # The legacy unlocked path is model-only FOREVER: artifact edits go
        # through POST /commits (lock-verified) or legacy PUT /artifacts.
        raise HTTPException(
            status_code=422,
            detail="artifact ops are not supported on /model/ops; use /commits",
        )
    if view_ops:
        raise HTTPException(
            status_code=422,
            detail="view ops are not supported on /model/ops; use /commits",
        )
    if metamodel_ops:
        raise HTTPException(
            status_code=422,
            detail="metamodel ops are not supported on /model/ops; use /commits",
        )
    state = _ensure_validation_seeded(session, model)
    if not payload.ops:
        # Empty batch: nothing to apply. Report the current state WITHOUT
        # bumping model_rev or recording an op_log entry — an accidental
        # empty POST must not invalidate clients or burn an undo step.
        return OpsResponse(model_rev=session.model_rev, issue_counts=state.counts())
    with session.write_mutex:
        res = _apply_batch(model, model_ops, restore=False)
        session.model_rev += 1
        if get_settings().snippet_incremental_invalidation:
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        # no else: pre-branch /model/ops relied on the rev-stamp mismatch alone
        session.record_batch(
            AppliedBatch(
                # list displays, not the raw lists: AppliedBatch is typed over
                # the full OpIn union (mixed batches land here from
                # POST /commits) and list is invariant, so a list[ModelOpIn]
                # is not a list[OpIn].
                ops=[*res.canonical_ops],
                inverse_ops=[*res.inverse_ops()],
                id_map=dict(res.id_map),
            )
        )
        try:
            persisted = _persist_commit(
                db,
                project_id,
                rev=session.model_rev,
                author_id=user.id,
                ops=res.canonical_ops,
                inverse_ops=res.inverse_ops(),
                id_map=dict(res.id_map),
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)  # undo the in-memory mutation
            session.model_rev -= 1
            # The rev moves BACKWARDS here. A concurrent lock-free
            # /tables/evaluate may already have stamped the script cell cache
            # at the higher rev (it only self-clears on a FORWARD stamp move),
            # which would brick every later write/read at the restored rev and
            # then serve values computed against this rolled-back model once a
            # LATER commit reaches that rev again.
            session.invalidate_derived_caches()
            session.op_log.pop()  # drop the batch we just recorded
            db.rollback()
            raise HTTPException(
                status_code=500, detail="failed to persist commit"
            ) from exc
        if persisted:
            _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
        return _finalize(session, state, model, res)


@router.post("/model/undo", response_model=None)
def undo(
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OpsResponse | JSONResponse:
    _, model = require_model(session)
    if not session.op_log:
        return JSONResponse(
            status_code=409,
            content={"detail": "Nothing to undo", "model_rev": session.model_rev},
        )
    state = _ensure_validation_seeded(session, model)
    with session.write_mutex:
        batch = session.op_log.pop()
        # A batch recorded by POST /commits can span all three content
        # families, so the undo replays each half through its own applier:
        # the model half in place, the artifact half staged on this request's
        # DB transaction, the view half in place on session.view (also staged
        # on this request's DB transaction once accepted — see the persist
        # step below).
        model_inv, artifact_inv, view_inv, metamodel_inv = split_ops(batch.inverse_ops)
        if any(op.kind == "metamodel.rebind" for op in metamodel_inv):
            # Restore-mode model inverses are schema-checked at the core
            # mutation boundary (_check_patch_keys + Model.set_property), so
            # replaying them across a schema swap fails whichever side of the
            # swap-back they run on — a migration batch's inverse patches name
            # OLD-schema properties (invalid once the candidate is back out)
            # while an additive batch's inverse patches name NEW-schema ones
            # (invalid before it), and no single replay order is correct in
            # both directions without a schema-independent restore mode.
            # Refused cleanly, history intact — a "new rebind back" through
            # the metamodel editor is the supported path.
            session.op_log.append(batch)
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "undo across a metamodel change is not supported; "
                    "rebind back through the metamodel editor instead",
                    "model_rev": session.model_rev,
                },
            )
        # True iff THIS request is the one that flipped session.view from
        # None to non-None via load_or_create_view — tracked exactly like
        # create_commit's own ``created_view`` so every failure/rejection path
        # below can restore it to None rather than leaving a never-persisted
        # materialization behind. A failed OR REJECTED request must be
        # externally invisible: before this undo attempt GET /view reported
        # whatever it reported, and any early return out of this block must
        # leave it reporting that again — for the genuinely-empty case, not a
        # materialized empty view with no ViewRow / view_rev to back it —
        # mirrors create_commit's own created_view guard, which exists for
        # the identical reason on the auto-create path.
        created_view = False
        # Resolve the view ONCE, before the peer-lease guard below reads it:
        # ``view_op_folder_ids`` degrades its delete_folder/move_folder
        # subtree-and-current-parent expansion to a bare single-resource id
        # when ``view`` is None (mirroring ``required_locks``'s own
        # None-view degradation) — so undoing while session.view is COLD
        # (e.g. a cold/evicted session's cache miss, which leaves
        # ``ViewRow`` intact — see ``load_or_create_view``'s docstring)
        # would derive the guard's resource set against an ABSENT tree while
        # the applier below goes on to mutate the REAL, hydrated one,
        # letting a peer's lease on a child go unnoticed for the case where
        # session.view was already warm. Guarded on
        # `view_inv` (an inverse batch with no view ops needs no view at
        # all) and wrapped so a raise here — DB error, e.g. — re-pushes the
        # JUST-POPPED batch before propagating: nothing else in this request
        # has touched anything yet, but the pop above already has, and an
        # unre-pushed pop is a silently lost undo slot.
        if view_inv and session.view is None:
            try:
                session.view = load_or_create_view(db, project_id)
            except Exception:
                session.op_log.append(batch)
                raise
            created_view = True
        # The MODEL half of this route stays deliberately unlocked (the
        # documented migration-window stance until the frontend moves to
        # check-out/commit). The ARTIFACT, VIEW and (layout-only, by this
        # point) METAMODEL halves cannot: artifact rows, the view blob and the
        # layout blob are ONLY ever protected by their `art:`/`folder:`/`mm`
        # leases — there is no per-request write_mutex ordering and no rev to
        # conflict on — so replaying an artifact/view/layout inverse over a
        # peer's checked-out resource would void, from this side, exactly the
        # guarantee POST /commits and the legacy artifact CRUD routes enforce
        # on theirs. Refuse instead, and push the batch BACK so a refusal
        # never eats undo history. ``view_op_folder_ids`` mostly over-reports
        # on purpose (a create's temp/parent id, both ends of a move) — a
        # spurious id can only produce a conservative 409, never hide a held
        # lease — but delete_folder/move_folder need ``session.view`` (the
        # CURRENT, pre-undo-application, just-resolved-above state) to
        # resolve the subtree/current-parent ids the op itself doesn't name
        # (see its docstring).
        peer_resources = (
            [artifact_resource(aid) for aid in artifact_op_ids(artifact_inv)]
            + [
                folder_resource(fid)
                for fid in view_op_folder_ids(session.view, view_inv)
            ]
            # metamodel_inv here is layout-only (a rebind-carrying batch was
            # already refused above) — the ``mm`` lease is the layout's only
            # concurrency control, the same honor rule as ``art:``/``folder:``.
            + ([METAMODEL_RESOURCE] if metamodel_inv else [])
        )
        peer_held = session.lock_table.peer_leases(
            peer_resources, user.id, now=time.monotonic()
        )
        if peer_held:
            session.op_log.append(batch)
            if created_view:
                # this request's own hydration must not leak into a REJECTED
                # (409) response's visible state — see created_view's
                # docstring above.
                session.view = None
            return JSONResponse(
                status_code=409,
                content={
                    "detail": "resource is checked out by someone else",
                    "model_rev": session.model_rev,
                    "conflicts": [
                        {
                            "resource_id": le.resource_id,
                            "mode": le.mode.value,
                            "holder_id": le.holder,
                        }
                        for le in peer_held
                    ],
                },
            )
        try:
            res = _apply_batch(model, model_inv, restore=True)
        except Exception:
            session.op_log.append(batch)  # _apply_batch already rolled back
            if created_view:
                session.view = None  # see created_view's docstring above
            raise
        try:
            # restore mode on all three halves: exact ids are reinstated and
            # the already-accepted state is replayed without re-validation.
            art_res = apply_artifact_ops(
                db, project_id, artifact_inv, user_id=user.id, restore=True
            )
        except Exception:
            # Broad on purpose, mirroring create_commit's artifact branch: the
            # expected rejections are HTTPException 422/409 (a peer deleted or
            # renamed the row this undo wants back), but an UNforeseen error
            # must not be the one case that leaves the model half-undone.
            # Undo BOTH halves and re-push the batch so undo history survives.
            _rollback(model, res.inverse_units)
            session.invalidate_derived_caches()  # rolled back in place
            session.op_log.append(batch)
            if created_view:
                session.view = None  # see created_view's docstring above
            db.rollback()  # discard staged artifact rows
            raise
        view_res: ViewBatchResult | None = None
        # Every view writer (POST /commits) is lock-verified and journaled,
        # so the exception handling below is a general backstop: it should
        # never see a silently-wrong inverse applied over a view the caller
        # has since replaced.
        if view_inv:
            if session.view is None:
                # Defensive fallback only: the resolve-view block near the
                # top of this function already hydrated/auto-created
                # session.view whenever view_inv is non-empty, so this branch
                # is dead in the ordinary single-request case; nothing else
                # can null session.view mid-request. Same load_or_create_view
                # call, same rationale (a ViewRow that exists IS the view —
                # see its docstring).
                session.view = load_or_create_view(db, project_id)
                created_view = True
            try:
                view_res = apply_view_ops_atomic(session.view, view_inv, restore=True)
            except Exception:
                # mirror the artifact branch's stance: never leave the model
                # or artifact halves applied. apply_view_ops_atomic already
                # rolled its own applied prefix back internally (see its
                # docstring), so there is no separate rollback_view call here
                # — only a failure raised AFTER it succeeded needs one (the
                # persist-failure branch below).
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                if created_view:
                    session.view = None  # unwind the auto-create too — see above
                session.op_log.append(batch)
                db.rollback()  # discard staged artifact rows
                raise
        # Apply the metamodel half LAST, after the view half — layout-only by
        # construction here (the rebind arm is unreachable: the 409 above
        # already filtered any batch whose metamodel_inv carries a rebind, so
        # ``mm_res.rebound`` is always False and ``apply_metamodel_ops`` never
        # touches session.metamodel/model.metamodel/model.indexes on this
        # path). No lock-check gate here — that already happened above via
        # ``peer_resources``/``peer_held`` (the ``mm`` lease is HONORED, not
        # verified, the same rule ``art:``/``folder:`` leases follow on this
        # legacy route) — this call only STAGES the layout blob rewrite on the
        # request's DB transaction. Failure here (a DB error; there is no
        # validation to fail on a bare move) unwinds every half already
        # applied — model in place, view in place (if touched) — before
        # re-raising, mirroring the artifact/view branches above: db.rollback()
        # discards the staged layout row along with any staged artifact rows.
        mm_res: MetamodelBatchResult | None = None
        if metamodel_inv:
            try:
                mm_res = apply_metamodel_ops(db, project_id, session, metamodel_inv)
            except Exception:
                _rollback(model, res.inverse_units)
                session.invalidate_derived_caches()
                if view_res is not None:
                    assert session.view is not None
                    rollback_view(session.view, view_res.inverse_units)
                if created_view:
                    session.view = None
                session.op_log.append(batch)
                db.rollback()
                raise
        session.model_rev += 1
        if get_settings().snippet_incremental_invalidation:
            session.evict_touched_caches(touched_keys(model, model.metamodel, res))
        # no else: pre-branch /model/ops relied on the rev-stamp mismatch alone
        # append-only journal: the undo is a NEW forward commit whose ops are
        # the inverse batch, so hydration replays to the post-undo state and
        # model_rev moves up (revert reuses this same shape). ONE entry per
        # undo, spanning all four families: model ops first, then artifact
        # ops, then view ops, then metamodel ops. Metamodel LAST here mirrors
        # ``create_commit``'s own FORWARD list (see its comment) — but note
        # this is purely for symmetry, not the load-bearing reason that
        # governs THAT list's INVERSE half: this route never journals a
        # rebind (the 409 above refuses any batch whose metamodel_inv carries
        # one), so metamodel_inv here is always layout-only and carries no
        # schema dependency on the other three families in either direction.
        # Position genuinely carries no meaning on replay: hydration skips the
        # metamodel family outright (materialized heads), and the other three
        # are mutually independent (see split_ops) — so it stays last only to
        # avoid drifting from the established convention.
        canonical_ops: list[OpIn] = [
            *res.canonical_ops,
            *art_res.canonical_ops,
            *(view_res.canonical_ops if view_res else []),
            *(mm_res.canonical_ops if mm_res else []),
        ]
        inverse_ops: list[OpIn] = [
            *res.inverse_ops(),
            *art_res.inverse_ops(),
            *(view_res.inverse_ops() if view_res else []),
            *(mm_res.inverse_ops() if mm_res else []),
        ]
        # mm_res contributes no id_map: layout ops mint no ids (mirrors
        # create_commit's merged_id_map comment).
        merged_id_map = {
            **res.id_map,
            **art_res.id_map,
            **(view_res.id_map if view_res else {}),
        }
        try:
            # The view blob (when touched) is staged INSIDE this same try, on
            # the same DB transaction _persist_undo_commit's own db.commit()
            # will flush — so the view row and the compensating Commit row
            # land or roll back together. It MUST be inside the try: staging
            # is a db.flush() (content.upsert_single_view), which can raise on
            # its own (FK/constraint/connection error) — the same failure
            # class this try/except exists to catch (mirrors create_commit's
            # step e).
            if view_res is not None and view_res.canonical_ops:
                assert session.view is not None
                content.upsert_single_view(
                    db,
                    project_id,
                    name=session.view.name,
                    blob=session.view.model_dump_json(),
                )
            persisted = _persist_undo_commit(
                db,
                project_id,
                rev=session.model_rev,
                author_id=user.id,
                ops=canonical_ops,
                inverse_ops=inverse_ops,
                id_map=merged_id_map,
            )
        except Exception as exc:
            _rollback(model, res.inverse_units)  # undo the in-memory mutation
            session.model_rev -= 1
            session.invalidate_derived_caches()  # rev moved BACK; see apply_ops
            if view_res is not None:
                assert session.view is not None
                rollback_view(session.view, view_res.inverse_units)
            if created_view:
                session.view = None  # unwind the auto-create too — see above
            session.op_log.append(batch)  # re-push the batch so undo history is intact
            db.rollback()  # also discards the staged artifact + view + layout rows
            raise HTTPException(
                status_code=500, detail="failed to persist commit"
            ) from exc
        if (artifact_inv or view_inv or metamodel_inv) and not persisted:
            # No durable model row (in-memory-only legacy project), so
            # _persist_undo_commit skipped its db.commit() — but the restored/
            # removed artifact rows, the view blob and the staged layout row
            # are real DB state that must not vanish when the request session
            # closes (mirrors create_commit's same guard).
            db.commit()
        if persisted:
            _maybe_periodic_snapshot(db, project_id, session, session.model_rev)
        # artifact feed events, shared with POST /commits step h so a peer
        # cannot tell an undo's artifact event from a commit's. Inside the
        # mutex, like every other broadcast site (enqueue order == rev order).
        headers, created_ids = artifact_delta_headers(db, art_res)
        broadcast_artifact_events(session.hub, headers, created_ids, art_res.deleted)
        # Recompile the user rule sets when the artifact half put a rules
        # artifact back (or took one away), and widen the dirty set to the
        # applies-to population of BOTH the outgoing and the incoming sets so
        # _finalize drops the issues the undone rules minted as well as adding
        # the restored ones. Mirrors create_commit's step b4 — except the swap
        # sits AFTER the durable commit rather than under an unwind ledger:
        # every rollback path above has already been passed, so no failure can
        # strand the session on rules the DB no longer backs. The metamodel
        # cannot have changed here (a rebind-carrying batch is refused above),
        # so model.metamodel is still the one the prior set compiled against.
        if rules_touched(db, artifact_inv, art_res):
            prior_compiled = session.compiled_rules
            session.compiled_rules = load_compiled_rules(
                db, project_id, model.metamodel
            )
            res.dirty.update(
                applies_population(model, prior_compiled, session.compiled_rules)
            )
        return _finalize(session, state, model, res)
