"""The rebind half of the ``metamodel.*`` op family lands ONLY through
``POST /commits`` (owner gate, ``mm`` lease verification, quiet-peers guard,
forced snapshot, ``rebind_event``, journal columns — ``test_commits_
metamodel_ops.py`` is the exhaustive coverage for all of it). This file
keeps two things:

1. A tombstone proving ``POST /metamodel/rebind`` answers 404/405, next to a
   sibling on the same ``/metamodel`` prefix answering 200 — so a wholesale
   router-mounting mistake can't hide behind the tombstone.
2. ``test_rebind_commit_survives_eviction``: a rebound project loading its state again
   after eviction under the new metamodel, with its pre-existing element
   intact. A rebind that drops a type still in use is refused before it lands
   (``test_rebind_rows.py``).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.project_state import DEFAULT_PROJECT_ID, get_registry

from .conftest import (
    AUTH_HEADERS,
    papi,
    seed_default_project,
    EMPTY_MODEL,
    install,
    head,
    commit_ops,
)
from .test_commits_metamodel_ops import _acquire_mm

_MM = """
elements:
  - name: Node
relationships:
  - name: Link
    source: Node
    target: Node
"""
_MM_WIDENED = """
elements:
  - name: Node
  - name: Widget
relationships:
  - name: Link
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_MM, model=EMPTY_MODEL)
    commit_ops(c, [{"kind": "create_element", "temp_id": "tmp_n", "type_name": "Node"}])
    return c


def _rev(c: TestClient) -> int:
    return head().rev


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
    # The fixture creates a Node element under _MM.  _MM_WIDENED adds Widget and
    # keeps Node, so the rebind lands with the Node instance in place.
    elements_before = list(head().elements)
    assert elements_before, "fixture must have created a Node element"
    node_id = elements_before[0]

    before = _rev(client)
    token = _acquire_mm(client)
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": before,
            "ops": [{"kind": "metamodel.rebind", "blob": _MM_WIDENED}],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text

    get_registry().evict(DEFAULT_PROJECT_ID)
    assert DEFAULT_PROJECT_ID not in get_registry().project_ids()

    # (a) the rebound metamodel is live after the state is loaded again
    mm_resp = client.get(papi("/metamodel"), headers=AUTH_HEADERS)
    assert mm_resp.status_code == 200, f"expected 200, got {mm_resp.status_code}: {mm_resp.text}"
    mm = mm_resp.json()
    assert any(e["name"] == "Widget" for e in mm["elements"])
    assert any(e["name"] == "Node" for e in mm["elements"])

    # (b) the pre-existing Node element survived the state being loaded again
    ids_after = set(head().elements)
    assert node_id in ids_after, (
        f"Node element {node_id!r} was lost after eviction and a fresh state load; "
        f"elements present: {ids_after}"
    )
