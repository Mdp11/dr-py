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

import json
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

from data_rover.core.metamodel.loader import load_metamodel_str

from .. import content, importer, tenancy
from ..artifact_bundle import ArtifactBundle, ClosureResult, build_bundle
from ..authz import require_admin, require_membership
from ..db import get_db
from ..db_models import Membership, Project, Role, User
from ..identity import get_current_user
from ..serialize import iter_model_json
from ..session import get_registry
from ._snapshot import build_model_from_dicts

router = APIRouter()

#: model JSON for a project created with no uploaded model (conforms to any
#: metamodel — no entities to guard). build_model_from_dicts reads these as lists.
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
    metamodel_yaml = metamodel.file.read().decode("utf-8")
    model_json = (
        model.file.read().decode("utf-8") if model is not None else EMPTY_MODEL_JSON
    )
    view_json = view.file.read().decode("utf-8") if view is not None else None
    artifact_bundle = (
        artifacts.file.read().decode("utf-8") if artifacts is not None else None
    )

    # Pre-validate BEFORE import_project (which commits rows before it parses):
    # a bad metamodel/model must 422 without leaving an orphan project.
    try:
        mm = load_metamodel_str(metamodel_yaml)
        build_model_from_dicts(mm, json.loads(model_json))
    except HTTPException:
        raise  # build_model_from_dicts already raises 422 with a precise detail
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"invalid upload: {exc}") from exc
    # Same stance for the bundle envelope: the importer parses it only after
    # committing the project row, so an unparseable upload would otherwise
    # leave an orphan project behind. ENVELOPE-only, and deliberately so: a
    # malformed envelope is the whole upload being wrong, while a per-artifact
    # problem must not cost the user the rest of the bundle — the importer's
    # untrusted path (this route passes no `trust_artifacts`) validates each
    # artifact and reports-and-skips the bad ones.
    if artifact_bundle is not None:
        try:
            ArtifactBundle.model_validate_json(artifact_bundle)
        except Exception as exc:
            raise HTTPException(
                status_code=422, detail=f"invalid artifact bundle: {exc}"
            ) from exc

    project_id = uuid.uuid4().hex
    skipped = importer.import_project(
        project_id=project_id,
        name=name,
        owner_id=admin.id,
        metamodel_yaml=metamodel_yaml,
        model_json=model_json,
        view_json=view_json,
        artifact_bundle=artifact_bundle,
    )
    return ProjectOut(
        id=project_id,
        name=name,
        role=Role.owner,
        skipped_artifacts=[
            SkippedArtifactOut(bundle_id=s.bundle_id, reason=s.reason) for s in skipped
        ],
    )


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
    the caller. Any member may clone (``require_membership``). The clone copies
    metamodel + current model + view + artifacts as a fresh rev-0 baseline via
    the importer; commit history is NOT carried over."""
    src = db.get(Project, project_id)
    if src is None:  # require_membership already proved existence
        raise HTTPException(status_code=404, detail="project not found")
    model_row = content.get_model_row(db, project_id)
    if model_row is None:
        raise HTTPException(status_code=409, detail="project has no content to clone")
    mm_row = content.get_metamodel_row(db, model_row.metamodel_id)
    if mm_row is None:
        raise HTTPException(status_code=409, detail="project metamodel missing")
    view_row = content.get_single_view(db, project_id)

    # Materialize the source's CURRENT model as save-file JSON from the live
    # session (hydrates on cache-miss); iter_model_json streams entity-by-entity.
    session = get_registry().get(project_id)
    if session.model is None:  # model_row above proves content was persisted
        raise HTTPException(status_code=409, detail="project has no content to clone")
    model_json = "".join(iter_model_json(session.model))

    # Every artifact row rides along, VERBATIM: a clone is a copy, not a
    # validation gate, so this deliberately does NOT run `compute_closure` —
    # a closure walk is pointless when every row is a root anyway, and it
    # would drop rows the registry doesn't know (legacy `diagram`). The
    # importer lands each one under a fresh id and remaps payload/view refs.
    rows = content.list_artifacts(db, project_id)
    artifact_bundle = (
        build_bundle(
            src,
            ClosureResult(rows=rows, dangling_refs=[]),
            roots=[r.id for r in rows],
        ).model_dump_json()
        if rows
        else None
    )

    new_name = body.name if body and body.name else f"{src.name} (copy)"
    new_id = uuid.uuid4().hex
    importer.import_project(
        project_id=new_id,
        name=new_name,
        owner_id=user.id,
        metamodel_yaml=mm_row.blob,
        model_json=model_json,
        view_json=view_row.blob if view_row is not None else None,
        artifact_bundle=artifact_bundle,
        # the ONE trusted caller: this bundle was built from rows two
        # statements ago, so validating it could only reject data a clone is
        # obliged to carry (see importer._landable_artifacts)
        trust_artifacts=True,
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
    # guard would keep a dead project's session registered forever (U-7).
    get_registry().discard(project_id)
    return Response(status_code=204)
