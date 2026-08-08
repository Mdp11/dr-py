"""HTTP tests for the bundle routes: export, preview, import plan, confirm."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db, tenancy
from data_rover.api.artifact_bundle import BUNDLE_FORMAT
from data_rover.api.db_models import Role
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID

from .conftest import AUTH_HEADERS, papi, seed_default_project

SNIP = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return el.name\n"}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _mk(client: TestClient, kind: str, name: str, payload: dict) -> dict:
    r = client.post(
        papi("/artifacts"),
        json={"kind": kind, "name": name, "payload": payload},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _nav(ref: str) -> dict:
    return {"kind": "set_op", "op": "union", "operands": [{"ref": ref}]}


def test_export_computes_closure_and_streams_bundle(client: TestClient) -> None:
    snip = _mk(client, "code_snippet", "s", SNIP)
    nav = _mk(client, "navigation", "n", _nav(snip["id"]))
    r = client.post(
        papi("/artifacts/export"), json={"root_ids": [nav["id"]]}, headers=AUTH_HEADERS
    )
    assert r.status_code == 200, r.text
    assert "attachment" in r.headers.get("content-disposition", "")
    bundle = r.json()
    assert bundle["format"] == BUNDLE_FORMAT
    assert bundle["roots"] == [nav["id"]]
    assert {a["id"] for a in bundle["artifacts"]} == {nav["id"], snip["id"]}


def test_export_preview_metadata_only(client: TestClient) -> None:
    snip = _mk(client, "code_snippet", "s", SNIP)
    nav = _mk(client, "navigation", "n", _nav(snip["id"]))
    r = client.post(
        papi("/artifacts/export/preview"),
        json={"root_ids": [nav["id"], "ghost"]},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert {a["id"] for a in body["artifacts"]} == {nav["id"], snip["id"]}
    assert body["dangling_refs"] == ["ghost"]
    assert all("payload" not in a for a in body["artifacts"])


def test_export_all_unknown_roots_yields_empty_bundle(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts/export"), json={"root_ids": ["nope"]}, headers=AUTH_HEADERS
    )
    assert r.status_code == 200
    assert r.json()["artifacts"] == []


def test_viewer_can_export_and_preview(client: TestClient) -> None:
    # read-only allowlist: a viewer's POST to export/preview must not 403.
    # Mirror tests/api/test_authz.py's viewer-seeding helper, but against the
    # DEFAULT project (papi() targets it) rather than a throwaway one.
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.upsert_user(s, "viewer-user", "")
        tenancy.add_member(s, DEFAULT_PROJECT_ID, "viewer-user", Role.viewer)
    finally:
        gen.close()
    # The email header must be overridden explicitly too: httpx merges a
    # per-request `headers=` dict with the client's default headers rather
    # than replacing them, so omitting it here would leak the fixture's
    # `AUTH_HEADERS["x-user-email"]` onto the viewer's auto-provisioned row
    # and collide with the owner's existing (unique) email.
    viewer_headers = {"x-user-id": "viewer-user", "x-user-email": "viewer@example.com"}

    r = client.post(
        papi("/artifacts/export"), json={"root_ids": []}, headers=viewer_headers
    )
    assert r.status_code == 200, r.text

    r = client.post(
        papi("/artifacts/export/preview"), json={"root_ids": []}, headers=viewer_headers
    )
    assert r.status_code == 200, r.text
    # NOTE: a 403-vs-404 assertion on POST /artifacts/import belongs to Task 5
    # (the route doesn't exist yet); adding it here would make this test
    # order-dependent on route-mounting across tasks.


def _bundle_body(artifacts: list[dict]) -> dict:
    return {
        "format": BUNDLE_FORMAT,
        "exported_at": "2026-08-08T00:00:00+00:00",
        "source_project": {"id": "src", "name": "Source"},
        "roots": [a["id"] for a in artifacts],
        "artifacts": artifacts,
    }


def test_import_plan_mixed_actions(client: TestClient) -> None:
    _mk(client, "code_snippet", "s", SNIP)
    other = {"schema_version": 1, "language": "python", "code": "def value(el):\n    return 1\n"}
    r = client.post(
        papi("/artifacts/import/plan"),
        json=_bundle_body(
            [
                {"id": "b1", "kind": "code_snippet", "name": "s", "payload": SNIP},
                {"id": "b2", "kind": "code_snippet", "name": "s2", "payload": other},
                {"id": "b3", "kind": "hologram", "name": "h", "payload": {}},
            ]
        ),
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    plan = r.json()
    actions = {e["bundle_id"]: e["action"] for e in plan["entries"]}
    assert actions == {"b1": "reuse", "b2": "create"}
    assert [sk["bundle_id"] for sk in plan["skipped"]] == ["b3"]


def test_import_plan_malformed_envelope_422(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts/import/plan"),
        json={"format": "wrong/v9", "artifacts": []},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_import_plan_is_a_write_for_viewers(client: TestClient) -> None:
    # /artifacts/import/plan is NOT in the read-only allowlist (spec decision:
    # planning is part of the write flow). Reuse the viewer helper from the
    # Task 3 viewer test; expect 403.
    gen = db.get_db()
    s = next(gen)
    try:
        tenancy.upsert_user(s, "viewer-user", "")
        tenancy.add_member(s, DEFAULT_PROJECT_ID, "viewer-user", Role.viewer)
    finally:
        gen.close()
    viewer_headers = {"x-user-id": "viewer-user", "x-user-email": "viewer@example.com"}

    r = client.post(
        papi("/artifacts/import/plan"),
        json=_bundle_body([]),
        headers=viewer_headers,
    )
    assert r.status_code == 403, r.text
