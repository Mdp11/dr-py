"""Project + membership CRUD.

These are the only non-project-scoped data routes: they live at ``/api/v1``
(not under ``/projects/{project_id}``) because creating/listing projects can't
require an existing project. Member-management ops are owner-only
(``require_owner``); reads require any membership (``require_membership``).
Role updates are an upsert via ``POST .../members`` (a PATCH endpoint is not in
the Phase 2 scope).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import tenancy
from ..authz import require_membership, require_owner
from ..db import get_db
from ..db_models import Membership, Role, User
from ..identity import get_current_user
from ..session import get_registry

router = APIRouter()


class ProjectCreate(BaseModel):
    name: str


class ProjectOut(BaseModel):
    id: str
    name: str
    role: Role


class MemberIn(BaseModel):
    user_id: str
    email: str = ""
    role: Role


class MemberOut(BaseModel):
    user_id: str
    email: str
    role: Role


@router.post("/projects", response_model=ProjectOut, status_code=201)
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ProjectOut:
    project = tenancy.create_project(db, body.name, user.id)
    return ProjectOut(id=project.id, name=project.name, role=Role.owner)


@router.get("/projects", response_model=list[ProjectOut])
def list_projects(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ProjectOut]:
    return [
        ProjectOut(id=p.id, name=p.name, role=role)
        for p, role in tenancy.list_projects_for_user(db, user.id)
    ]


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(
    membership: Membership = Depends(require_membership),
) -> ProjectOut:
    # require_membership already proved the project exists and loaded the row;
    # read it off the relationship instead of re-fetching.
    project = membership.project
    return ProjectOut(id=project.id, name=project.name, role=membership.role)


@router.delete("/projects/{project_id}", status_code=204)
def delete_project(
    project_id: str,
    _owner: Membership = Depends(require_owner),
    db: Session = Depends(get_db),
) -> Response:
    tenancy.delete_project(db, project_id)
    get_registry().evict(project_id)  # drop the in-memory session, if any
    return Response(status_code=204)


@router.get("/projects/{project_id}/members", response_model=list[MemberOut])
def list_members(
    project_id: str,
    _m: Membership = Depends(require_membership),
    db: Session = Depends(get_db),
) -> list[MemberOut]:
    return [
        MemberOut(user_id=m.user_id, email=m.user.email, role=m.role)
        for m in tenancy.list_members(db, project_id)
    ]


@router.post(
    "/projects/{project_id}/members", response_model=MemberOut, status_code=201
)
def add_member(
    project_id: str,
    body: MemberIn,
    _owner: Membership = Depends(require_owner),
    db: Session = Depends(get_db),
) -> MemberOut:
    user = tenancy.upsert_user(db, body.user_id, body.email)
    m = tenancy.add_member(db, project_id, body.user_id, body.role)
    # source email from the stored user row, so this matches what list_members
    # returns (body.email may be "" or stale for an already-known user).
    return MemberOut(user_id=m.user_id, email=user.email, role=m.role)


@router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
def remove_member(
    project_id: str,
    user_id: str,
    _owner: Membership = Depends(require_owner),
    db: Session = Depends(get_db),
) -> Response:
    tenancy.remove_member(db, project_id, user_id)  # raises ValueError -> 422
    return Response(status_code=204)
