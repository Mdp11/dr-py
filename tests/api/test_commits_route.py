"""Tests for POST /commits/preview (Phase 4 mandatory pre-commit validation)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

# Minimal metamodel: one concrete element type.
_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"),
        content=_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _rev(client: TestClient) -> int:
    """Current model_rev from GET /model/summary."""
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _etype(client: TestClient) -> str:
    """First concrete element type name from the uploaded metamodel."""
    mm = client.get(papi("/metamodel"), headers=AUTH_HEADERS).json()
    return next(e["name"] for e in mm["elements"] if not e.get("abstract", False))


def test_preview_clean_create_reports_zero_errors(client: TestClient) -> None:
    r = client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": _rev(client),
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_x",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["conformance_error_count"] == 0
    assert r.json()["structural_blockers"] == []


def test_preview_does_not_mutate_model_rev(client: TestClient) -> None:
    before = _rev(client)
    client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={
            "base_rev": before,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_x",
                    "type_name": _etype(client),
                    "properties": {},
                }
            ],
        },
    )
    assert _rev(client) == before  # preview rolled back; rev unchanged


def test_preview_base_rev_mismatch_409(client: TestClient) -> None:
    r = client.post(
        papi("/commits/preview"),
        headers=AUTH_HEADERS,
        json={"base_rev": 9999, "ops": []},
    )
    assert r.status_code == 409
