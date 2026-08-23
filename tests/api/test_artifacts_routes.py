"""Artifacts CRUD: project-scoped, membership-authorized, optimistic-rev
guarded, payload-validated per kind (Stage 1: navigation only)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.db_models import Role, User
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, papi, seed_default_project

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


def test_snippet_entry_points_are_server_derived(client: TestClient) -> None:
    body = {
        "kind": "code_snippet",
        "name": "col1",
        "payload": {
            "schema_version": 1, "language": "python",
            "code": "def value(el):\n    return len(el.name)\n",
            "entry_points": ["lies"],  # client lie, must be overwritten
        },
    }
    r = client.post(papi("/artifacts"), json=body)
    assert r.status_code == 201, r.text
    got = r.json()["payload"]["entry_points"]
    assert set(got) == {"script", "value"}


def test_create_code_snippet_invalid_payload_rejected(client: TestClient) -> None:
    # Adapter registered: schema violations (non-python language) still 422.
    r = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "s1", "payload": {"schema_version": 1, "language": "ruby", "code": "x = 1"}},
    )
    assert r.status_code == 422, r.text


def test_snippet_header_carries_entry_points(client: TestClient) -> None:
    code = "def value(el):\n    return el.name\n"
    created = client.post(
        papi("/artifacts"),
        json={"kind": "code_snippet", "name": "snip", "payload": {"code": code}},
    )
    assert created.status_code == 201, created.text
    assert sorted(created.json()["entry_points"]) == ["script", "value"]

    listed = client.get(papi("/artifacts"))
    row = next(a for a in listed.json()["items"] if a["id"] == created.json()["id"])
    assert sorted(row["entry_points"]) == ["script", "value"]


def test_non_snippet_header_entry_points_is_none(client: TestClient) -> None:
    created = _create(client)
    listed = client.get(papi("/artifacts"))
    row = next(a for a in listed.json()["items"] if a["id"] == created["id"])
    assert row["entry_points"] is None


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


# ---------------------------------------------------------------------------
# Peer-lease guard on the legacy write routes.
# `art:` leases only mean anything if EVERY writer to the row honours them:
# without this, an editor holding `art:X` mid-edit can have their commit
# silently overwrite (or be overwritten by) a legacy PUT/DELETE.
# ---------------------------------------------------------------------------

OTHER_HEADERS = {"x-user-id": "user-2", "x-user-email": "user2@example.com"}


def _seed_second_member(user_id: str, email: str) -> None:
    """Add *user_id* as an editor of the default project (mirrors the helper of
    the same name in ``test_commits_artifact_ops.py``) so a peer-lease test
    exercises the 409 lock path rather than authz's 403."""
    gen = db.get_db()
    s = next(gen)
    try:
        if s.get(User, user_id) is None:
            s.add(User(id=user_id, email=email))
            s.commit()
        add_member(s, DEFAULT_PROJECT_ID, user_id, Role.editor)
    finally:
        gen.close()


def _seed_empty_model(client: TestClient) -> None:
    """POST /locks goes through ``require_model``, so a lease test needs a
    loaded (if empty) model even though artifacts are not model content."""
    r = client.post(
        f"{API}/metamodel",
        content="elements:\n  - name: Node\n",
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(f"{API}/model", json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text


def _lock_artifact(client: TestClient, artifact_id: str, **kw: object) -> str:
    r = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": artifact_id, "mode": "exclusive", "type": "artifact"}
            ],
            "intent": "edit",
        },
        **kw,  # type: ignore[arg-type]
    )
    assert r.status_code == 200, r.text
    token: str = r.json()["token"]
    return token


def test_put_409s_while_a_peer_holds_the_artifact_lease(client: TestClient) -> None:
    _seed_empty_model(client)
    created = _create(client)
    _seed_second_member(OTHER_HEADERS["x-user-id"], OTHER_HEADERS["x-user-email"])
    _lock_artifact(client, created["id"], headers=OTHER_HEADERS)
    r = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "stomped"},
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["conflicts"][0]["resource_id"] == f"art:{created['id']}"
    # nothing was written
    assert client.get(f"{API}/artifacts/{created['id']}").json()["name"] == "My nav"


