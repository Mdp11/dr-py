"""GET /model/issues — cheap read of the session's maintained issue store.

The route must NEVER run the validation pipeline itself on a store-carrying
session (that is the whole point: the Issues panel refreshes without a full
O(model) validate). It snapshots ``session.validation`` under the write mutex.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes import validation as validation_routes
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

# Item.name is required (multiplicity 1); creating an Item without it yields
# one multiplicity conformance error owned by the new element. Item has no
# `key`, so several same-shaped Items collide as duplicates (uniqueness
# validator) unless distinguished by `tag` — an optional property that never
# itself contributes an issue.
MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
      - {name: tag, datatype: string, multiplicity: "0..1"}
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(f"{API}/model", json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _post_ops(client: TestClient, ops: list[dict]):
    return client.post(
        f"{API}/model/ops",
        json={"base_rev": get_session().model_rev, "ops": ops},
    )


def test_empty_model_returns_empty_list(client: TestClient) -> None:
    res = client.get(f"{API}/model/issues")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["issues"] == []
    assert body["counts"] == {}
    assert body["truncated"] is False
    assert body["model_rev"] == get_session().model_rev


def test_reflects_committed_issue_store_after_ops(client: TestClient) -> None:
    # create an Item WITHOUT the required name -> one conformance error,
    # spliced into the session store by the op path (no full validate).
    res = _post_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_1", "type_name": "Item",
          "properties": {}}],
    )
    assert res.status_code == 200, res.text
    new_id = res.json()["id_map"]["tmp_1"]

    body = client.get(f"{API}/model/issues").json()
    assert body["counts"] == {"error": 1}
    assert len(body["issues"]) == 1
    issue = body["issues"][0]
    assert issue["target_ids"][0] == new_id
    assert issue["severity"] == "error"
    assert issue["origin"] == "on_server"
    assert body["model_rev"] == get_session().model_rev


def test_fixing_the_entity_empties_the_store(client: TestClient) -> None:
    res = _post_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_1", "type_name": "Item",
          "properties": {}}],
    )
    new_id = res.json()["id_map"]["tmp_1"]
    res = _post_ops(
        client,
        [{"kind": "update_element", "id": new_id,
          "properties_patch": {"name": "A"}}],
    )
    assert res.status_code == 200, res.text
    body = client.get(f"{API}/model/issues").json()
    assert body["issues"] == []
    assert body["counts"] == {}


def test_truncation_caps_issues_but_not_counts(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(validation_routes, "ISSUES_RESPONSE_MAX", 2)
    ops = [
        {"kind": "create_element", "temp_id": f"tmp_{i}", "type_name": "Item",
         "properties": {"tag": f"t{i}"}}
        for i in range(3)
    ]
    assert _post_ops(client, ops).status_code == 200
    body = client.get(f"{API}/model/issues").json()
    assert body["truncated"] is True
    assert len(body["issues"]) == 2
    assert body["counts"] == {"error": 3}  # counts stay exact past the cap


def test_membership_enforced(client: TestClient) -> None:
    stranger = {"x-user-id": "stranger", "x-user-email": "s@x.io"}
    res = client.get(f"{API}/model/issues", headers=stranger)
    assert res.status_code == 403
    res = client.get(
        "/api/v1/projects/nope/model/issues", headers=AUTH_HEADERS
    )
    assert res.status_code == 404
