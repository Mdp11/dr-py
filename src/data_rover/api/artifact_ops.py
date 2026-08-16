"""Artifact-op plumbing (Phase 1 artefacts revamp).

Artifacts are materialized DB rows, not model content, so their ops must
never reach the model applier (routes/ops.py::_apply_one). ``split_ops`` is
the single chokepoint every batch passes through into ``apply_artifact_ops``/
``validate_artifact_ops`` below, the DB-side applier. ``routes/commits.py``
is the caller: ``POST /commits/preview`` validates artifact ops dry, and
``POST /commits`` applies them alongside the model half under the write mutex
(it owns the transaction — see ``create_commit``'s atomicity note)."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, assert_never

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from . import content
from .artifact_kinds import ArtifactKindSpec, get_spec
from .db_models import ArtifactKind, ArtifactRow
from .feed import FeedHub, artifact_event
from .schemas import (
    TEMP_ID_PREFIX,
    ArtifactHeaderOut,
    ArtifactOpIn,
    CreateArtifactOp,
    CreateFolderOp,
    DeleteArtifactOp,
    DeleteFolderOp,
    MetamodelOpIn,
    ModelOpIn,
    MoveArtifactOp,
    MoveElementOp,
    MoveFolderOp,
    MoveMetamodelNodeOp,
    OpIn,
    PlaceArtifactOp,
    PlaceElementOp,
    RebindMetamodelOp,
    RemoveArtifactOp,
    RemoveElementOp,
    RenameFolderOp,
    UpdateArtifactOp,
    ViewOpIn,
)

logger = logging.getLogger(__name__)

#: kind-tags of artifact ops, for raw journal dicts (Commit.ops JSON).
ARTIFACT_OP_KINDS = frozenset({"create_artifact", "update_artifact", "delete_artifact"})


def split_ops(
    ops: Sequence[OpIn],
) -> tuple[list[ModelOpIn], list[ArtifactOpIn], list[ViewOpIn], list[MetamodelOpIn]]:
    """Separate a mixed batch into (model, artifact, view, metamodel) ops,
    order-preserving within each family. The metamodel arm is matched
    EXPLICITLY — the trailing else is the model-applier fallthrough, and an
    op family that silently lands there reaches ``_apply_one``'s
    ``assert_never`` as a 500 instead of its own applier."""
    model_ops: list[ModelOpIn] = []
    artifact_ops: list[ArtifactOpIn] = []
    view_ops: list[ViewOpIn] = []
    metamodel_ops: list[MetamodelOpIn] = []
    for op in ops:
        if isinstance(op, (CreateArtifactOp, UpdateArtifactOp, DeleteArtifactOp)):
            artifact_ops.append(op)
        elif isinstance(op, (RebindMetamodelOp, MoveMetamodelNodeOp)):
            metamodel_ops.append(op)
        elif isinstance(
            op,
            (
                CreateFolderOp,
                RenameFolderOp,
                MoveFolderOp,
                DeleteFolderOp,
                PlaceElementOp,
                RemoveElementOp,
                MoveElementOp,
                PlaceArtifactOp,
                RemoveArtifactOp,
                MoveArtifactOp,
            ),
        ):
            view_ops.append(op)
        else:
            model_ops.append(op)
    return model_ops, artifact_ops, view_ops, metamodel_ops


def artifact_op_ids(ops: Sequence[ArtifactOpIn]) -> set[str]:
    """The artifact ROW ids a batch would write.

    A create op's ``temp_id`` is included because in RESTORE mode (undo) it is
    not provisional at all — it is the exact canonical id being reinstated, so
    a peer's lease on it is just as meaningful as on an update/delete target.
    Used by the peer-lease guards on the writers that are not themselves
    lock-verified (see ``LockTable.peer_leases``); ids are BARE here — callers
    namespace them with ``locking.artifact_resource`` for lease comparison.
    """
    ids: set[str] = set()
    for op in ops:
        if isinstance(op, CreateArtifactOp):
            ids.add(op.temp_id)
        elif isinstance(op, (UpdateArtifactOp, DeleteArtifactOp)):
            ids.add(op.id)
        else:
            assert_never(op)
    return ids


# ---------------------------------------------------------------------------
# Artifact op applier (Task 4) — the DB-side twin of routes/ops.py::_apply_batch
# ---------------------------------------------------------------------------
#
# Architecture: one journal, materialized heads. Artifact state lives in
# ArtifactRow.payload, not in the in-memory model, so these ops are applied
# directly to DB rows on the request's Session (flush only — the caller owns
# the transaction and commits/rolls back). The Commit journal is a read-only
# history/diff/undo source, which is why inverse ops here carry FULL PRIOR
# STATE (name + payload), never patches: a journal-only reader (undo, the
# commit-diff endpoint) must be able to reconstruct exact prior state from the
# inverse op alone, with no access to the live row.
#
# There is NO internal rollback path (contrast routes/ops.py::_apply_batch,
# which rolls the live model back via inverses on a mid-batch failure): a
# failed batch here just stops, and the caller's db.rollback() discards every
# staged row change made so far. Tasks 5/6 own that transaction boundary.


def _resolve_json(value: Any, id_map: dict[str, str]) -> Any:
    """Dict-aware port of routes/ops._resolve_value: temp ids anywhere in a
    payload (element ids in scope criteria, artifact ids in refs) are replaced
    by their canonical ids; unknown strings pass through as tolerant
    danglers."""
    if isinstance(value, str):
        return id_map.get(value, value)
    if isinstance(value, list):
        return [_resolve_json(v, id_map) for v in value]
    if isinstance(value, dict):
        return {k: _resolve_json(v, id_map) for k, v in value.items()}
    return value


@dataclass
class ArtifactBatchResult:
    """Everything one artifact-op batch produced (twin of ops._BatchResult).

    There is NO in-memory rollback path: row changes are only flushed, so the
    caller's db.rollback() discards everything on failure."""

    canonical_ops: list[ArtifactOpIn] = field(default_factory=list)
    inverse_units: list[list[ArtifactOpIn]] = field(default_factory=list)
    id_map: dict[str, str] = field(default_factory=dict)
    changed_ids: dict[str, None] = field(default_factory=dict)
    deleted: list[dict[str, Any]] = field(default_factory=list)

    def inverse_ops(self) -> list[ArtifactOpIn]:
        """Flat inverse batch: applying it front-to-back undoes this batch."""
        return [op for unit in reversed(self.inverse_units) for op in unit]


