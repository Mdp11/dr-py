from __future__ import annotations

import json
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


def _bundle_bytes() -> bytes:
    """A two-artifact bundle whose navigation references its snippet, so the
    ref can only be right if the import remapped it to the LANDED id."""
    return json.dumps(
        {
            "format": "datarover.artifact-bundle/v1",
            "exported_at": "2026-08-08T00:00:00+00:00",
            "source_project": {"id": "src", "name": "Src"},
            "roots": ["a-nav"],
            "artifacts": [
                {
                    "id": "a-snip",
                    "kind": "code_snippet",
                    "name": "s",
                    "payload": {
                        "schema_version": 1,
                        "language": "python",
                        "code": "def value(el):\n    return el.name\n",
                    },
                },
                {
                    "id": "a-nav",
                    "kind": "navigation",
                    "name": "n",
                    "payload": {
                        "kind": "path",
                        "start": {"kind": "scope", "types": []},
                        "steps": [{"kind": "script", "snippet": {"ref": "a-snip"}}],
                    },
                },
            ],
        }
    ).encode()


def test_wizard_creates_project_with_artifact_bundle() -> None:
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Bundled"},
            files={
                "metamodel": ("mm.yaml", fh, "application/yaml"),
                "artifacts": ("b.json", _bundle_bytes(), "application/json"),
            },
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]

    items = c.get(f"/api/v1/projects/{pid}/artifacts").json()["items"]
    by_name = {a["name"]: a for a in items}
    assert set(by_name) == {"s", "n"}
    # fresh ids, not the bundle's
    assert by_name["s"]["id"] not in {"a-snip", "a-nav"}
    assert by_name["n"]["id"] not in {"a-snip", "a-nav"}
    nav = c.get(f"/api/v1/projects/{pid}/artifacts/{by_name['n']['id']}").json()
    assert nav["payload"]["steps"][0]["snippet"]["ref"] == by_name["s"]["id"]


def _hostile_bundle_bytes() -> bytes:
    """A PARSEABLE envelope whose artifacts are individually hostile: the
    wizard takes an arbitrary uploaded file, so every one of these must be
    skipped rather than landed (or raised on)."""
    return json.dumps(
        {
            "format": "datarover.artifact-bundle/v1",
            "exported_at": "2026-08-08T00:00:00+00:00",
            "source_project": {"id": "src", "name": "Src"},
            "roots": [],
            "artifacts": [
                {"id": "ok", "kind": "code_snippet", "name": "s",
                 "payload": {"schema_version": 1, "language": "python",
                             "code": "def value(el):\n    return el.name\n",
                             "entry_points": ["script", "bogus"]}},
                # a schema-invalid table row 500s EVERY GET /tables read for it
                {"id": "bad", "kind": "table", "name": "t", "payload": {"nope": 1}},
                # duplicate (kind, name) -> IntegrityError -> 500 if landed
                {"id": "dup", "kind": "code_snippet", "name": "s",
                 "payload": {"schema_version": 1, "language": "python", "code": "x = 1\n"}},
            ],
        }
    ).encode()


def test_wizard_skips_invalid_artifacts_instead_of_landing_them() -> None:
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Hostile"},
            files={
                "metamodel": ("mm.yaml", fh, "application/yaml"),
                "artifacts": ("b.json", _hostile_bundle_bytes(), "application/json"),
            },
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    items = c.get(f"/api/v1/projects/{pid}/artifacts").json()["items"]
    assert [a["name"] for a in items] == ["s"]
    got = c.get(f"/api/v1/projects/{pid}/artifacts/{items[0]['id']}").json()
    # server-derived, never client-trusted
    assert got["payload"]["entry_points"] == ["script", "value"]


def test_wizard_rejects_bad_artifact_bundle_422_no_orphan() -> None:
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "BadBundle"},
            files={
                "metamodel": ("mm.yaml", fh, "application/yaml"),
                "artifacts": ("b.json", b"{not json", "application/json"),
            },
            headers=CSRF,
        )
    assert r.status_code == 422, r.text
    assert all(p["name"] != "BadBundle" for p in c.get("/api/v1/projects").json())


def test_wizard_create_reports_skipped_artifacts() -> None:
    """The create response carries the importer's skip list; a clean bundle
    reports an empty one, and the list/get routes always default to []."""
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Skippy"},
            files={
                "metamodel": ("mm.yaml", fh, "application/yaml"),
                "artifacts": ("b.json", _hostile_bundle_bytes(), "application/json"),
            },
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    body = r.json()
    skipped = body["skipped_artifacts"]
    assert len(skipped) >= 1
    assert all(s["bundle_id"] and s["reason"] for s in skipped)
    # list/get keep the empty default
    listed = next(p for p in c.get("/api/v1/projects").json() if p["id"] == body["id"])
    assert listed["skipped_artifacts"] == []


def test_wizard_create_clean_bundle_reports_no_skips() -> None:
    c = _as_admin()
    with _MM.open("rb") as fh:
        r = c.post(
            "/api/v1/projects",
            data={"name": "Clean"},
            files={
                "metamodel": ("mm.yaml", fh, "application/yaml"),
                "artifacts": ("b.json", _bundle_bytes(), "application/json"),
            },
            headers=CSRF,
        )
    assert r.status_code == 201, r.text
    assert r.json()["skipped_artifacts"] == []


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
