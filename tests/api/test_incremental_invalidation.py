"""Route-level tests: a commit evicts exactly the cells whose read-sets it
touches; the legacy flag and the no-delta paths still clear everything."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session
from data_rover.core.script.runner import CallResult

from .conftest import AUTH_HEADERS, papi, seed_default_project

THING_MM = """
elements:
  - name: Thing
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
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


def _prime_cells(session) -> int:
    rev = session.model_rev
    session.script_cell_cache.clear_and_stamp(rev)
    session.script_cell_cache.put(KEY_T1, _res("One"), rev, reads=frozenset({("el", "t1")}))
    session.script_cell_cache.put(KEY_T2, _res("Two"), rev, reads=frozenset({("el", "t2")}))
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
    rev = _update_t1(client, session.model_rev)  # something to undo
    _ = rev
    rev = _prime_cells(session)
    r = client.post(papi("/model/undo"))
    assert r.status_code == 200, r.text
    new_rev = r.json()["model_rev"]
    assert session.script_cell_cache.get(KEY_T1, new_rev) is None  # undo touched t1
    assert session.script_cell_cache.get(KEY_T2, new_rev) is not None


def test_flag_off_restores_clear_all(
    client: TestClient, monkeypatch
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
