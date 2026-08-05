"""Artifact-op plumbing (Phase 1 artefacts revamp).

Artifacts are materialized DB rows, not model content, so their ops must
never reach the model applier (routes/ops.py::_apply_one). ``split_ops`` is
the single chokepoint every batch passes through into ``apply_artifact_ops``/
``validate_artifact_ops`` below, the DB-side applier. ``routes/commits.py``
is the caller: ``POST /commits/preview`` validates artifact ops dry, and
``POST /commits`` applies them alongside the model half under the write mutex
(it owns the transaction — see ``create_commit``'s atomicity note)."""

from __future__ import annotations

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
from .schemas import (
    ArtifactOpIn,
    CreateArtifactOp,
    DeleteArtifactOp,
    ModelOpIn,
    OpIn,
    UpdateArtifactOp,
)

#: kind-tags of artifact ops, for raw journal dicts (Commit.ops JSON).
ARTIFACT_OP_KINDS = frozenset({"create_artifact", "update_artifact", "delete_artifact"})


def split_ops(ops: Sequence[OpIn]) -> tuple[list[ModelOpIn], list[ArtifactOpIn]]:
    """Separate a mixed batch into (model ops, artifact ops), order-preserving
    within each family. The families are independent (artifact payloads may
    REFERENCE model ids, but tolerantly), so relative cross-family order
    carries no meaning."""
    model_ops: list[ModelOpIn] = []
    artifact_ops: list[ArtifactOpIn] = []
    for op in ops:
        if isinstance(op, (CreateArtifactOp, UpdateArtifactOp, DeleteArtifactOp)):
            artifact_ops.append(op)
        else:
            model_ops.append(op)
    return model_ops, artifact_ops


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

#: mirrors routes/ops.py TEMP_ID_PREFIX (same precedent as locking.py's copy)
_TEMP_ID_PREFIX = "tmp_"


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
    spec: ArtifactKindSpec, kind: ArtifactKind, payload: dict[str, Any], *, restore: bool
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
        raise HTTPException(status_code=422, detail=f"no artifact with id {artifact_id!r}")
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


def _header_dict(row: ArtifactRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "kind": row.kind.value,
        "name": row.name,
        "artifact_rev": row.artifact_rev,
    }


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
            if op.temp_id.startswith(_TEMP_ID_PREFIX):
                artifact_id = uuid.uuid4().hex
                res.id_map[op.temp_id] = artifact_id
            elif restore:
                artifact_id = op.temp_id  # reinstate the exact id
            else:
                raise HTTPException(
                    status_code=422,
                    detail=f"create_artifact temp_id {op.temp_id!r} must start "
                    f"with {_TEMP_ID_PREFIX!r}",
                )
            try:
                row = content.create_artifact(
                    db, project_id, kind=kind, name=op.name, payload=payload,
                    updated_by=user_id, artifact_id=artifact_id,
                )
            except IntegrityError as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"a {kind.value} named {op.name!r} already exists",
                ) from exc
            tracker.claim(kind, op.name, row.id)
            res.inverse_units.append([DeleteArtifactOp(kind="delete_artifact", id=row.id)])
            res.canonical_ops.append(
                op.model_copy(update={"temp_id": row.id, "payload": payload})
            )
            res.changed_ids[row.id] = None
        elif isinstance(op, UpdateArtifactOp):
            row, update_payload = _check_update(
                db, project_id, op, tracker, res.id_map, restore=restore
            )
            inverse = UpdateArtifactOp(
                kind="update_artifact", id=row.id, name=row.name,
                payload=dict(row.payload),
            )
            old_name = row.name
            try:
                content.update_artifact(
                    db, row, expected_rev=row.artifact_rev, name=op.name,
                    payload=update_payload, updated_by=user_id,
                )
            except IntegrityError as exc:
                raise HTTPException(
                    status_code=422,
                    detail=f"a {row.kind.value} named {op.name!r} already exists",
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
                        kind="create_artifact", temp_id=row.id,
                        artifact_kind=row.kind.value, name=row.name,
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


def validate_artifact_ops(db: DbSession, project_id: str, ops: list[ArtifactOpIn]) -> None:
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
            kind, _payload = _check_create(db, project_id, op, tracker, {}, restore=False)
            tracker.claim(kind, op.name, op.temp_id)
        elif isinstance(op, UpdateArtifactOp):
            row, _update_payload = _check_update(db, project_id, op, tracker, {}, restore=False)
            if op.name is not None and op.name != row.name:
                tracker.free(row.kind, row.name)
                tracker.claim(row.kind, op.name, row.id)
        elif isinstance(op, DeleteArtifactOp):
            row = _check_delete(db, project_id, op)
            tracker.free(row.kind, row.name)
        else:
            assert_never(op)