def _spec_or_422(kind: ArtifactKind) -> ArtifactKindSpec:
    spec = get_spec(kind)
    if spec is None:
        raise HTTPException(
            status_code=422,
            detail=f"artifact kind {kind.value!r} is not supported yet",
        )
    return spec


def _validated_payload(
    spec: ArtifactKindSpec,
    kind: ArtifactKind,
    payload: dict[str, Any],
    *,
    restore: bool,
) -> dict[str, Any]:
    """Adapter-validate + rerun derived metadata. Restore replays previously
    accepted state verbatim (mirrors the model applier's restore stance)."""
    if restore:
        return payload
    try:
        spec.adapter.validate_python(payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid {kind.value} payload: {exc}"
        ) from exc
    if spec.derive_metadata is not None:
        payload = dict(payload)
        spec.derive_metadata(payload)
    return payload


def _require_row(db: DbSession, project_id: str, artifact_id: str) -> ArtifactRow:
    row = content.get_artifact(db, artifact_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(
            status_code=422, detail=f"no artifact with id {artifact_id!r}"
        )
    return row


@dataclass
class _ClashTracker:
    """Batch-local name -> holder overlay, layered on top of the DB, so a
    create/rename/delete earlier in a batch is visible to a name-clash check
    on a LATER op in the SAME batch even when nothing has been written to the
    DB yet. This is what lets ``apply_artifact_ops`` and
    ``validate_artifact_ops`` agree on multi-op batches: both call the same
    ``_check_create``/``_check_update``/``_check_delete`` functions below,
    which read and update one of these trackers identically, so a sequence
    like ``[delete X, create "X's old name"]`` or ``[create "n", create "n"]``
    is judged the same way whether or not anything is actually persisted (a
    prior review caught apply and a hand-duplicated validate disagreeing on
    exactly these two shapes).

    Absent from ``holder`` means "defer to the DB". A present entry of
    ``None`` means "an earlier op in this batch freed this name (a delete, or
    a rename away from it), regardless of what the DB still says" — this is
    the case a plain DB lookup cannot see without the overlay.
    """

    holder: dict[tuple[ArtifactKind, str], str | None] = field(default_factory=dict)

    def owner(
        self, db: DbSession, project_id: str, kind: ArtifactKind, name: str
    ) -> str | None:
        key = (kind, name)
        if key in self.holder:
            return self.holder[key]
        row = content.find_artifact(db, project_id, kind, name)
        return row.id if row is not None else None

    def claim(self, kind: ArtifactKind, name: str, holder_id: str) -> None:
        self.holder[(kind, name)] = holder_id

    def free(self, kind: ArtifactKind, name: str) -> None:
        self.holder[(kind, name)] = None


def _check_clash(
    db: DbSession,
    project_id: str,
    tracker: _ClashTracker,
    kind: ArtifactKind,
    name: str,
    own_id: str | None,
) -> None:
    holder = tracker.owner(db, project_id, kind, name)
    if holder is not None and holder != own_id:
        raise HTTPException(
            status_code=422,
            detail=f"a {kind.value} named {name!r} already exists",
        )


def artifact_header(row: ArtifactRow) -> ArtifactHeaderOut:
    """The ONE artifact-row -> header projection, shared by every producer.

    It lives here rather than in ``routes/artifacts.py`` (which re-exports it
    as ``_header``) because the DELETE branch below has to capture a header
    BEFORE the row is gone, and a service module cannot import a route module
    without a cycle. One implementation is the point: the artifact feed events
    a commit emits and the ones the legacy CRUD routes emit must be
    byte-identical in shape, or a client that reads ``updated_by`` off a
    delete event works through one write path and breaks through the other.
    """
    spec = get_spec(row.kind)
    entry_points: list[str] | None = None
    if spec is not None and spec.surfaces_entry_points:
        raw = row.payload.get("entry_points")
        entry_points = (
            [e for e in raw if isinstance(e, str)] if isinstance(raw, list) else []
        )
    return ArtifactHeaderOut(
        id=row.id,
        kind=row.kind.value,
        name=row.name,
        artifact_rev=row.artifact_rev,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
        entry_points=entry_points,
    )


def _header_dict(row: ArtifactRow) -> dict[str, Any]:
    """JSON-ready pre-delete header snapshot (``ArtifactBatchResult.deleted``).

    ``mode="json"`` because these dicts go straight onto the wire as feed
    events — the same dump the legacy DELETE route broadcasts."""
    return artifact_header(row).model_dump(mode="json")


def _check_create(
    db: DbSession,
    project_id: str,
    op: CreateArtifactOp,
    tracker: _ClashTracker,
    id_map: dict[str, str],
    *,
    restore: bool,
) -> tuple[ArtifactKind, dict[str, Any]]:
    """Shared create_artifact preconditions — kind support, payload
    validation + derived-metadata rerun, batch-aware name clash. The ONE
    place both ``apply_artifact_ops`` and ``validate_artifact_ops`` reject a
    create op, so their rules cannot drift. Restore mode validates nothing
    (see ``apply_artifact_ops``'s docstring); a genuine name clash it chose
    not to pre-check here still surfaces as 422, via the IntegrityError catch
    around the actual insert in ``apply_artifact_ops`` — restore never reaches
    the DB through this function."""
    kind = ArtifactKind(op.artifact_kind)
    spec = _spec_or_422(kind)
    payload = _validated_payload(
        spec, kind, _resolve_json(op.payload, id_map), restore=restore
    )
    if not restore:
        _check_clash(db, project_id, tracker, kind, op.name, own_id=None)
    return kind, payload


def _check_update(
    db: DbSession,
    project_id: str,
    op: UpdateArtifactOp,
    tracker: _ClashTracker,
    id_map: dict[str, str],
    *,
    restore: bool,
) -> tuple[ArtifactRow, dict[str, Any] | None]:
    """Shared update_artifact preconditions — existence, rev precondition,
    payload validation, batch-aware name clash. See ``_check_create``."""
    row = _require_row(db, project_id, op.id)
    if op.artifact_rev is not None and op.artifact_rev != row.artifact_rev:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "artifact was modified by someone else",
                "current_rev": row.artifact_rev,
            },
        )
    payload = op.payload
    if payload is not None:
        spec = _spec_or_422(row.kind)
        payload = _validated_payload(
            spec, row.kind, _resolve_json(payload, id_map), restore=restore
        )
    if op.name is not None and op.name != row.name and not restore:
        _check_clash(db, project_id, tracker, row.kind, op.name, own_id=row.id)
    return row, payload


