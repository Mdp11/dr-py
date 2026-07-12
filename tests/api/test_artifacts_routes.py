"""Artifacts CRUD: project-scoped, membership-authorized, optimistic-rev
guarded, payload-validated per kind (Stage 1: navigation only)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

NAV_PAYLOAD = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [{"kind": "relationship", "relationship_type": "BlockHasPart"}],
}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _create(client: TestClient, name: str = "My nav") -> dict:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": name, "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_create_get_list_roundtrip(client: TestClient) -> None:
    created = _create(client)
    assert created["artifact_rev"] == 1
    assert created["payload"]["kind"] == "path"

    got = client.get(f"{API}/artifacts/{created['id']}").json()
    assert got["name"] == "My nav"

    listed = client.get(f"{API}/artifacts", params={"kind": "navigation"}).json()
    assert [a["id"] for a in listed["items"]] == [created["id"]]
    # headers carry no payload
    assert "payload" not in listed["items"][0]


def test_create_duplicate_name_409(client: TestClient) -> None:
    _create(client)
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "My nav", "payload": NAV_PAYLOAD},
    )
    assert res.status_code == 409


def test_create_invalid_payload_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "bad", "payload": {"kind": "nope"}},
    )
    assert res.status_code == 422


def test_create_unsupported_kind_422(client: TestClient) -> None:
    res = client.post(
        f"{API}/artifacts", json={"kind": "table", "name": "t", "payload": {}}
    )
    assert res.status_code == 422


def test_update_rev_conflict_and_success(client: TestClient) -> None:
    created = _create(client)
    stale = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 99, "name": "renamed"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["current_rev"] == 1

    ok = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "renamed"},
    )
    assert ok.status_code == 200
    assert ok.json()["artifact_rev"] == 2
    assert ok.json()["name"] == "renamed"


def test_delete_then_404(client: TestClient) -> None:
    created = _create(client)
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 204
    assert client.get(f"{API}/artifacts/{created['id']}").status_code == 404
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 404


def test_writes_broadcast_artifact_events(client: TestClient) -> None:
    events: list[dict] = []
    hub = get_session().hub
    original = hub.broadcast
    hub.broadcast = events.append  # type: ignore[method-assign]
    try:
        created = _create(client)
        client.put(
            f"{API}/artifacts/{created['id']}",
            json={"artifact_rev": 1, "name": "n2"},
        )
        client.delete(f"{API}/artifacts/{created['id']}")
    finally:
        hub.broadcast = original  # type: ignore[method-assign]
    kinds = [(e["type"], e["action"]) for e in events]
    assert kinds == [("artifact", "created"), ("artifact", "updated"),
                     ("artifact", "deleted")]
    assert events[0]["artifact"]["name"] == "My nav"


# ---------------------------------------------------------------------------
# POST /navigations/evaluate
# ---------------------------------------------------------------------------

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


def _bootstrap_model(client: TestClient) -> dict[str, str]:
    """example.metamodel.yaml: Block (mass), BlockHasPart (containment,
    Block->Block), Satisfies (Block->Requirement). Build: root -has-> p1, p2."""
    client.post(
        f"{API}/metamodel",
        content=EXAMPLE.read_text(encoding="utf-8"),
        headers={"content-type": "application/x-yaml"},
    )
    client.post(f"{API}/model", json={"elements": [], "relationships": []})
    ids: dict[str, str] = {}
    for name in ["root", "p1", "p2"]:
        res = client.post(
            f"{API}/model/elements",
            json={"type": "Block", "properties": {"name": name, "mass": 1.0}},
        )
        ids[name] = res.json()["id"]
    for child in ["p1", "p2"]:
        client.post(
            f"{API}/model/relationships",
            json={"type": "BlockHasPart", "source_id": ids["root"],
                  "target_id": ids[child]},
        )
    return ids


def test_evaluate_inline_definition(client: TestClient) -> None:
    ids = _bootstrap_model(client)
    res = client.post(
        f"{API}/navigations/evaluate",
        json={"definition": {
            "kind": "path",
            "start": {"kind": "scope", "types": ["Block"],
                      "criteria": [{"type": "name_id", "field": "name",
                                    "op": "equals", "value": "root"}]},
            "steps": [{"kind": "relationship", "relationship_type": "BlockHasPart"}],
        }},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["step_types"] == ["BlockHasPart"]
    assert body["total"] == 2 and body["truncated"] is False
    chains = body["chains"]
    assert all(len(c) == 2 for c in chains)
    assert {c[1]["id"] for c in chains} == {ids["p1"], ids["p2"]}
    assert chains[0][0]["display_name"] == "root"  # TreeItem projection


def test_evaluate_inline_definition_exclude_visited_false_allows_revisit(
    client: TestClient,
) -> None:
    ids = _bootstrap_model(client)
    res = client.post(
        f"{API}/navigations/evaluate",
        json={"definition": {
            "kind": "path",
            "start": {"kind": "scope", "types": ["Block"],
                      "criteria": [{"type": "name_id", "field": "name",
                                    "op": "equals", "value": "root"}]},
            "steps": [{"kind": "relationship", "relationship_type": "BlockHasPart",
                       "direction": "out"},
                      {"kind": "relationship", "relationship_type": "BlockHasPart",
                       "direction": "in"}],
            "exclude_visited": False,
        }},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["total"] == 2 and body["truncated"] is False
    revisit_chains = {tuple(el["id"] for el in chain) for chain in body["chains"]}
    assert revisit_chains == {
        (ids["root"], ids["p1"], ids["root"]),
        (ids["root"], ids["p2"], ids["root"]),
    }


def test_evaluate_saved_artifact_and_paging(client: TestClient) -> None:
    _bootstrap_model(client)
    nav = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Block"]},
        "steps": [],
    }
    created = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "all blocks", "payload": nav},
    ).json()
    page = client.post(
        f"{API}/navigations/evaluate",
        json={"artifact_id": created["id"], "limit": 2, "offset": 2},
    ).json()
    assert page["total"] == 3
    assert len(page["chains"]) == 1  # 3 chains, offset 2


def test_evaluate_requires_exactly_one_source(client: TestClient) -> None:
    _bootstrap_model(client)
    assert client.post(f"{API}/navigations/evaluate", json={}).status_code == 422


def test_evaluate_unknown_artifact_422(client: TestClient) -> None:
    _bootstrap_model(client)
    res = client.post(
        f"{API}/navigations/evaluate", json={"artifact_id": "ghost"}
    )
    assert res.status_code == 422


def test_evaluate_ref_cycle_422(client: TestClient) -> None:
    _bootstrap_model(client)
    a = client.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "a",
              "payload": {"kind": "set_op", "op": "union",
                          "operands": [{"ref": "placeholder"}]}},
    ).json()
    # point a at itself
    client.put(
        f"{API}/artifacts/{a['id']}",
        json={"artifact_rev": 1,
              "payload": {"kind": "set_op", "op": "union",
                          "operands": [{"ref": a["id"]}]}},
    )
    res = client.post(
        f"{API}/navigations/evaluate", json={"artifact_id": a["id"]}
    )
    assert res.status_code == 422
    assert "cycle" in res.text


def test_evaluate_row_rooted_navigation_binds_row_element(client: TestClient) -> None:
    ids = _bootstrap_model(client)
    root_id = ids["root"]  # has outgoing BlockHasPart to p1, p2
    body = {
        "definition": {
            "kind": "path",
            "start": {"kind": "row"},
            "steps": [{"kind": "relationship",
                       "relationship_type": "BlockHasPart", "direction": "out"}],
        },
        "row_element_id": root_id,
    }
    res = client.post(f"{API}/navigations/evaluate", json=body)
    assert res.status_code == 200, res.text
    chains = res.json()["chains"]
    assert all(chain[0]["id"] == root_id for chain in chains)


def test_evaluate_row_rooted_without_binding_422(client: TestClient) -> None:
    _bootstrap_model(client)
    body = {"definition": {"kind": "path", "start": {"kind": "row"}, "steps": []}}
    res = client.post(f"{API}/navigations/evaluate", json=body)
    assert res.status_code == 422


def test_viewer_can_evaluate_but_not_create(client: TestClient) -> None:
    """/navigations/evaluate must be on the read-only POST allowlist."""
    _bootstrap_model(client)
    from data_rover.api import tenancy
    from data_rover.api.db import db_session
    from data_rover.api.db_models import Role

    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1",
                           role=Role.viewer)
    viewer = TestClient(create_app())
    viewer.headers.update({"x-user-id": "viewer-1", "x-user-email": "v@example.com"})
    ok = viewer.post(
        f"{API}/navigations/evaluate",
        json={"definition": {"kind": "path",
                             "start": {"kind": "scope", "types": ["Block"]},
                             "steps": []}},
    )
    assert ok.status_code == 200
    denied = viewer.post(
        f"{API}/artifacts",
        json={"kind": "navigation", "name": "x",
              "payload": {"kind": "path",
                          "start": {"kind": "scope"}, "steps": []}},
    )
    assert denied.status_code == 403
