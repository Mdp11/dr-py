"""The rebind half of the ``metamodel.*`` op family lands ONLY through
``POST /commits`` (owner gate, ``mm`` lease verification, quiet-peers guard,
forced snapshot, ``rebind_event``, journal columns — ``test_commits_
metamodel_ops.py`` is the exhaustive coverage for all of it). This file
keeps two things:

1. A tombstone proving ``POST /metamodel/rebind`` answers 404/405, next to a
   sibling on the same ``/metamodel`` prefix answering 200 — so a wholesale
   router-mounting mistake can't hide behind the tombstone.
2. ``test_rebind_commit_survives_eviction``: a rebound project re-hydrating
   after eviction, with a pre-existing element whose type the candidate
   metamodel no longer declares surviving via ``strict=False`` decode
   instead of being dropped.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_commits_metamodel_ops import _acquire_mm

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Link
    source: Widget
    target: Widget
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    c.post(papi("/model/ops"), json={"base_rev": _rev(c), "ops": [
        {"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}]})
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_rebind_route_is_gone(client: TestClient) -> None:
    r = client.post(
        papi("/metamodel/rebind"),
        params={"base_rev": 0},
        content="elements: []\n",
        headers={"Content-Type": "application/x-yaml"},
    )
    assert r.status_code in (404, 405)
    # a sibling on the same /metamodel prefix still answers, so a wholesale
    # router-mounting mistake (e.g. dropping the whole metamodel_swap router)
    # can't hide behind this tombstone.
    assert client.post(papi("/metamodel/lint"), content=_MM,
                        headers={"content-type": "application/x-yaml"}).status_code == 200


def test_rebind_commit_survives_eviction(client: TestClient) -> None:
    # The fixture creates a Node element under _MM.  _MM_RENAMED defines Widget
    # (no Node).  We rebind WITHOUT clearing the model so a Node instance is
    # present in the snapshot: strict=False hydration lets it through, and the
    # element survives, reported as a CONFORMANCE issue instead of being
    # dropped.
    elements_before = client.get(
        papi("/model/elements"), params={"limit": 1}, headers=AUTH_HEADERS
    ).json()["items"]
    assert elements_before, "fixture must have created a Node element"
    node_id = elements_before[0]["id"]

    before = _rev(client)
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": before,
            "ops": [{"kind": "metamodel.rebind", "blob": _MM_RENAMED}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text

    get_registry().evict(DEFAULT_PROJECT_ID)
    assert DEFAULT_PROJECT_ID not in get_registry().project_ids()

    # (a) the rebound metamodel is live after re-hydration
    mm_resp = client.get(papi("/metamodel"), headers=AUTH_HEADERS)
    assert mm_resp.status_code == 200, f"expected 200, got {mm_resp.status_code}: {mm_resp.text}"
    mm = mm_resp.json()
    assert any(e["name"] == "Widget" for e in mm["elements"])
    assert not any(e["name"] == "Node" for e in mm["elements"])

    # (b) the pre-existing Node element survived re-hydration
    items_after = client.get(
        papi("/model/elements"), params={"limit": 100}, headers=AUTH_HEADERS
    ).json()["items"]
    ids_after = {item["id"] for item in items_after}
    assert node_id in ids_after, (
        f"Node element {node_id!r} was lost after eviction+rehydration; "
        f"elements present: {ids_after}"
    )
