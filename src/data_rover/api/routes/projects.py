"""Project CRUD.

These are the only non-project-scoped data routes: they live at ``/api/v1``
(not under ``/projects/{project_id}``) because creating/listing projects can't
require an existing project.

Project creation, deletion, and membership management are all centralized under
the global admin role (``require_admin``); per-project member routes no longer
live here — membership management lives in ``routes/admin.py``. Reads of a single
project still require membership (``require_membership``); listing is
admin-sees-all, otherwise scoped to the caller's own projects.
"""

from __future__ import annotations

import uuid

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Response,
    UploadFile,
)
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import importer, tenancy
from ..authz import require_admin, require_membership
from ..db import get_db
from ..db_models import Membership, Project, Role, User
from ..identity import get_current_user
from ..session import get_registry

router = APIRouter()

#: model JSON for a project created with no uploaded model (conforms to any
#: metamodel: no entities to check).
EMPTY_MODEL_JSON = '{"elements": [], "relationships": []}'


class SkippedArtifactOut(BaseModel):
    """One bundle artifact the importer reported-and-skipped (mirrors the
    importer's SkippedEntry — kept as its own wire type so the projects
    router does not leak the bundle module's internal model)."""

    bundle_id: str
    reason: str


class ProjectOut(BaseModel):
    id: str
    name: str
    role: Role
    #: Populated ONLY by the create route (the one caller that runs the
    #: importer); list/get/clone leave the default so existing consumers
    #: see an additive, always-present field.
    skipped_artifacts: list[SkippedArtifactOut] = Field(default_factory=list)


class CloneIn(BaseModel):
    name: str | None = None


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectOut]:
    if user.is_admin:
        return [
            ProjectOut(id=p.id, name=p.name, role=Role.owner)
            for p in tenancy.list_all_projects(db)
        ]
    return [
        ProjectOut(id=p.id, name=p.name, role=role)
        for p, role in tenancy.list_projects_for_user(db, user.id)
    ]


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(
    name: str = Form(...),
    metamodel: UploadFile = File(...),
    model: UploadFile | None = File(default=None),
    view: UploadFile | None = File(default=None),
    artifacts: UploadFile | None = File(default=None),
    admin: User = Depends(require_admin),
) -> ProjectOut:
    """The whole upload is capped at ``max_request_body_bytes`` (413,
    ``upload_cap``). The model streams from its spooled file into the head
    rows; the other parts are small documents read whole. Every check runs in
    the import's transaction, which commits only if all pass: a refusal is a
    422 and leaves no project."""
    project_id = uuid.uuid4().hex
    skipped = importer.import_project(
        project_id=project_id,
        name=name,
        owner_id=admin.id,
        metamodel_yaml=_text(metamodel),
        model_json=model.file if model is not None else EMPTY_MODEL_JSON,
        view_json=_text(view) if view is not None else None,
        artifact_bundle=_text(artifacts) if artifacts is not None else None,
    )
    return ProjectOut(
        id=project_id,
        name=name,
        role=Role.owner,
        skipped_artifacts=[
            SkippedArtifactOut(bundle_id=s.bundle_id, reason=s.reason) for s in skipped
        ],
    )


def _text(upload: UploadFile) -> str:
    try:
        return upload.file.read().decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=422, detail=f"invalid upload: {upload.filename}: {exc}"
        ) from exc


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: str,
    membership: Membership = Depends(require_membership),
    db: Session = Depends(get_db),
) -> ProjectOut:
    # require_membership already loaded this Project into the session's identity
    # map, so db.get is a cache hit (no extra query) and avoids depending on
    # lazy-load timing of membership.project.
    project = db.get(Project, project_id)
    if project is None:  # require_membership already proved existence
        raise HTTPException(status_code=404, detail="project not found")
    return ProjectOut(id=project.id, name=project.name, role=membership.role)


@router.post("/projects/{project_id}/clone", response_model=ProjectOut, status_code=201)
def clone_project(
    project_id: str,
    body: CloneIn | None = None,
    membership: Membership = Depends(require_membership),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    """Clone the CURRENT state of a project into a brand-new project owned by
    the caller. Any member may clone (``require_membership``). The head rows are
    copied in SQL, with the digest and the counts, and the artifacts and views
    through the importer's landing, as a fresh rev-0 baseline; commit history is
    NOT carried over."""
    src = db.get(Project, project_id)
    if src is None:  # require_membership already proved existence
        raise HTTPException(status_code=404, detail="project not found")
    new_name = body.name if body and body.name else f"{src.name} (copy)"
    new_id = uuid.uuid4().hex
    importer.clone_project(
        source_id=project_id, project_id=new_id, name=new_name, owner_id=user.id
    )
    return ProjectOut(id=new_id, name=new_name, role=Role.owner)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> Response:
    tenancy.delete_project(db, project_id)
    # discard, NOT evict: the DB rows are gone (committed), so the snapshot
    # hook would hit a dangling project FK, and the live-leases/feed-clients
    # guard would keep a dead project's session registered forever.
    get_registry().discard(project_id)
    return Response(status_code=204)