def _check_delete(db: DbSession, project_id: str, op: DeleteArtifactOp) -> ArtifactRow:
    """Shared delete_artifact precondition — existence. See ``_check_create``."""
    return _require_row(db, project_id, op.id)


def apply_artifact_ops(
    db: DbSession,
    project_id: str,
    ops: list[ArtifactOpIn],
    *,
    user_id: str | None,
    id_map: dict[str, str] | None = None,
    restore: bool = False,
) -> ArtifactBatchResult:
    """Apply artifact ops to their rows, staging changes on *db* (flush only).

    Inverse ops carry FULL prior state (name + payload), never patches — the
    journal alone must be able to answer diffs and undo. Restore mode
    reinstates exact ids and skips validation/derivation/clash checks, exactly
    like the model applier's restore stance — but a name clash it chose not to
    pre-check can still occur (a collaborator claimed the name after the
    original delete/rename this batch is undoing), so the actual
    create/update call is wrapped: a DB UNIQUE-constraint IntegrityError is
    turned into the same 422 a pre-check would have raised, instead of
    escaping as a 500.

    A recreated row's artifact_rev restarts at 1 (ArtifactRow.artifact_rev's
    column default): it is an OCC ticker scoped to the row's identity, with
    nothing to preserve across a delete/recreate cycle — its only job is
    stale-precondition detection against the CURRENT row.
    """
    res = ArtifactBatchResult(id_map=dict(id_map or {}))
    tracker = _ClashTracker()
    for op in ops:
        if isinstance(op, CreateArtifactOp):
            kind, payload = _check_create(
                db, project_id, op, tracker, res.id_map, restore=restore
            )
            if op.temp_id.startswith(TEMP_ID_PREFIX):
                artifact_id = uuid.uuid4().hex
                res.id_map[op.temp_id] = artifact_id
            elif restore:
                artifact_id = op.temp_id  # reinstate the exact id
                if content.get_artifact(db, artifact_id) is not None:
                    # The id is already taken (a double-undo, or an undo after
                    # a peer recreated the row). Pre-checked rather than left
                    # to the IntegrityError catch below: that catch is scoped
                    # to the exception TYPE, not the constraint, so a PRIMARY
                    # KEY violation would be reported as the name clash it is
                    # not — right status, actively misleading message.
                    raise HTTPException(
                        status_code=422,
                        detail=f"an artifact with id {artifact_id!r} already exists",
                    )
            else:
                raise HTTPException(
                    status_code=422,
                    detail=f"create_artifact temp_id {op.temp_id!r} must start "
                    f"with {TEMP_ID_PREFIX!r}",
                )
            try:
                row = content.create_artifact(
                    db,
                    project_id,
                    kind=kind,
                    name=op.name,
                    payload=payload,
                    updated_by=user_id,
                    artifact_id=artifact_id,
                )
            except IntegrityError as exc:
                # By elimination the only remaining constraint on this insert
                # is UNIQUE(project, kind, name) — the id collision, the other
                # candidate, was pre-checked above.
                raise HTTPException(
                    status_code=422,
                    detail=f"a {kind.value} named {op.name!r} already exists",
                ) from exc
            tracker.claim(kind, op.name, row.id)
            res.inverse_units.append(
                [DeleteArtifactOp(kind="delete_artifact", id=row.id)]
            )
            res.canonical_ops.append(
                op.model_copy(update={"temp_id": row.id, "payload": payload})
            )
            res.changed_ids[row.id] = None
        elif isinstance(op, UpdateArtifactOp):
            row, update_payload = _check_update(
                db, project_id, op, tracker, res.id_map, restore=restore
            )
            inverse = UpdateArtifactOp(
                kind="update_artifact",
                id=row.id,
                name=row.name,
                payload=dict(row.payload),
            )
            old_name = row.name
            try:
                # ``content.update_artifact`` REPLACES ``payload`` wholesale
                # (see its docstring, content.py): never mutate the row's dict
                # in place here — the inverse op above aliases the prior
                # payload through a shallow copy, so an in-place write would
                # silently corrupt the recorded inverse (and SQLAlchemy's JSON
                # change-tracking would not even fire).
                content.update_artifact(
                    db,
                    row,
                    expected_rev=row.artifact_rev,
                    name=op.name,
                    payload=update_payload,
                    updated_by=user_id,
                )
            except IntegrityError as exc:
                # An UPDATE cannot violate the PK (the row already exists under
                # that id), so this is the UNIQUE(project, kind, name) rename
                # clash — hence the name in the message. ``op.name or row.name``
                # keeps it truthful if a future caller trips the constraint on a
                # payload-only update.
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"a {row.kind.value} named {op.name or row.name!r} "
                        "already exists"
                    ),
                ) from exc
            if op.name is not None and op.name != old_name:
                tracker.free(row.kind, old_name)
                tracker.claim(row.kind, op.name, row.id)
            res.inverse_units.append([inverse])
            res.canonical_ops.append(
                op.model_copy(update={"payload": update_payload, "artifact_rev": None})
            )
            res.changed_ids[row.id] = None
        elif isinstance(op, DeleteArtifactOp):
            row = _check_delete(db, project_id, op)
            res.deleted.append(_header_dict(row))
            res.inverse_units.append(
                [
                    CreateArtifactOp(
                        kind="create_artifact",
                        temp_id=row.id,
                        artifact_kind=row.kind.value,
                        name=row.name,
                        payload=dict(row.payload),
                    )
                ]
            )
            tracker.free(row.kind, row.name)
            content.delete_artifact(db, row)
            res.canonical_ops.append(op)
            res.changed_ids.pop(row.id, None)
        else:
            assert_never(op)
    return res


