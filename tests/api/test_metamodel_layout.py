"""GET /metamodel/layout — shared canvas positions.

Presentation-only: last-write-wins, no lease, no commit journal entry. The
authz matrix is the standard method-based one: any member reads, non-members
403, unknown project 404.

Positions land ONLY through ``POST /commits`` via the ``metamodel.move_node``
op (``content.stage_metamodel_layout``, exercised end-to-end by
``test_commits_metamodel_ops.py``). This file keeps the GET-only read
surface plus ``test_get_layout_reflects_a_commit_flow_move``, which proves
GET reflects a layout landed through the commit flow. ``PUT
/metamodel/layout`` no longer exists.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_commits_metamodel_ops import _acquire_mm

STRANGER_HEADERS = {"x-user-id": "stranger", "x-user-email": "stranger@example.com"}

_MM = """
elements:
  - name: Zone
"""


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def test_get_layout_empty_before_any_save(client):
    seed_default_project()
    r = client.get(papi("/metamodel/layout"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"positions": {}}


def test_non_member_403_unknown_project_404(client):
    seed_default_project()
    assert (
        client.get(papi("/metamodel/layout"), headers=STRANGER_HEADERS).status_code == 403
    )
    r = client.get(
        "/api/v1/projects/nope/metamodel/layout", headers=AUTH_HEADERS
    )
    assert r.status_code == 404


def _bound_client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.post(papi("/metamodel"), content=_MM,
                  headers={"content-type": "application/x-yaml"}).status_code == 200
    assert c.post(papi("/model"), json={"elements": [], "relationships": []}).status_code == 200
    return c


def test_layout_put_route_is_gone() -> None:
    c = _bound_client()
    r = c.put(
        papi("/metamodel/layout"),
        json={"positions": {"el:Zone": {"x": 1.0, "y": 2.0}}},
    )
    assert r.status_code in (404, 405)
    # a sibling on the same /metamodel/layout path still answers, so a
    # wholesale router-mounting mistake can't hide behind this tombstone.
    assert c.get(papi("/metamodel/layout")).status_code == 200


def test_get_layout_reflects_a_commit_flow_move() -> None:
    """A position landed through ``POST /commits`` via
    ``metamodel.move_node`` is what ``GET /metamodel/layout`` serves back —
    proving the read surface stays wired to
    ``content.stage_metamodel_layout``, the commit path's writer."""
    c = _bound_client()
    token = _acquire_mm(c)
    r = c.post(
        papi("/commits"),
        json={
            "base_rev": c.get(papi("/model/summary")).json()["model_rev"],
            "ops": [
                {
                    "kind": "metamodel.move_node",
                    "node": "el:Zone",
                    "pos": {"x": 12.5, "y": -40.0},
                }
            ],
            "message": "",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    got = c.get(papi("/metamodel/layout")).json()
    assert got["positions"]["el:Zone"] == {"x": 12.5, "y": -40.0}
