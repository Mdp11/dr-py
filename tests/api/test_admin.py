from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from data_rover.api import auth, db, tenancy
from data_rover.api.authz import require_admin
from data_rover.api.db_models import User as UserModel
from data_rover.api.identity import set_identity_provider
from data_rover.api.main import create_app


def _session():
    db.init_engine("sqlite://")
    db.create_all()
    return next(db.get_db())


def test_create_and_get_user_by_email() -> None:
    s = _session()
    u = tenancy.create_user(s, "a@x.com", "pw", is_admin=True)
    assert u.is_admin is True
    assert auth.verify_password("pw", u.password_hash)
    found = tenancy.get_user_by_email(s, "a@x.com")
    assert found is not None
    assert found.id == u.id


def test_create_user_duplicate_email_raises() -> None:
    s = _session()
    tenancy.create_user(s, "a@x.com", "pw", is_admin=False)
    with pytest.raises(ValueError):
        tenancy.create_user(s, "a@x.com", "pw2", is_admin=False)


def test_set_user_fields_and_list_and_delete() -> None:
    s = _session()
    u = tenancy.create_user(s, "a@x.com", "pw", is_admin=False)
    tenancy.set_user_fields(s, u.id, is_admin=True, is_active=False, password="new")
    u2 = tenancy.get_user_by_email(s, "a@x.com")
    assert u2 is not None
    assert u2.is_admin is True and u2.is_active is False
    assert auth.verify_password("new", u2.password_hash)
    assert len(tenancy.list_users(s)) == 1
    assert len(tenancy.list_users(s, q="zzz")) == 0
    tenancy.delete_user(s, u.id)
    assert tenancy.get_user_by_email(s, "a@x.com") is None


def test_require_admin_allows_admin_and_blocks_others() -> None:
    admin = UserModel(id="a", email="a@x", is_admin=True)
    assert require_admin(user=admin) is admin
    normal = UserModel(id="n", email="n@x", is_admin=False)
    with pytest.raises(HTTPException) as ei:
        require_admin(user=normal)
    assert ei.value.status_code == 403


# ---------------------------------------------------------------------------
# Route tests (cookie auth)
# ---------------------------------------------------------------------------

CSRF = {"x-requested-with": "data-rover"}


@pytest.fixture(autouse=True)
def _cookie_provider(monkeypatch):
    monkeypatch.setenv("DATA_ROVER_IDENTITY_PROVIDER", "cookie")
    monkeypatch.setenv("DATA_ROVER_JWT_SECRET", "test-secret-not-the-default")
    monkeypatch.setenv("DATA_ROVER_AUTH_COOKIE_SECURE", "false")
    set_identity_provider(None)
    yield
    set_identity_provider(None)


def _seed_admin(email="admin@x", pw="pw"):
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.create_user(s, email, pw, is_admin=True)
    finally:
        gen.close()


def _as_admin() -> TestClient:
    _seed_admin()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "admin@x", "password": "pw"})
    return c


def test_admin_can_create_list_patch_delete_user() -> None:
    c = _as_admin()
    r = c.post(
        "/api/v1/admin/users",
        json={"email": "bob@x", "password": "secret12", "is_admin": False},
        headers=CSRF,
    )
    assert r.status_code == 201, r.text
    uid = r.json()["id"]
    assert any(u["email"] == "bob@x" for u in c.get("/api/v1/admin/users").json())
    assert (
        c.patch(
            f"/api/v1/admin/users/{uid}", json={"is_admin": True}, headers=CSRF
        ).status_code
        == 200
    )
    assert c.delete(f"/api/v1/admin/users/{uid}", headers=CSRF).status_code == 204


def test_create_user_duplicate_email_409() -> None:
    c = _as_admin()
    body = {"email": "bob@x", "password": "secret12", "is_admin": False}
    assert c.post("/api/v1/admin/users", json=body, headers=CSRF).status_code == 201
    assert c.post("/api/v1/admin/users", json=body, headers=CSRF).status_code == 409


def test_non_admin_blocked_403() -> None:
    _seed_admin()
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.create_user(s, "joe@x", "pw123456", is_admin=False)
    finally:
        gen.close()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "joe@x", "password": "pw123456"})
    assert c.get("/api/v1/admin/users").status_code == 403