def artifact_delta_headers(
    db: DbSession, res: ArtifactBatchResult
) -> tuple[list[ArtifactHeaderOut], set[str]]:
    """Project an applied batch into (changed headers, ids that are NEW).

    Every write path that lands artifact ops — ``POST /commits`` and
    ``POST /model/undo`` — needs exactly this, and their results must be
    wire-identical (a peer cannot tell an undo's artifact event from a
    commit's), so it is derived in ONE place rather than restated per route.

    Rows are RE-READ rather than projected off the ops: the applier reruns
    server-owned derived metadata (snippet entry_points) and bumps
    ``artifact_rev``, so a header must carry what actually landed. New-vs-
    updated is read off the CANONICAL ops (the applier rewrote a create's
    ``temp_id`` to the assigned id), never off the id_map — that map is seeded
    with MODEL temp ids, so keying on it would depend on the two families' temp
    ids never colliding, which nothing enforces.

    Call AFTER the transaction commits: a re-read that misses is unreachable
    (the row was written moments ago under the write mutex) and is logged
    rather than silently dropped from the response + feed.
    """
    created_ids = {
        op.temp_id for op in res.canonical_ops if isinstance(op, CreateArtifactOp)
    }
    headers: list[ArtifactHeaderOut] = []
    for artifact_id in res.changed_ids:
        row = content.get_artifact(db, artifact_id)
        if row is None:
            logger.warning(
                "artifact %s vanished between its write and delta assembly", artifact_id
            )
            continue
        headers.append(artifact_header(row))
    return headers, created_ids


