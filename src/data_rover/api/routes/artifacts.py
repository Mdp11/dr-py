"""Project-artifact CRUD (saved navigations; tables/diagrams in later stages).

Artifacts are DB rows, NOT model content: no leases, no commits, no op-log.
Concurrency is optimistic via `artifact_rev` (PUT echoes the loaded rev;
mismatch -> 409 carrying `current_rev`). Every successful write broadcasts an
`artifact_event` on the session's FeedHub — safe without the write_mutex
because artifact writes never touch the in-memory model.

Payloads are validated per kind on write; Stage 1 only `navigation`
(`NAVIGATION_ADAPTER`) is accepted — other kinds 422 until their stage lands.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import ValidationError
from sqlalchemy.orm import Session as DbSession

from data_rover.core.navigation.evaluate import evaluate
from data_rover.core.navigation.resolve import NavigationResolveError, resolve_refs
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, NavigationDefinition

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind, ArtifactRow, User
from ..deps import Session, get_request_session, require_model
from ..feed import artifact_event
from ..identity import get_current_user
from ..schemas import (
    ArtifactCreateIn,
    ArtifactHeaderOut,
    ArtifactListOut,
    ArtifactOut,
    ArtifactUpdateIn,
    ChainPageOut,
    EvaluateNavigationIn,
)
from .read import _tree_item  # shared lite projection

router = APIRouter()

#: kind -> payload validator. The route 422s on kinds absent here, so adding
#: a stage's kind means adding one entry (and its schema) — nothing else.
_PAYLOAD_ADAPTERS = {ArtifactKind.navigation: NAVIGATION_ADAPTER}


def _header(row: ArtifactRow) -> ArtifactHeaderOut:
    return ArtifactHeaderOut(
        id=row.id,
        kind=row.kind.value,
        name=row.name,
        artifact_rev=row.artifact_rev,
        updated_at=row.updated_at,
        updated_by=row.updated_by,
    )


def _full(row: ArtifactRow) -> ArtifactOut:
    return ArtifactOut(**_header(row).model_dump(), payload=row.payload)


def _validate_payload(kind: ArtifactKind, payload: dict[str, Any]) -> None:
    adapter = _PAYLOAD_ADAPTERS.get(kind)
    if adapter is None:
        raise HTTPException(
            status_code=422,
            detail=f"artifact kind {kind.value!r} is not supported yet",
        )
    try:
        adapter.validate_python(payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid {kind.value} payload: {exc}"
        ) from exc


def _require_artifact(db: DbSession, project_id: str, artifact_id: str) -> ArtifactRow:
    row = content.get_artifact(db, artifact_id)
    if row is None or row.project_id != project_id:
        raise HTTPException(status_code=404, detail="artifact not found")
    return row


@router.get("/artifacts")
def list_artifacts(
    project_id: str,
    kind: ArtifactKind | None = None,
    _session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ArtifactListOut:
    rows = content.list_artifacts(db, project_id, kind)
    return ArtifactListOut(items=[_header(r) for r in rows])


@router.get("/artifacts/{artifact_id}")
def get_artifact(
    project_id: str,
    artifact_id: str,
    _session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ArtifactOut:
    return _full(_require_artifact(db, project_id, artifact_id))


@router.post("/artifacts", status_code=201)
def create_artifact(
    payload: ArtifactCreateIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ArtifactOut:
    kind = ArtifactKind(payload.kind)
    _validate_payload(kind, payload.payload)
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
    session.hub.broadcast(
        artifact_event("created", _header(row).model_dump(mode="json"))
    )
    return _full(row)


@router.put("/artifacts/{artifact_id}")
def update_artifact(
    payload: ArtifactUpdateIn,
    project_id: str,
    artifact_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ArtifactOut:
    row = _require_artifact(db, project_id, artifact_id)
    if payload.payload is not None:
        _validate_payload(row.kind, payload.payload)
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
    session.hub.broadcast(
        artifact_event("updated", _header(row).model_dump(mode="json"))
    )
    return _full(row)


@router.delete("/artifacts/{artifact_id}", status_code=204)
def delete_artifact(
    project_id: str,
    artifact_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> Response:
    row = _require_artifact(db, project_id, artifact_id)
    header = _header(row).model_dump(mode="json")
    content.delete_artifact(db, row)
    db.commit()
    session.hub.broadcast(artifact_event("deleted", header))
    return Response(status_code=204)


@router.post("/navigations/evaluate")
def evaluate_navigation(
    payload: EvaluateNavigationIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
) -> ChainPageOut:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).
    Stateless offset paging: the evaluator's deterministic chain order makes
    re-evaluating per page sound. No write_mutex — same benign-race stance as
    routes/read.py."""
    metamodel, model = require_model(session)

    def _fetch(artifact_id: str) -> NavigationDefinition:
        row = content.get_artifact(db, artifact_id)
        if (
            row is None
            or row.project_id != project_id
            or row.kind is not ArtifactKind.navigation
        ):
            raise LookupError(artifact_id)
        return NAVIGATION_ADAPTER.validate_python(row.payload)

    try:
        if payload.artifact_id is not None:
            defn = _fetch(payload.artifact_id)
            defn = resolve_refs(defn, _fetch, frozenset({payload.artifact_id}))
        else:
            assert payload.definition is not None  # schema: exactly one
            defn = resolve_refs(payload.definition, _fetch)
        result = evaluate(metamodel, model, defn)
    except LookupError as exc:
        raise HTTPException(
            status_code=422, detail=f"unknown navigation artifact {exc}"
        ) from exc
    except NavigationResolveError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    window = result.chains[payload.offset : payload.offset + payload.limit]
    return ChainPageOut(
        step_types=result.step_types,
        chains=[[_tree_item(model, eid) for eid in chain] for chain in window],
        total=len(result.chains),
        truncated=result.truncated,
    )
