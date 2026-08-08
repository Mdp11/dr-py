"""Bundle routes: export closure + stateless plan→confirm import.

Export/preview read ONLY artifact rows (never the in-memory model), so they
take no session dependency and sit in the read-only POST allowlist — viewers
may export. Import (plan + confirm) is Task 4/5."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from ..artifact_bundle import (
    ExportPreviewArtifact,
    ExportPreviewResponse,
    ExportRequest,
    build_bundle,
    compute_closure,
)
from ..authz import require_membership
from ..db import get_db
from ..db_models import Membership, Project

router = APIRouter()


@router.post("/artifacts/export")
def export_artifacts(
    body: ExportRequest,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> JSONResponse:
    project = db.get(Project, project_id)
    assert project is not None  # require_membership proved existence
    closure = compute_closure(db, project_id, body.root_ids)
    bundle = build_bundle(project, closure, body.root_ids)
    return JSONResponse(
        content=bundle.model_dump(),
        headers={
            "Content-Disposition": 'attachment; filename="artifacts.bundle.json"'
        },
    )


@router.post("/artifacts/export/preview", response_model=ExportPreviewResponse)
def export_preview(
    body: ExportRequest,
    project_id: str,
    _membership: Membership = Depends(require_membership),
    db: DbSession = Depends(get_db),
) -> ExportPreviewResponse:
    closure = compute_closure(db, project_id, body.root_ids)
    return ExportPreviewResponse(
        artifacts=[
            ExportPreviewArtifact(id=r.id, kind=r.kind.value, name=r.name)
            for r in closure.rows
        ],
        dangling_refs=closure.dangling_refs,
    )