def broadcast_artifact_events(
    hub: FeedHub,
    headers: Sequence[ArtifactHeaderOut],
    created_ids: set[str],
    deleted: Sequence[dict[str, Any]],
) -> None:
    """Fan an applied batch's artifact delta out to peers (twin of
    ``artifact_delta_headers``, and the other half of why both write paths
    look identical on the wire).

    The artifact library is a separate client-side store, so a commit event's
    model delta cannot carry it: peers learn about it through the same per-row
    events the legacy artifact CRUD routes emit.
    """
    for header in headers:
        action = "created" if header.id in created_ids else "updated"
        hub.broadcast(artifact_event(action, header.model_dump(mode="json")))
    for row in deleted:
        hub.broadcast(artifact_event("deleted", row))


def validate_artifact_ops(
    db: DbSession, project_id: str, ops: list[ArtifactOpIn]
) -> None:
    """Dry preview validation: payload adapters + existence + preconditions +
    name clashes — WITHOUT writing anything. Calls the exact same
    ``_check_create``/``_check_update``/``_check_delete`` functions
    ``apply_artifact_ops`` uses (always with ``restore=False`` — there is no
    restore concept in a preview), threading a ``_ClashTracker`` through the
    batch the same way, so a multi-op batch's cross-op effects (a delete
    freeing a name a later op in the SAME batch reuses, two creates in one
    batch claiming the same name) are judged identically to what
    ``apply_artifact_ops`` would actually do — this is the ONE place either
    function's rejection rules are expressed; nothing here is restated."""
    tracker = _ClashTracker()
    for op in ops:
        if isinstance(op, CreateArtifactOp):
            kind, _payload = _check_create(
                db, project_id, op, tracker, {}, restore=False
            )
            tracker.claim(kind, op.name, op.temp_id)
        elif isinstance(op, UpdateArtifactOp):
            row, _update_payload = _check_update(
                db, project_id, op, tracker, {}, restore=False
            )
            if op.name is not None and op.name != row.name:
                tracker.free(row.kind, row.name)
                tracker.claim(row.kind, op.name, row.id)
        elif isinstance(op, DeleteArtifactOp):
            row = _check_delete(db, project_id, op)
            tracker.free(row.kind, row.name)
        else:
            assert_never(op)
