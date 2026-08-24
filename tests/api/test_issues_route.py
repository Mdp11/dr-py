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
    assert res.status_code == 200, res.text
    get_session().validation = None

    body = client.get(f"{API}/model/issues").json()
    assert body["counts"] == {"error": 1}
    assert len(body["issues"]) == 1
    assert get_session().validation is not None  # seeded, and stayed seeded


def test_truncation_never_materializes_more_than_the_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cap bounds the SERVER-side copy, not just the wire list.

    The route slices ``iter_issues()`` lazily under the write mutex, so a
    store far larger than the cap is never listed out in full. Pinned by
    counting how many issues the generator actually yields.
    """
    monkeypatch.setattr(validation_routes, "ISSUES_RESPONSE_MAX", 2)
    ops = [
        {"kind": "create_element", "temp_id": f"tmp_{i}", "type_name": "Item",
         "properties": {"tag": f"t{i}"}}
        for i in range(10)
    ]
    assert _post_ops(client, ops).status_code == 200

    state = get_session().validation
    assert state is not None
    real_iter = type(state).iter_issues
    yielded = 0

    def counting_iter(self):  # type: ignore[no-untyped-def]
        nonlocal yielded
        for issue in real_iter(self):
            yielded += 1
            yield issue

    monkeypatch.setattr(type(state), "iter_issues", counting_iter)
    body = client.get(f"{API}/model/issues").json()
    assert body["truncated"] is True
    assert len(body["issues"]) == 2
    assert body["counts"] == {"error": 10}  # exact past the cap
    # cap + 1: one extra item is what proves truncation, and no more.
    assert yielded == 3


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


def test_issue_carries_producing_validator_check_name(client: TestClient) -> None:
    """Each wire issue names its producing validator (U-1's chip filter)."""
    res = _post_ops(
        client,
        [{"kind": "create_element", "temp_id": "tmp_1", "type_name": "Item",
          "properties": {}}],
    )
    assert res.status_code == 200, res.text

    body = client.get(f"{API}/model/issues").json()
    issue = body["issues"][0]
    assert issue["check"] == "multiplicity"


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


def test_rules_status_reflects_drift_then_a_clean_fix(client: TestClient) -> None:
    """A rules artifact reaches ``session.compiled_rules`` only through
    ``POST /commits`` (hydration/undo too, but never the legacy artifact
    route) — so ``rules_status`` is asserted straight off a committed set."""
    drift_yaml = (
        "rules:\n"
        "  - name: bogus-rule\n"
        "    applies_to: Bogus\n"
        "    then: {property: tag, exists: true}\n"
    )
    r = _commit(
        client,
        [
            {
                "kind": "create_artifact",
                "temp_id": "tmp_rules",
                "artifact_kind": "validation_rules",
                "name": "house-rules",
                "payload": {"schema_version": 1, "yaml": drift_yaml},
            }
        ],
    )
    assert r.status_code == 200, r.text
    artifact_id = r.json()["id_map"]["tmp_rules"]

    body = client.get(f"{API}/model/issues").json()
    status = body["rules_status"]
    assert status["total"] == 0
    (skip,) = status["skipped"]
    assert skip["artifact_id"] == artifact_id
    assert skip["rule"] == "bogus-rule"
    assert "Bogus" in skip["reason"]

    lock_res = client.post(
        f"{API}/locks",
        json={
            "targets": [
                {"resource_id": artifact_id, "mode": "exclusive", "type": "artifact"}
            ],
            "intent": "edit",
        },
    )
    assert lock_res.status_code == 200, lock_res.text
    token = lock_res.json()["token"]

    clean_yaml = (
        "rules:\n"
        "  - name: has-tag\n"
        "    applies_to: Item\n"
        "    then: {property: tag, exists: true}\n"
    )
    r = _commit(
        client,
        [
            {
                "kind": "update_artifact",
                "id": artifact_id,
                "payload": {"schema_version": 1, "yaml": clean_yaml},
            }
        ],
        lock_tokens=[token],
    )
    assert r.status_code == 200, r.text

    body = client.get(f"{API}/model/issues").json()
    status = body["rules_status"]
    assert status["total"] == 1
    assert status["skipped"] == []


def test_membership_enforced(client: TestClient) -> None:
    stranger = {"x-user-id": "stranger", "x-user-email": "s@x.io"}
    res = client.get(f"{API}/model/issues", headers=stranger)
    assert res.status_code == 403
    res = client.get(
        "/api/v1/projects/nope/model/issues", headers=AUTH_HEADERS
    )
    assert res.status_code == 404
