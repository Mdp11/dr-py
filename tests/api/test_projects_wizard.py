from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db as _db, tenancy
from data_rover.api.db_models import Project, Role
from data_rover.api.main import create_app

pytestmark = pytest.mark.usefixtures("cookie_provider")

CSRF = {"x-requested-with": "data-rover"}
_MM = Path(__file__).resolve().parents[2] / "examples" / "smart-city.metamodel.yaml"


def _as_admin() -> TestClient:
    gen = _db.get_db()
    s = next(gen)
    try:
        tenancy.create_user(s, "admin@x", "pw123456", is_admin=True)
    finally:
        gen.close()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "admin@x", "password": "pw123456"})
    return c


def test_wizard_creates_project_with_empty_model() -> None:
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Fresh"},
            files={"metamodel": ("mm.yaml", fh, "application/yaml")},
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    summary = c.get(f"/api/v1/projects/{pid}/model/summary")
    assert summary.status_code == 200
    assert summary.json()["element_count"] == 0


def test_wizard_rejects_bad_metamodel_422_no_orphan() -> None:
    c = _as_admin()
    r = c.post(
        "/api/v1/projects",
        data={"name": "Bad"},
        files={"metamodel": ("mm.yaml", b"not: [valid", "application/yaml")},
        headers=CSRF,
    )
    assert r.status_code == 422
    assert all(p["name"] != "Bad" for p in c.get("/api/v1/projects").json())


def test_admin_sees_all_projects() -> None:
    c = _as_admin()
    # a project the admin is NOT a member of
    gen = _db.get_db()
    s = next(gen)
    try:
        other = tenancy.create_user(s, "other@x", "pw123456", is_admin=False)
        s.add(Project(id="p-other", name="Other"))
        s.commit()
        tenancy.add_member(s, "p-other", other.id, Role.owner)
    finally:
        gen.close()
    names = {p["name"] for p in c.get("/api/v1/projects").json()}
    assert "Other" in names


def test_non_admin_cannot_create_project_403() -> None:
    _as_admin()  # ensure schema/admin exist
    gen = _db.get_db()
    s = next(gen)
    try:
        tenancy.create_user(s, "joe@x", "pw123456", is_admin=False)
    finally:
        gen.close()
    c = TestClient(create_app())
    c.post("/api/v1/auth/login", json={"email": "joe@x", "password": "pw123456"})
    r = c.post(
        "/api/v1/projects",
        data={"name": "Nope"},
        files={"metamodel": ("mm.yaml", b"x", "application/yaml")},
        headers=CSRF,
    )
    assert r.status_code == 403
