"""Tests for POST /snippets/lint and GET /snippets/docs."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    """A membership with role=viewer on the default project."""
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


def test_lint_endpoint(client: TestClient) -> None:
    r = client.post(papi("/snippets/lint"), json={"code": "def value(el):\n    return 1\n"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["entry_points"]) == {"script", "value"}
    assert body["diagnostics"] == []


def test_lint_reports_syntax_error(client: TestClient) -> None:
    r = client.post(papi("/snippets/lint"), json={"code": "def value(el:\n"})
    assert r.status_code == 200, r.text
    diags = r.json()["diagnostics"]
    assert len(diags) == 1
    assert diags[0]["severity"] == "error"


def test_viewer_can_lint(client: TestClient, viewer_headers: dict[str, str]) -> None:
    r = client.post(
        papi("/snippets/lint"), json={"code": "pass"}, headers=viewer_headers
    )
    assert r.status_code == 200, r.text


def test_docs_served_with_facade_limits_and_notes(client: TestClient) -> None:
    resp = client.get(papi("/snippets/docs"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    names = {e["name"] for e in body["facade"]}
    assert "dr.create" in names and "Element.set" in names
    assert all(e["doc"] for e in body["facade"])
    assert set(body["limits"]) == {
        "wall_timeout_s", "memory_bytes", "stdout_bytes",
        "result_repr_bytes", "max_ops", "max_op_bytes", "page_limit",
    }
    assert body["notes"] and all(isinstance(n, str) for n in body["notes"])


def test_docs_need_membership(client: TestClient) -> None:
    resp = client.get(
        papi("/snippets/docs"),
        headers={"x-user-id": "stranger", "x-user-email": "s@x.io"},
    )
    assert resp.status_code == 403, resp.text
