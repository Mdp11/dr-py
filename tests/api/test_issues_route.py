"""GET /model/issues — cheap read of the session's maintained issue store.

The route must NEVER run the validation pipeline itself on a store-carrying
session (that is the whole point: the Issues panel refreshes without a full
O(model) validate). It snapshots ``session.validation`` under the write mutex.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app
from data_rover.api.routes import validation as validation_routes
from data_rover.api.schemas import IssueOut
from data_rover.api.session import get_session

from .conftest import (
    AUTH_HEADERS,
    seed_default_project,
    install,
    EMPTY_MODEL,
    commit_ops,
)

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
    install(metamodel=MM, model=EMPTY_MODEL)
    return c


def _post_ops(client: TestClient, ops: list[dict]) -> dict:
    return commit_ops(client, ops)


def test_empty_model_returns_empty_list(client: TestClient) -> None:
    res = client.get(f"{API}/model/issues")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["issues"] == []
    assert body["counts"] == {}
    assert body["truncated"] is False
    assert body["model_rev"] == get_session().model_rev


def test_fixing_the_entity_empties_the_store(client: TestClient) -> None:
    res = _post_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_1", "type_name": "Item",
          "properties": {}}],
    )
    new_id = res["id_map"]["tmp_1"]
    res = _post_ops(
        client,
        [{"kind": "update_element", "id": new_id,
          "properties_patch": {"name": "A"}}],
    )
    body = client.get(f"{API}/model/issues").json()
    assert body["issues"] == []
    assert body["counts"] == {}


def test_reseeds_a_nulled_store_under_the_mutex(client: TestClient) -> None:
    """``touch_model``/``metamodel_swap`` null the store; the next read seeds it.

    Seeding moved INSIDE ``session.write_mutex`` so that N clients
    debounce-refetching off one feed event cannot each launch their own full
    pipeline run. Reentrancy is safe (``write_mutex`` is an ``RLock``) and
    ``_ensure_validation_seeded`` takes no lock of its own.
    """
    res = _post_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_1", "type_name": "Item",
          "properties": {}}],
    )
    get_session().validation = None

    body = client.get(f"{API}/model/issues").json()
    assert body["counts"] == {"error": 1}
    assert len(body["issues"]) == 1
    assert get_session().validation is not None  # seeded, and stayed seeded


def test_viewer_may_read_issues(client: TestClient) -> None:
    """A viewer sees the issue list: it is a plain GET, and the panel is a
    read-only surface every role gets."""
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    res = client.get(
        f"{API}/model/issues",
        headers={"x-user-id": "viewer-1", "x-user-email": "v@example.com"},
    )
    assert res.status_code == 200, res.text
    assert res.json()["issues"] == []


def test_issue_out_parses_legacy_json_without_check() -> None:
    """Pre-existing `Commit.issues` JSON rows have no `check` key; `check`
    must still default so those durable rows keep parsing after this field
    is added."""
    out = IssueOut.model_validate({"severity": "error", "message": "m", "target_ids": []})
    assert out.check == ""


def _commit(client: TestClient, ops: list[dict], lock_tokens: list[str] | None = None):
    return client.post(
        f"{API}/commits",
        json={
            "base_rev": get_session().model_rev,
            "ops": ops,
            "lock_tokens": lock_tokens or [],
        },
    )


def test_membership_enforced(client: TestClient) -> None:
    stranger = {"x-user-id": "stranger", "x-user-email": "s@x.io"}
    res = client.get(f"{API}/model/issues", headers=stranger)
    assert res.status_code == 403
    res = client.get(
        "/api/v1/projects/nope/model/issues", headers=AUTH_HEADERS
    )
    assert res.status_code == 404
