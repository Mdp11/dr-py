"""Local-auth routes: login (issue cookie), logout (clear), me, change-password.

Unauthenticated except /me and /change-password. Login failures are uniform
(no user-enumeration: unknown email and wrong password both 401 'invalid
credentials'). These mount at /api/v1/auth (not project-scoped)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import auth, tenancy
from ..db import get_db
from ..db_models import User
from ..identity import get_current_user

router = APIRouter()


class LoginIn(BaseModel):
    email: str
    password: str


class MeOut(BaseModel):
    user_id: str
    email: str
    is_admin: bool


class ChangePasswordIn(BaseModel):
    old_password: str
    new_password: str


_MIN_PW_LEN = 8


@router.post("/auth/login", response_model=MeOut)
def login(body: LoginIn, response: Response, db: Session = Depends(get_db)) -> MeOut:
    user = tenancy.get_user_by_email(db, body.email)
    if (
        user is None
        or not user.is_active
        or not auth.verify_password(body.password, user.password_hash)
    ):
        raise HTTPException(status_code=401, detail="invalid credentials")
    auth.set_session_cookie(response, auth.mint_token(user.id, user.is_admin))
    return MeOut(user_id=user.id, email=user.email, is_admin=user.is_admin)


@router.post("/auth/logout", status_code=204)
def logout() -> Response:
    """Clear the session cookie. The cookie is deleted on the returned response
    directly — the injected-response pattern would be ignored when a Response
    object is returned (FastAPI passes it through unchanged)."""
    r = Response(status_code=204)
    auth.clear_session_cookie(r)
    return r


@router.get("/auth/me", response_model=MeOut)
def me(user: User = Depends(get_current_user)) -> MeOut:
    return MeOut(user_id=user.id, email=user.email, is_admin=user.is_admin)


@router.post("/auth/change-password", status_code=204)
def change_password(
    body: ChangePasswordIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    if not auth.verify_password(body.old_password, user.password_hash):
        raise HTTPException(status_code=401, detail="invalid credentials")
    if len(body.new_password) < _MIN_PW_LEN:
        raise HTTPException(status_code=422, detail="password too short")
    tenancy.set_user_fields(db, user.id, password=body.new_password)
    return Response(status_code=204)
