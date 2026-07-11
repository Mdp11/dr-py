"""POST /tables/evaluate: resolves navigation refs, builds/sorts/pages rows
through the pure core evaluator, and caches the ordered row list per session
(Task 7's TableOrderCache). Viewer-callable (read-only POST allowlist)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    """A membership with role=viewer on the default project (mirrors
    test_artifacts_routes.py::test_viewer_can_evaluate_but_not_create)."""
    from data_rover.api import tenancy
    from data_rover.api.db import db_session
    from data_rover.api.db_models import Role

    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(
            s, project_id="default", user_id="viewer-1", role=Role.viewer
        )
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


def test_create_table_artifact_and_evaluate(client: TestClient) -> None:
    _bootstrap_model(client)
    payload = {
        "kind": "table",
        "name": "blocks",
        "payload": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}},
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "mass",
                },
            ],
        },
    }
    r = client.post(papi("/artifacts"), json=payload, headers=AUTH_HEADERS)
    assert r.status_code == 201, r.text
    art_id = r.json()["id"]
    r = client.post(
        papi("/tables/evaluate"),
        json={"artifact_id": art_id, "offset": 0, "limit": 50},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] >= 1
    assert body["rows"][0]["cells"][0]["kind"] == "element"
    assert "model_rev" in body


def test_evaluate_inline_with_sort(client: TestClient) -> None:
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [
                    {"kind": "element", "source": {"kind": "row"}},
                    {
                        "kind": "property",
                        "source": {"kind": "row"},
                        "name": "mass",
                    },
                ],
            },
            "sort": {"column": 1, "direction": "asc"},
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200, r.text


def test_bad_expand_on_scalar_property_422(client: TestClient) -> None:
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [
                    {
                        "kind": "property",
                        "source": {"kind": "row"},
                        "name": "mass",
                        "mode": "expand",
                    }
                ],
            },
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_cache_hit_second_page(client: TestClient) -> None:
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [{"kind": "element", "source": {"kind": "row"}}],
        },
        "sort": {"column": 0, "direction": "asc"},
    }
    r1 = client.post(
        papi("/tables/evaluate"),
        json={**body, "offset": 0, "limit": 1},
        headers=AUTH_HEADERS,
    )
    r2 = client.post(
        papi("/tables/evaluate"),
        json={**body, "offset": 1, "limit": 1},
        headers=AUTH_HEADERS,
    )
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["total"] == r2.json()["total"]


def test_viewer_can_evaluate_not_create(
    client: TestClient, viewer_headers: dict[str, str]
) -> None:
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [{"kind": "element", "source": {"kind": "row"}}],
            },
        },
        headers=viewer_headers,
    )
    assert r.status_code == 200, r.text
    denied = client.post(
        papi("/artifacts"),
        json={
            "kind": "table",
            "name": "x",
            "payload": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [{"kind": "element", "source": {"kind": "row"}}],
            },
        },
        headers=viewer_headers,
    )
    assert denied.status_code == 403


def test_evaluate_unknown_artifact_id_422(client: TestClient) -> None:
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/evaluate"),
        json={"artifact_id": "ghost"},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422


def test_evaluate_requires_exactly_one_of_definition_or_artifact_id(
    client: TestClient,
) -> None:
    _bootstrap_model(client)
    r = client.post(papi("/tables/evaluate"), json={}, headers=AUTH_HEADERS)
    assert r.status_code == 422
    r = client.post(
        papi("/tables/evaluate"),
        json={
            "definition": {
                "row_source": {"kind": "scope", "types": ["Block"]},
                "columns": [{"kind": "element", "source": {"kind": "row"}}],
            },
            "artifact_id": "whatever",
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422
