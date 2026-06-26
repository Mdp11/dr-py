from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from data_rover.api import auth, db, tenancy
from data_rover.api.authz import require_admin
from data_rover.api.db_models import Role, User as UserModel
from data_rover.api.main import create_app
from data_rover.api.db_models import User

pytestmark = pytest.mark.usefixtures("cookie_provider")


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
# Route tests (cookie auth — cookie_provider fixture applied module-wide via pytestmark)
# ---------------------------------------------------------------------------

CSRF = {"x-requested-with": "data-rover"}


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


# ---------------------------------------------------------------------------
# Membership route tests
# ---------------------------------------------------------------------------


def _setup_project() -> tuple[str, str]:
    """Create a project owned by admin@x (call after _as_admin seeds the user).
    Returns (project_id, admin_user_id).
    """
    gen = db.get_db()
    s = next(gen)
    try:
        admin = tenancy.get_user_by_email(s, "admin@x")
        assert admin is not None
        project = tenancy.create_project(s, "P1", admin.id)
        return project.id, admin.id
    finally:
        gen.close()


def test_list_members_returns_owner() -> None:
    """GET /admin/projects/{pid}/members returns the seeded project owner."""
    c = _as_admin()
    pid, admin_id = _setup_project()
    r = c.get(f"/api/v1/admin/projects/{pid}/members")
    assert r.status_code == 200
    members = r.json()
    assert len(members) == 1
    assert members[0]["user_id"] == admin_id
    assert members[0]["role"] == "owner"


def test_add_member_201_and_unknown_user_404() -> None:
    """POST adds a member (201) and returns 404 for an unknown user_id."""
    c = _as_admin()
    pid, _ = _setup_project()

    # unknown user → 404
    assert (
        c.post(
            f"/api/v1/admin/projects/{pid}/members",
            json={"user_id": "no-such-user", "role": "viewer"},
            headers=CSRF,
        ).status_code
        == 404
    )

    # seed a viewer and add them to the project → 201
    gen = db.get_db()
    s = next(gen)
    try:
        viewer = tenancy.create_user(s, "viewer@x", "pw", is_admin=False)
        viewer_id = viewer.id
    finally:
        gen.close()

    r = c.post(
        f"/api/v1/admin/projects/{pid}/members",
        json={"user_id": viewer_id, "role": "viewer"},
        headers=CSRF,
    )
    assert r.status_code == 201
    assert r.json()["role"] == "viewer"
    assert r.json()["user_id"] == viewer_id


def test_remove_member_204_and_last_owner_422() -> None:
    """DELETE removes a member (204); removing the sole owner returns 422."""
    c = _as_admin()
    pid, admin_id = _setup_project()

    # add a viewer so there is someone to remove first
    gen = db.get_db()
    s = next(gen)
    try:
        viewer = tenancy.create_user(s, "viewer@x", "pw", is_admin=False)
        viewer_id = viewer.id
        tenancy.add_member(s, pid, viewer_id, Role.viewer)
    finally:
        gen.close()

    # remove the viewer → 204
    assert (
        c.delete(
            f"/api/v1/admin/projects/{pid}/members/{viewer_id}", headers=CSRF
        ).status_code
        == 204
    )

    # attempt to remove the sole remaining owner → 422
    assert (
        c.delete(
            f"/api/v1/admin/projects/{pid}/members/{admin_id}", headers=CSRF
        ).status_code
        == 422
    )


# ---------------------------------------------------------------------------
# Last-admin lockout guard tests
# ---------------------------------------------------------------------------


def test_demote_sole_admin_via_patch_returns_409() -> None:
    """PATCH is_admin=False on the only active admin must return 409; user stays admin."""
    c = _as_admin()
    # find the seeded admin's id
    users = c.get("/api/v1/admin/users").json()
    admin_id = next(u["id"] for u in users if u["email"] == "admin@x")

    r = c.patch(
        f"/api/v1/admin/users/{admin_id}", json={"is_admin": False}, headers=CSRF
    )
    assert r.status_code == 409, r.text

    # user must still be admin
    users_after = c.get("/api/v1/admin/users").json()
    admin_after = next(u for u in users_after if u["id"] == admin_id)
    assert admin_after["is_admin"] is True


def test_deactivate_sole_admin_via_patch_returns_409() -> None:
    """PATCH is_active=False on the only active admin must return 409."""
    c = _as_admin()
    users = c.get("/api/v1/admin/users").json()
    admin_id = next(u["id"] for u in users if u["email"] == "admin@x")

    r = c.patch(
        f"/api/v1/admin/users/{admin_id}", json={"is_active": False}, headers=CSRF
    )
    assert r.status_code == 409, r.text

    users_after = c.get("/api/v1/admin/users").json()
    admin_after = next(u for u in users_after if u["id"] == admin_id)
    assert admin_after["is_active"] is True


def test_delete_sole_admin_returns_409() -> None:
    """DELETE on the only active admin must return 409."""
    c = _as_admin()
    users = c.get("/api/v1/admin/users").json()
    admin_id = next(u["id"] for u in users if u["email"] == "admin@x")

    r = c.delete(f"/api/v1/admin/users/{admin_id}", headers=CSRF)
    assert r.status_code == 409, r.text

    # user must still exist
    users_after = c.get("/api/v1/admin/users").json()
    assert any(u["id"] == admin_id for u in users_after)


def test_demote_and_delete_one_of_two_admins_succeeds() -> None:
    """With two active admins, demoting and then deleting one of them is allowed."""
    c = _as_admin()
    # create a second admin
    r = c.post(
        "/api/v1/admin/users",
        json={"email": "admin2@x", "password": "pw", "is_admin": True},
        headers=CSRF,
    )
    assert r.status_code == 201, r.text
    admin2_id = r.json()["id"]

    # demote the second admin → should succeed (200)
    r = c.patch(
        f"/api/v1/admin/users/{admin2_id}", json={"is_admin": False}, headers=CSRF
    )
    assert r.status_code == 200, r.text
    assert r.json()["is_admin"] is False

    # delete the now-non-admin second user → should succeed (204)
    r = c.delete(f"/api/v1/admin/users/{admin2_id}", headers=CSRF)
    assert r.status_code == 204, r.text


# ---------------------------------------------------------------------------
# Fix 2: get_user_by_email graceful duplicate-email handling
# ---------------------------------------------------------------------------


def test_get_user_by_email_returns_none_on_duplicate_emails() -> None:
    """If two users share an email (no DB unique constraint), get_user_by_email
    returns None rather than raising MultipleResultsFound."""
    s = _session()
    # Insert two rows with the same email directly via ORM (bypassing create_user
    # which would block on the duplicate-email guard).
    s.add(User(id="dup1", email="dup@x.com", is_admin=False))
    s.add(User(id="dup2", email="dup@x.com", is_admin=False))
    s.commit()

    result = tenancy.get_user_by_email(s, "dup@x.com")
    assert result is None, "expected None, not a row or an exception"