def test_delete_409s_while_a_peer_holds_the_artifact_lease(client: TestClient) -> None:
    _seed_empty_model(client)
    created = _create(client)
    _seed_second_member(OTHER_HEADERS["x-user-id"], OTHER_HEADERS["x-user-email"])
    _lock_artifact(client, created["id"], headers=OTHER_HEADERS)
    r = client.delete(f"{API}/artifacts/{created['id']}")
    assert r.status_code == 409, r.text
    assert client.get(f"{API}/artifacts/{created['id']}").status_code == 200


def test_lease_holder_may_still_use_the_legacy_routes(client: TestClient) -> None:
    """Only a PEER's lease blocks: the holder is the one editing, so their own
    lease must never lock them out of their own write path."""
    _seed_empty_model(client)
    created = _create(client)
    _lock_artifact(client, created["id"])
    r = client.put(
        f"{API}/artifacts/{created['id']}",
        json={"artifact_rev": 1, "name": "mine"},
    )
    assert r.status_code == 200, r.text
    assert client.delete(f"{API}/artifacts/{created['id']}").status_code == 204


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


def test_evaluate_property_step_hops_through_reference_property(
    client: TestClient,
) -> None:
    # A `property`-kind navigation step must flow through the route
    # unchanged. example.metamodel.yaml's
    # Requirement.refines (datatype=Requirement, multiplicity 0..*) is an
    # existing element-reference property, so no metamodel upload is needed.
    _bootstrap_model(client)
    r1 = client.post(
        f"{API}/model/elements",
        json={"type": "Requirement", "properties": {"name": "R1"}},
    ).json()
    r2 = client.post(
        f"{API}/model/elements",
        json={"type": "Requirement",
              "properties": {"name": "R2", "refines": [r1["id"]]}},
    ).json()
    res = client.post(
        f"{API}/navigations/evaluate",
        json={"definition": {
            "kind": "path",
            "start": {"kind": "scope", "types": ["Requirement"],
                      "criteria": [{"type": "name_id", "field": "name",
                                    "op": "equals", "value": "R2"}]},
            "steps": [{"kind": "property", "property_name": "refines"}],
        }},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["step_types"] == ["refines"]
    chains = body["chains"]
    assert len(chains) == 1
    assert [el["id"] for el in chains[0]] == [r2["id"], r1["id"]]


def test_evaluate_scalar_property_step_returns_value_terminal(
    client: TestClient,
) -> None:
    # A path ending in a SCALAR property step returns chains whose terminal is
    # a `{"kind": "value", "value": ...}` node — the property's value — instead
    # of pruning the chain to nothing.
    _bootstrap_model(client)
    r1 = client.post(
        f"{API}/model/elements",
        json={"type": "Requirement", "properties": {"name": "R1", "priority": 3}},
    ).json()
    res = client.post(
        f"{API}/navigations/evaluate",
        json={"definition": {
            "kind": "path",
            "start": {"kind": "scope", "types": ["Requirement"],
                      "criteria": [{"type": "name_id", "field": "name",
                                    "op": "equals", "value": "R1"}]},
            "steps": [{"kind": "property", "property_name": "priority"}],
        }},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["step_types"] == ["priority"]
    assert body["total"] == 1
    chains = body["chains"]
    assert len(chains) == 1
    assert chains[0][0]["id"] == r1["id"]
    assert chains[0][1] == {"kind": "value", "value": 3}


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


def test_create_exporter_artifact(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "exporter",
            "name": "release drop",
            "payload": {"entries": [{"source": {"ref": "tbl-1"}}]},
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201, r.text
    assert r.json()["kind"] == "exporter"


def test_exporter_payload_is_validated_on_create(client: TestClient) -> None:
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "exporter",
            "name": "bad",
            "payload": {"entries": [{"format": "csv"}]},  # no source, bad format
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422
