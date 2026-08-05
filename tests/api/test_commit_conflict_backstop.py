"""The generalized staleness rule: non-overlapping concurrent commits land;
overlapping ones 409. Leases make conflicts rare — this is the backstop."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

SNIP = {"schema_version": 1, "language": "python",
        "code": "def value(el):\n    return 1\n"}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(c: TestClient) -> int:
    return c.get(papi("/model/summary")).json()["model_rev"]


def _commit(c: TestClient, ops: list[dict], base_rev: int):
    return c.post(papi("/commits"),
                  json={"base_rev": base_rev, "ops": ops, "lock_tokens": []})


def test_non_overlapping_stale_commit_lands(client: TestClient) -> None:
    base = _rev(client)  # both clients start here
    r1 = _commit(client, [{"kind": "create_element", "temp_id": "tmp_a",
                           "type_name": "Node", "properties": {}}], base)
    assert r1.status_code == 200, r1.text
    # second client, still at the old base, touches a DIFFERENT resource
    r2 = _commit(client, [{"kind": "create_artifact", "temp_id": "tmp_b",
                           "artifact_kind": "code_snippet", "name": "s",
                           "payload": SNIP}], base)
    assert r2.status_code == 200, r2.text          # would have been 409 before


def test_overlapping_stale_commit_409(client: TestClient) -> None:
    """Deterministic version of the brief's sample: the update path always
    requires an ``art:`` lease (Task 5), so both writers acquire one up
    front rather than branching on whether the route demanded it."""
    r = _commit(client, [{"kind": "create_artifact", "temp_id": "tmp_b",
                          "artifact_kind": "code_snippet", "name": "s",
                          "payload": SNIP}], _rev(client))
    assert r.status_code == 200, r.text
    aid = r.json()["id_map"]["tmp_b"]
    base = _rev(client)

    tok1 = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": aid, "mode": "exclusive", "type": "artifact"}],
              "intent": "edit"},
    ).json()["token"]
    r1 = client.post(
        papi("/commits"),
        json={"base_rev": base,
              "ops": [{"kind": "update_artifact", "id": aid,
                       "payload": {**SNIP, "code": "a = 1"}}],
              "lock_tokens": [tok1]},
    )
    assert r1.status_code == 200, r1.text

    # a second writer still at `base` touching the SAME artifact -> 409
    tok2 = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": aid, "mode": "exclusive", "type": "artifact"}],
              "intent": "edit"},
    ).json()["token"]
    r2 = client.post(
        papi("/commits"),
        json={"base_rev": base,
              "ops": [{"kind": "update_artifact", "id": aid,
                       "payload": {**SNIP, "code": "b = 2"}}],
              "lock_tokens": [tok2]},
    )
    assert r2.status_code == 409
    assert r2.json()["detail"] == "conflicting concurrent commits"


def test_future_base_rev_still_409(client: TestClient) -> None:
    r = _commit(client, [], _rev(client) + 5)
    assert r.status_code == 409
