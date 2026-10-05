"""Tests for GET /open (the open handshake)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project, EMPTY_MODEL, install

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
    install(metamodel=_MM, model=EMPTY_MODEL)
    return c


def test_open_returns_rev_and_role(client: TestClient) -> None:
    r = client.get(papi("/open"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "model_rev" in body and body["role"] == "owner"
    assert body["element_count"] >= 0


def test_open_reports_lock_ttl_seconds(client: TestClient) -> None:
    r = client.get(papi("/open"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    # default lock TTL is 300s (settings.lock_ttl_seconds); the field must be present
    assert body["lock_ttl_seconds"] == 300


def test_open_reads_the_model_row_not_the_session_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from .conftest import commit_ops, head, without_session_model

    commit_ops(
        client,
        [
            {"kind": "create_element", "temp_id": "tmp_a", "type_name": "Node"},
            {"kind": "create_element", "temp_id": "tmp_b", "type_name": "Node"},
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Contains",
                "source_id": "tmp_a",
                "target_id": "tmp_b",
            },
        ],
    )
    without_session_model(monkeypatch)
    r = client.get(papi("/open"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["element_count"] == 2 and body["relationship_count"] == 1
    assert body["model_rev"] == head().rev
    assert body["role"] == "owner" and body["strict_mode"] is False


def test_open_reports_strict_mode_from_the_model_row(client: TestClient) -> None:
    from data_rover.api import content, db

    with db.db_session() as s:
        content.set_strict_mode(s, "default", True)
    assert client.get(papi("/open"), headers=AUTH_HEADERS).json()["strict_mode"] is True


def test_open_of_a_project_without_a_model_row_is_404() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.get(papi("/open"), headers=AUTH_HEADERS).status_code == 404


def test_open_hydrates_no_session(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from data_rover.api import hydration
    from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

    get_registry().evict(DEFAULT_PROJECT_ID)

    def refuse(*_a: object, **_k: object) -> None:
        raise AssertionError("the open hydrated a session")

    monkeypatch.setattr(hydration, "hydrate_session", refuse)
    r = client.get(papi("/open"), headers=AUTH_HEADERS)
    assert r.status_code == 200, r.text
    assert DEFAULT_PROJECT_ID not in get_registry().project_ids()
