"""Admin console routes (all require_admin): user CRUD + system-wide project
membership management. Membership management lives here (not on per-project
owner routes) per the centralized-admin design decision."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import tenancy
from ..authz import require_admin
from ..db import get_db
from ..db_models import Role, User

router = APIRouter(dependencies=[Depends(require_admin)])


class AdminUserCreate(BaseModel):
    email: str
    password: str
    is_admin: bool = False


class AdminUserPatch(BaseModel):
    is_admin: bool | None = None
    is_active: bool | None = None
    password: str | None = None


class AdminUserOut(BaseModel):
    id: str
    email: str
    is_admin: bool
    is_active: bool


class MemberIn(BaseModel):
    user_id: str
    role: Role


class MemberOut(BaseModel):
    user_id: str
    email: str
    role: Role


def _out(u: User) -> AdminUserOut:
    return AdminUserOut(
        id=u.id, email=u.email, is_admin=u.is_admin, is_active=u.is_active
    )


@router.get("/admin/users", response_model=list[AdminUserOut])
def list_users(q: str = "", db: Session = Depends(get_db)) -> list[AdminUserOut]:
    return [_out(u) for u in tenancy.list_users(db, q)]


@router.post("/admin/users", response_model=AdminUserOut, status_code=201)
def create_user(body: AdminUserCreate, db: Session = Depends(get_db)) -> AdminUserOut:
    try:
        u = tenancy.create_user(db, body.email, body.password, body.is_admin)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _out(u)


@router.patch("/admin/users/{user_id}", response_model=AdminUserOut)
def patch_user(
    user_id: str, body: AdminUserPatch, db: Session = Depends(get_db)
) -> AdminUserOut:
    try:
        u = tenancy.set_user_fields(
            db,
            user_id,
            is_admin=body.is_admin,
            is_active=body.is_active,
            password=body.password,
        )
    except ValueError as exc:
        # "unknown user" → 404 (user not found);
        # last-admin guard message contains "last active admin" → 409 conflict.
        status = 409 if "last active admin" in str(exc) else 404
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    return _out(u)


@router.delete("/admin/users/{user_id}", status_code=204)
def delete_user(user_id: str, db: Session = Depends(get_db)) -> Response:
    try:
        tenancy.delete_user(db, user_id)
    except ValueError as exc:
        # last-admin guard → 409 conflict
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return Response(status_code=204)


@router.get("/admin/projects/{project_id}/members", response_model=list[MemberOut])
def list_members(project_id: str, db: Session = Depends(get_db)) -> list[MemberOut]:
    return [
        MemberOut(user_id=m.user_id, email=m.user.email, role=m.role)
        for m in tenancy.list_members(db, project_id)
    ]


@router.post(
    "/admin/projects/{project_id}/members", response_model=MemberOut, status_code=201
)
def add_member(
    project_id: str, body: MemberIn, db: Session = Depends(get_db)
) -> MemberOut:
    user = db.get(User, body.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="unknown user")
    m = tenancy.add_member(db, project_id, body.user_id, body.role)
    return MemberOut(user_id=m.user_id, email=user.email, role=m.role)


@router.delete(
    "/admin/projects/{project_id}/members/{user_id}", status_code=204
)
def remove_member(
    project_id: str, user_id: str, db: Session = Depends(get_db)
) -> Response:
    try:
        tenancy.remove_member(db, project_id, user_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return Response(status_code=204)
