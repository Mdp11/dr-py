"""Tests for GET /open (Phase 4 open handshake)."""

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


def test_open_returns_rev_and_role(client: TestClient) -> None:
    r = client.get(papi("/open"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "model_rev" in body and body["role"] == "owner"
    assert body["element_count"] >= 0
