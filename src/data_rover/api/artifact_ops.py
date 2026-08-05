"""Artifact-op plumbing (Phase 1 artefacts revamp).

Artifacts are materialized DB rows, not model content, so their ops must
never reach the model applier (routes/ops.py::_apply_one). ``split_ops`` is
the single chokepoint every batch passes through; the applier itself lands
with the commit wiring (see this module's growth in the same plan)."""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, assert_never

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy.orm import Session as DbSession

from . import content
from .artifact_kinds import get_spec
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


def _spec_or_422(kind: ArtifactKind):
    spec = get_spec(kind)
    if spec is None:
        raise HTTPException(
            status_code=422,
            detail=f"artifact kind {kind.value!r} is not supported yet",
        )
    return spec


def _validated_payload(
    spec, kind: ArtifactKind, payload: dict[str, Any], *, restore: bool
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


def _check_clash(
    db: DbSession, project_id: str, kind: ArtifactKind, name: str, own_id: str | None
) -> None:
    clash = content.find_artifact(db, project_id, kind, name)
    if clash is not None and clash.id != own_id:
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
    like the model applier's restore stance. A recreated row's artifact_rev
    restarts at 1 (ArtifactRow.artifact_rev's column default) rather than
    continuing from where the deleted row left off — the OCC ticker resets
    with the row's identity, unlike model-element revs, which are carried
    explicitly across a delete/recreate cycle via CreateElementOp's implicit
    reset-to-default too. There is nothing to preserve here: artifact_rev's
    only job is stale-precondition detection against the CURRENT row."""
    res = ArtifactBatchResult(id_map=dict(id_map or {}))
    for op in ops:
        if isinstance(op, CreateArtifactOp):
            kind = ArtifactKind(op.artifact_kind)
            spec = _spec_or_422(kind)
            payload = _resolve_json(op.payload, res.id_map)
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
            payload = _validated_payload(spec, kind, payload, restore=restore)
            if not restore:
                _check_clash(db, project_id, kind, op.name, own_id=None)
            row = content.create_artifact(
                db, project_id, kind=kind, name=op.name, payload=payload,
                updated_by=user_id, artifact_id=artifact_id,
            )
            res.inverse_units.append([DeleteArtifactOp(kind="delete_artifact", id=row.id)])
            res.canonical_ops.append(
                op.model_copy(update={"temp_id": row.id, "payload": payload})
            )
            res.changed_ids[row.id] = None
        elif isinstance(op, UpdateArtifactOp):
            row = _require_row(db, project_id, op.id)
            if op.artifact_rev is not None and op.artifact_rev != row.artifact_rev:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "artifact was modified by someone else",
                        "current_rev": row.artifact_rev,
                    },
                )
            inverse = UpdateArtifactOp(
                kind="update_artifact", id=row.id, name=row.name,
                payload=dict(row.payload),
            )
            payload = op.payload
            if payload is not None:
                spec = _spec_or_422(row.kind)
                payload = _validated_payload(
                    spec, row.kind, _resolve_json(payload, res.id_map), restore=restore
                )
            if op.name is not None and op.name != row.name and not restore:
                _check_clash(db, project_id, row.kind, op.name, own_id=row.id)
            content.update_artifact(
                db, row, expected_rev=row.artifact_rev, name=op.name,
                payload=payload, updated_by=user_id,
            )
            res.inverse_units.append([inverse])
            res.canonical_ops.append(
                op.model_copy(update={"payload": payload, "artifact_rev": None})
            )
            res.changed_ids[row.id] = None
        elif isinstance(op, DeleteArtifactOp):
            row = _require_row(db, project_id, op.id)
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
            content.delete_artifact(db, row)
            res.canonical_ops.append(op)
            res.changed_ids.pop(row.id, None)
        else:
            assert_never(op)
    return res


def validate_artifact_ops(db: DbSession, project_id: str, ops: list[ArtifactOpIn]) -> None:
    """Dry preview validation: payload adapters + existence + preconditions +
    name clashes — WITHOUT writing anything. Mirrors what apply would reject."""
    for op in ops:
        if isinstance(op, CreateArtifactOp):
            kind = ArtifactKind(op.artifact_kind)
            spec = _spec_or_422(kind)
            _validated_payload(spec, kind, op.payload, restore=False)
            _check_clash(db, project_id, kind, op.name, own_id=None)
        elif isinstance(op, UpdateArtifactOp):
            row = _require_row(db, project_id, op.id)
            if op.artifact_rev is not None and op.artifact_rev != row.artifact_rev:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "artifact was modified by someone else",
                        "current_rev": row.artifact_rev,
                    },
                )
            if op.payload is not None:
                spec = _spec_or_422(row.kind)
                _validated_payload(spec, row.kind, op.payload, restore=False)
            if op.name is not None and op.name != row.name:
                _check_clash(db, project_id, row.kind, op.name, own_id=row.id)
        elif isinstance(op, DeleteArtifactOp):
            _require_row(db, project_id, op.id)
        else:
            assert_never(op)
