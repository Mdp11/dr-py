"""Project-artifact CRUD (saved navigations and tables; `diagram`/
`diagram_kind` are unregistered and 422 on write).

Artifacts are DB rows, NOT model content, so these routes take no
`write_mutex`: they never touch the in-memory model, and that is also why
broadcasting an `artifact_event` per successful write is safe here.

Concurrency is TWO-layered:
- optimistic `artifact_rev` (PUT echoes the loaded rev; mismatch -> 409
  carrying `current_rev`); and
- the `art:<id>` LEASES `POST /commits` verifies. These routes are not
  lock-verified (they take no token and grant nothing), but they must still
  REFUSE (409) while a peer holds a lease, or the guarantee is empty in both
  directions: an editor checked out on `art:X` would find their commit
  quietly overwriting — or overwritten by — a write here they never saw.
  This route family bumps no `model_rev`, so the commit path's overlap
  backstop cannot see such a write either; this guard is the only thing
  standing there. The caller's OWN lease never blocks them (see
  `LockTable.peer_leases`).

Payloads are validated per kind on write via the `artifact_kinds` registry.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session as DbSession

from .. import content
from ..artifact_kinds import get_spec
from ..artifact_ops import artifact_header
from ..db import get_db
from ..db_models import ArtifactKind, ArtifactRow, User
from ..project_state import ProjectState, get_project_state
from ..feed import artifact_event
from ..identity import get_current_user
from ..locking import artifact_resource
from ..schemas import (
    ArtifactCreateIn,
    ArtifactListOut,
    ArtifactOut,
    ArtifactPayloadListOut,
    ArtifactPayloadOut,
    ArtifactUpdateIn,
)
from .rules import parse_result

router = APIRouter()


#: The row -> header projection lives in ``artifact_ops`` (see its docstring:
#: the artifact-op applier must capture a header before a DELETE removes the
#: row, and a service module cannot import a route module). Aliased here so
#: this module's call sites — and the shape of every artifact feed event —
#: keep coming from the single implementation.
_header = artifact_header


def _full(row: ArtifactRow) -> ArtifactOut:
    return ArtifactOut(**_header(row).model_dump(), payload=row.payload)


def _with_rules(row: ArtifactRow) -> ArtifactPayloadOut:
    rules = None
    if row.kind is ArtifactKind.validation_rules:
        # The yaml `rule_sources` compiles: a malformed payload is an empty set.
        payload = row.payload if isinstance(row.payload, dict) else {}
        rules = parse_result(str(payload.get("yaml", "")))
    return ArtifactPayloadOut(
        **_header(row).model_dump(), payload=row.payload, rules=rules
    )


def _validate_payload(kind: ArtifactKind, payload: dict[str, Any]) -> None:
    spec = get_spec(kind)
    if spec is None:
        raise HTTPException(
            status_code=422,
            detail=f"artifact kind {kind.value!r} is not supported yet",
        )
    try:
        spec.adapter.validate_python(payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid {kind.value} payload: {exc}"
        ) from exc


def _apply_derived_metadata(kind: ArtifactKind, payload: dict[str, Any]) -> None:
    """Recompute server-owned derived fields in-place (registry hook)."""
    spec = get_spec(kind)
    if spec is not None and spec.derive_metadata is not None:
        spec.derive_metadata(payload)


def _reject_if_peer_locked(state: ProjectState, artifact_id: str, user_id: str) -> None:
    """409 while a PEER holds a live lease on this artifact (see the module
    docstring: these routes honour `art:` leases without granting them)."""
    conflicts = state.lock_table.peer_leases(
        [artifact_resource(artifact_id)], user_id, now=time.monotonic()
    )
    if conflicts:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "artifact is checked out by someone else",
                "conflicts": [
                    {
                        "resource_id": le.resource_id,
                        "mode": le.mode.value,
                        "holder_id": le.holder,
                        "holder_email": le.holder_email,
                    }
                    for le in conflicts
                ],
            },
        )


def _require_artifact(db: DbSession, project_id: str, artifact_id: str) -> ArtifactRow:
    row = content.get_artifact(db, artifact_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="artifact not found")
    return row


@router.get("/artifacts")
def list_artifacts(
    project_id: str,
    kind: ArtifactKind | None = None,
    _state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
) -> ArtifactListOut:
    rows = content.list_artifacts(db, project_id, kind)
    return ArtifactListOut(items=[_header(r) for r in rows])


@router.get("/artifacts/payloads")
def list_artifact_payloads(
    project_id: str,
    ids: list[str] | None = Query(None, alias="id"),
    _state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
) -> ArtifactPayloadListOut:
    """Every artifact with its payload, or the named ids the project has, in
    `list_artifacts` order. Declared before `/artifacts/{artifact_id}`, which
    would read `payloads` as an id."""
    rows = content.list_artifacts(db, project_id, ids=ids)
    return ArtifactPayloadListOut(items=[_with_rules(r) for r in rows])


@router.get("/artifacts/{artifact_id}")
def get_artifact(
    project_id: str,
    artifact_id: str,
    _state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
) -> ArtifactOut:
    return _full(_require_artifact(db, project_id, artifact_id))


@router.post("/artifacts", status_code=201)
def create_artifact(
    payload: ArtifactCreateIn,
    project_id: str,
    state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ArtifactOut:
    kind = ArtifactKind(payload.kind)
    _validate_payload(kind, payload.payload)
    _apply_derived_metadata(kind, payload.payload)
    if content.find_artifact(db, project_id, kind, payload.name) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"a {kind.value} named {payload.name!r} already exists",
        )
    row = content.create_artifact(
        db,
        project_id,
        kind=kind,
        name=payload.name,
        payload=payload.payload,
        updated_by=user.id,
    )
    db.commit()
    state.hub.broadcast(artifact_event("created", _header(row).model_dump(mode="json")))
    return _full(row)


@router.put("/artifacts/{artifact_id}")
def update_artifact(
    payload: ArtifactUpdateIn,
    project_id: str,
    artifact_id: str,
    state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ArtifactOut:
    row = _require_artifact(db, project_id, artifact_id)
    _reject_if_peer_locked(state, artifact_id, user.id)
    if payload.payload is not None:
        _validate_payload(row.kind, payload.payload)
        _apply_derived_metadata(row.kind, payload.payload)
    if payload.name is not None and payload.name != row.name:
        clash = content.find_artifact(db, project_id, row.kind, payload.name)
        if clash is not None and clash.id != row.id:
            raise HTTPException(
                status_code=409,
                detail=f"a {row.kind.value} named {payload.name!r} already exists",
            )
    try:
        content.update_artifact(
            db,
            row,
            expected_rev=payload.artifact_rev,
            name=payload.name,
            payload=payload.payload,
            updated_by=user.id,
        )
    except content.StaleArtifactError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "artifact was modified by someone else",
                "current_rev": exc.current_rev,
            },
        ) from exc
    db.commit()
    state.hub.broadcast(artifact_event("updated", _header(row).model_dump(mode="json")))
    return _full(row)


@router.delete("/artifacts/{artifact_id}", status_code=204)
def delete_artifact(
    project_id: str,
    artifact_id: str,
    state: ProjectState = Depends(get_project_state),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = _require_artifact(db, project_id, artifact_id)
    _reject_if_peer_locked(state, artifact_id, user.id)
    header = _header(row).model_dump(mode="json")
    content.delete_artifact(db, row)
    db.commit()
    state.hub.broadcast(artifact_event("deleted", header))
    return Response(status_code=204)
