"""Route-level tests: a commit evicts exactly the cells whose read-sets it
touches; the legacy flag and the no-delta paths still clear everything."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import Session, get_session
from data_rover.core.script.runner import CallResult

from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
"""

#: A metamodel with a containment relationship, used only by the
#: structural-reject test below (two containment parents is a STRUCTURAL
#: issue — see core/validation/validators/containment.py).
CONTAINMENT_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    mappings:
      - source: Node
        target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _seed(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel"),
        content=THING_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "t1", "type_name": "Thing", "properties": {"name": "One"}},
                {"id": "t2", "type_name": "Thing", "properties": {"name": "Two"}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text


def _res(v: str) -> CallResult:
    return CallResult(value={"kind": "scalar", "value": v}, error=None, duration_ms=1)


KEY_T1 = ("a" * 64, "value", ("t1",))
KEY_T2 = ("a" * 64, "value", ("t2",))


def _prime_cells(session: Session) -> int:
    rev = session.model_rev
    session.script_cell_cache.clear_and_stamp(rev)
    session.script_cell_cache.put(
        KEY_T1, _res("One"), rev, reads=frozenset({("el", "t1")})
    )
    session.script_cell_cache.put(
        KEY_T2, _res("Two"), rev, reads=frozenset({("el", "t2")})
    )
    return rev


def _update_t1(client: TestClient, rev: int) -> int:
    r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": "t1",
                    "properties_patch": {"name": "One!"},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["model_rev"]


def _lock(client: TestClient, targets: list[tuple[str, str]]) -> str:
    """Acquire one token covering every ``(resource_id, mode)`` in *targets*."""
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": rid, "mode": mode} for rid, mode in targets],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_ops_commit_evicts_only_touched_cells(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    new_rev = _update_t1(client, rev)
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    hit = session.script_cell_cache.get(KEY_T2, new_rev)
    assert hit is not None and hit.value == {"kind": "scalar", "value": "Two"}


def test_undo_also_evicts_selectively(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    _update_t1(client, session.model_rev)  # something to undo
    rev = _prime_cells(session)
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    new_rev = r.json()["model_rev"]
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None  # undo touched t1
    assert session.script_cell_cache.get(KEY_T2, new_rev) is not None


def test_flag_off_restores_clear_all(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DATA_ROVER_SNIPPET_INCREMENTAL_INVALIDATION", "false")
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    new_rev = _update_t1(client, rev)
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    assert session.script_cell_cache.get(KEY_T2, new_rev) is None


def test_legacy_touch_model_still_clears_all(client: TestClient) -> None:
    _seed(client)
    session = get_session()
    _prime_cells(session)
    session.touch_model()
    assert session.script_cell_cache.size == 0


def test_commit_evicts_only_touched_cells_and_preserves_others(
    client: TestClient,
) -> None:
    """POST /commits (the durable, lock-verified path) must apply the same
    selective eviction as /model/ops — an untouched cell must SURVIVE at the
    new rev, not merely be absent from the touched set."""
    _seed(client)
    session = get_session()
    rev = _prime_cells(session)
    token = _lock(client, [("t1", "exclusive")])
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "update_element",
                    "id": "t1",
                    "properties_patch": {"name": "One!"},
                }
            ],
            "lock_tokens": [token],
            "message": "touch t1",
        },
    )
    assert r.status_code == 200, r.text
    new_rev = r.json()["model_rev"]
    assert new_rev == rev + 1
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None
    hit = session.script_cell_cache.get(KEY_T2, new_rev)
    assert hit is not None and hit.value == {"kind": "scalar", "value": "Two"}


def test_commit_structural_reject_leaves_cache_fully_cleared(
    client: TestClient,
) -> None:
    """A structural-reject 422 sits on its own rollback branch (distinct from
    the accepted-commit branch above) and must keep using clear-all rather
    than drifting onto the selective call."""
    r = client.post(
        papi("/metamodel"),
        content=CONTAINMENT_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/model"),
        json={
            "elements": [
                {"id": "p1", "type_name": "Node", "properties": {}},
                {"id": "p2", "type_name": "Node", "properties": {}},
                {"id": "child", "type_name": "Node", "properties": {}},
            ],
            "relationships": [],
        },
    )
    assert r.status_code == 200, r.text
    session = get_session()
    rev = _prime_cells(session)
    token = _lock(
        client,
        [("p1", "exclusive"), ("p2", "exclusive"), ("child", "exclusive")],
    )
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": rev,
            "ops": [
                {
                    "kind": "create_relationship",
                    "temp_id": "tmp_r1",
                    "type_name": "Contains",
                    "source_id": "p1",
                    "target_id": "child",
                    "properties": {},
                },
                {
                    "kind": "create_relationship",
                    "temp_id": "tmp_r2",
                    "type_name": "Contains",
                    "source_id": "p2",
                    "target_id": "child",
                    "properties": {},
                },
            ],
            "lock_tokens": [token],
            "message": "two parents",
        },
    )
    assert r.status_code == 422, r.text
    assert r.json()["structural_blockers"]
    assert session.script_cell_cache.size == 0
