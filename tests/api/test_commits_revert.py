"""Tests for POST /commits/revert and the _affected_ids helper."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.db_models import Commit
from data_rover.api.main import create_app
from data_rover.api.routes.commits import _affected_ids
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
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
    assert c.post(
        papi("/metamodel"), content=_MM,
        headers={"content-type": "application/x-yaml"},
    ).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def _count(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["element_count"]


def _commit_create(c: TestClient, label: str) -> str:
    """Create a Node via the legacy ops path; return its canonical id."""
    r = c.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(c),
            "ops": [
                {"kind": "create_element", "temp_id": "tmp_n",
                 "type_name": "Node", "properties": {"label": label}}
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id_map"]["tmp_n"]


def test_affected_ids_collects_real_ids_from_forward_ops() -> None:
    commits = [
        Commit(
            project_id="p", rev=1, commit_id="c1", author_id=None,
            ops=[{"kind": "create_element", "temp_id": "E1",
                  "type_name": "Node", "properties": {}}],
            inverse_ops=[], id_map={}, message="",
        ),
        Commit(
            project_id="p", rev=2, commit_id="c2", author_id=None,
            ops=[{"kind": "create_relationship", "temp_id": "R1",
                  "type_name": "Contains", "source_id": "E1",
                  "target_id": "E2", "properties": {}},
                 {"kind": "delete_element", "id": "E9"}],
            inverse_ops=[], id_map={}, message="",
        ),
    ]
    assert _affected_ids(commits) == {"E1", "E2", "E9", "R1"}


def test_revert_restores_earlier_state(client: TestClient) -> None:
    a = _commit_create(client, "A")        # rev fixture+1
    target = _rev(client)                  # after A
    b = _commit_create(client, "B")        # rev fixture+2
    assert _count(client) == 2
    before_rev = _rev(client)
    r = client.post(
        papi("/commits/revert"),
        headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": before_rev},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == before_rev + 1  # revert is itself a new commit
    assert _count(client) == 1             # B removed, A kept
    assert b in body["deleted_element_ids"]
    assert a not in body["deleted_element_ids"]


def test_revert_the_revert_returns_to_head(client: TestClient) -> None:
    _commit_create(client, "A")            # rev fixture+1
    target = _rev(client)                  # after A
    _commit_create(client, "B")            # rev fixture+2
    head_count = _count(client)            # 2
    before_revert = _rev(client)
    revert = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": before_revert},
    )
    assert revert.status_code == 200, revert.text
    assert _count(client) == 1
    # revert the revert: pass target_rev = the rev after B was created
    # (the state we just reverted away from), which is before_revert.
    r2 = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": before_revert, "base_rev": _rev(client)},
    )
    assert r2.status_code == 200, r2.text
    assert _count(client) == head_count    # back to 2 elements


def test_revert_survives_eviction(client: TestClient) -> None:
    from data_rover.api.session import get_registry
    from data_rover.api.session import DEFAULT_PROJECT_ID

    _commit_create(client, "A")            # rev fixture+1
    target = _rev(client)
    _commit_create(client, "B")            # rev fixture+2
    assert client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": _rev(client)},
    ).status_code == 200
    assert _count(client) == 1
    get_registry().evict(DEFAULT_PROJECT_ID)        # snapshot-then-drop
    assert _count(client) == 1                       # re-hydrate from journal


def test_revert_db_failure_rolls_back_in_memory(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import data_rover.api.routes.commits as commits_mod

    _commit_create(client, "A")            # rev fixture+1
    target = _rev(client)
    _commit_create(client, "B")            # rev fixture+2
    before_rev = _rev(client)
    before_count = _count(client)

    def _boom(*a: object, **k: object) -> None:
        raise RuntimeError("db down")

    monkeypatch.setattr(commits_mod, "_persist_commit", _boom)
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": target, "base_rev": before_rev},
    )
    assert r.status_code == 500
    assert _rev(client) == before_rev       # model_rev unchanged
    assert _count(client) == before_count   # in-memory model intact


def test_revert_stale_base_rev_409(client: TestClient) -> None:
    _commit_create(client, "A")
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": 0, "base_rev": 999},
    )
    assert r.status_code == 409
    assert r.json()["model_rev"] == _rev(client)


def test_revert_target_out_of_range_422(client: TestClient) -> None:
    _commit_create(client, "A")
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": 999, "base_rev": _rev(client)},
    )
    assert r.status_code == 422


def test_revert_noop_at_head_records_no_commit(client: TestClient) -> None:
    _commit_create(client, "A")
    head = _rev(client)
    r = client.post(
        papi("/commits/revert"), headers=AUTH_HEADERS,
        json={"target_rev": head, "base_rev": head},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_rev"] == head        # unchanged — no new commit
    assert body["changed_elements"] == []
    assert body["deleted_element_ids"] == []
    # history length unchanged
    hist = client.get(papi("/commits"), headers=AUTH_HEADERS).json()
    assert hist["commits"][0]["rev"] == head
