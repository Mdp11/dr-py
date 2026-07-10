"""Tests for the paged/on-demand read endpoints (Phase C2-read):

GET /model/summary, /model/elements (paged + search), /model/elements/{id}/
neighborhood, /model/elements/{id}/relationships, /model/containment/roots,
/model/elements/{id}/children, /model/changes, /model/changes/summary.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import data_rover.api.session as session_module
from data_rover.api.main import create_app
from data_rover.api.routes.read import MAX_PAGE_LIMIT
# get_session() returns the DEFAULT project's session; the client fixture seeds
# and targets that same project (DEFAULT_PROJECT_ID), so these assertions
# inspect the very session the HTTP requests mutate.
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

READ_MM = """
elements:
  - name: Item
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
      - {name: note, datatype: string}
  - name: Tag
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
  - name: Links
    containment: false
    source: Item
    target: Item
    properties:
      - {name: weight, datatype: integer}
"""

API = "/api/v1/projects/default"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/metamodel",
        content=READ_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    return c


def _load_model(client: TestClient, elements: list[dict], relationships: list[dict]):
    res = client.post(
        f"{API}/model", json={"elements": elements, "relationships": relationships}
    )
    assert res.status_code == 200, res.text
    return res.json()


def _item(eid: str, name: str | None = None, **props) -> dict:
    properties = dict(props)
    if name is not None:
        properties["name"] = name
    return {"id": eid, "type_name": "Item", "properties": properties}


def _rel(rid: str, type_name: str, source: str, target: str, **props) -> dict:
    return {
        "id": rid,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": dict(props),
    }


def _post_ops(client: TestClient, ops: list[dict]) -> dict:
    res = client.post(
        f"{API}/model/ops",
        json={"base_rev": get_session().model_rev, "ops": ops},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _entity_state(model_json: dict) -> tuple[dict, dict]:
    """Rev-insensitive entity-wise view of a ModelOut JSON document."""
    elements = {
        e["id"]: (e["type_name"], e["properties"]) for e in model_json["elements"]
    }
    relationships = {
        r["id"]: (r["type_name"], r["source_id"], r["target_id"], r["properties"])
        for r in model_json["relationships"]
    }
    return elements, relationships


# ---------------------------------------------------------------------------
# GET /model/summary
# ---------------------------------------------------------------------------


def test_summary_404_without_model() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    assert c.get(f"{API}/model/summary").status_code == 404  # no metamodel
    res = c.post(
        f"{API}/metamodel",
        content=READ_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200
    assert c.get(f"{API}/model/summary").status_code == 404  # no model


def test_summary_counts_and_not_validated(client: TestClient) -> None:
    _load_model(
        client,
        [
            _item("a", "A"),
            _item("b", "B"),
            {"id": "t1", "type_name": "Tag", "properties": {"name": "T"}},
        ],
        [_rel("r-ab", "Links", "a", "b", weight=2)],
    )
    res = client.get(f"{API}/model/summary")
    assert res.status_code == 200
    body = res.json()
    assert body["element_count"] == 3
    assert body["relationship_count"] == 1
    assert body["elements_by_type"] == {"Item": 2, "Tag": 1}
    # null (not {}): the model has not been validated yet
    assert body["issue_counts"] is None
    assert body["undo_depth"] == 0
    assert body["model_rev"] == get_session().model_rev


def test_summary_after_validate_and_ops(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    res = client.post(f"{API}/model/validate")
    assert res.status_code == 200 and res.json() == []
    body = client.get(f"{API}/model/summary").json()
    assert body["issue_counts"] == {}  # validated, zero issues — not null

    _post_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_1",
                "type_name": "Item",
                "properties": {},  # missing required name -> an issue
            }
        ],
    )
    body = client.get(f"{API}/model/summary").json()
    assert body["element_count"] == 2
    assert body["undo_depth"] == 1
    assert body["issue_counts"] == {"error": 1}


def test_read_endpoints_do_not_mutate_session(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    rev = get_session().model_rev
    for path in (
        "/model/summary",
        "/model/elements",
        "/model/elements/a/neighborhood",
        "/model/elements/a/relationships",
        "/model/containment/roots",
        "/model/elements/a/children",
        "/model/changes",
        "/model/changes/summary",
    ):
        assert client.get(f"{API}{path}").status_code == 200, path
    assert get_session().model_rev == rev
    assert get_session().op_log == []


# ---------------------------------------------------------------------------
# GET /model/elements — paging + search
# ---------------------------------------------------------------------------


def test_elements_insertion_order_and_paging(client: TestClient) -> None:
    _load_model(
        client,
        [
            _item("i1", "N1"),
            {"id": "t1", "type_name": "Tag", "properties": {"name": "T1"}},
            _item("i2", "N2"),
            _item("i3", "N3"),
        ],
        [],
    )
    body = client.get(f"{API}/model/elements").json()
    assert body["total"] == 4
    assert [e["id"] for e in body["items"]] == ["i1", "t1", "i2", "i3"]

    body = client.get(f"{API}/model/elements", params={"limit": 2}).json()
    assert body["total"] == 4
    assert [e["id"] for e in body["items"]] == ["i1", "t1"]

    body = client.get(f"{API}/model/elements", params={"limit": 2, "offset": 3}).json()
    assert body["total"] == 4
    assert [e["id"] for e in body["items"]] == ["i3"]

    # exact-type filter, insertion order preserved, total before paging
    body = client.get(f"{API}/model/elements", params={"type": "Item"}).json()
    assert body["total"] == 3
    assert [e["id"] for e in body["items"]] == ["i1", "i2", "i3"]
    body = client.get(
        f"{API}/model/elements", params={"type": "Item", "limit": 1, "offset": 1}
    ).json()
    assert body["total"] == 3
    assert [e["id"] for e in body["items"]] == ["i2"]

    body = client.get(f"{API}/model/elements", params={"type": "Nope"}).json()
    assert body == {"items": [], "total": 0}

    # offset beyond total
    body = client.get(f"{API}/model/elements", params={"offset": 99}).json()
    assert body == {"items": [], "total": 4}


def test_search_ranks_exact_name_above_substring(client: TestClient) -> None:
    """An exact name match must top the results even when a junk substring
    match also hits the id and another property (the old flat +2-per-name
    scoring let such junk outrank the element the user actually wanted)."""
    _load_model(
        client,
        [
            # junk: name only CONTAINS the query, but it also matches on id and
            # on a second property — three weak hits the old scoring summed past
            # a single exact-name hit.
            _item("some_name", "PRETEXTsome_name", note="also some_name here"),
            _item("e-prefix", "some_name extended"),  # name prefix
            _item("e-exact", "some_name"),  # name exact (case-insensitive)
            _item("e-word", "left some_name right"),  # name word-boundary
        ],
        [],
    )
    body = client.get(f"{API}/model/elements", params={"q": "some_name"}).json()
    ids = [e["id"] for e in body["items"]]
    assert ids == ["e-exact", "e-prefix", "e-word", "some_name"]


def test_elements_search_scoring_tiers(client: TestClient) -> None:
    _load_model(
        client,
        [
            _item("e-d", "unrelated"),  # no match -> excluded
            _item("e-c", "Nope2", note="contains alpha here"),  # prop +0.5
            _item("e-b", "Alpha One"),  # name prefix (case-insensitive)
            _item("alpha-x", "Nope"),  # id substring +2
            _item("e-a", "Alpha Two"),  # name prefix, equal len -> id order
        ],
        [],
    )
    body = client.get(f"{API}/model/elements", params={"q": "ALPHA"}).json()
    assert body["total"] == 4
    # name-prefix tier (e-a, e-b; id tiebreak) >> id substring >> property hit
    assert [e["id"] for e in body["items"]] == ["e-a", "e-b", "alpha-x", "e-c"]

    # paging respects the scored order; total stays pre-paging
    body = client.get(f"{API}/model/elements", params={"q": "alpha", "limit": 2}).json()
    assert (body["total"], [e["id"] for e in body["items"]]) == (4, ["e-a", "e-b"])
    body = client.get(
        f"{API}/model/elements", params={"q": "alpha", "limit": 2, "offset": 2}
    ).json()
    assert [e["id"] for e in body["items"]] == ["alpha-x", "e-c"]

    # type-name substring scores too (+1)
    body = client.get(f"{API}/model/elements", params={"q": "item"}).json()
    assert body["total"] == 5

    # blank q behaves as no q: insertion order, everything included
    body = client.get(f"{API}/model/elements", params={"q": "   "}).json()
    assert body["total"] == 5
    assert [e["id"] for e in body["items"]][:2] == ["e-d", "e-c"]

    # q + type filter combine
    body = client.get(
        f"{API}/model/elements", params={"q": "alpha", "type": "Item"}
    ).json()
    assert body["total"] == 4


def test_elements_search_is_deterministic(client: TestClient) -> None:
    _load_model(client, [_item(f"i{n}", f"alpha {n}") for n in range(10)], [])
    first = client.get(f"{API}/model/elements", params={"q": "alpha"}).json()
    second = client.get(f"{API}/model/elements", params={"q": "alpha"}).json()
    assert first == second


def test_elements_paging_validation(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    for params in (
        {"limit": 0},
        {"limit": 501},
        {"offset": -1},
    ):
        res = client.get(f"{API}/model/elements", params=params)
        assert res.status_code == 422, params


# ---------------------------------------------------------------------------
# GET /model/elements/{id}/neighborhood
# ---------------------------------------------------------------------------


@pytest.fixture
def graph_client(client: TestClient) -> TestClient:
    """c--n1--n3--n5 chain plus incoming n2->c and n4->n2."""
    _load_model(
        client,
        [_item(e, e.upper()) for e in ("c", "n1", "n2", "n3", "n4", "n5")],
        [
            _rel("r1", "Links", "c", "n1"),
            _rel("r2", "Links", "n2", "c"),
            _rel("r3", "Links", "n1", "n3"),
            _rel("r4", "Links", "n4", "n2"),
            _rel("r5", "Links", "n3", "n5"),
        ],
    )
    return client


def test_neighborhood_hops_and_directions(graph_client: TestClient) -> None:
    # hops=1: both edge directions are traversed (n2 reaches c via incoming)
    body = graph_client.get(
        f"{API}/model/elements/c/neighborhood", params={"hops": 1}
    ).json()
    assert {n["id"] for n in body["nodes"]} == {"c", "n1", "n2"}
    assert body["hops_by_id"] == {"c": 0, "n1": 1, "n2": 1}
    assert {e["id"] for e in body["edges"]} == {"r1", "r2"}
    assert body["truncated"] is False

    body = graph_client.get(
        f"{API}/model/elements/c/neighborhood", params={"hops": 2}
    ).json()
    assert body["hops_by_id"] == {"c": 0, "n1": 1, "n2": 1, "n3": 2, "n4": 2}
    # only edges with BOTH endpoints included (r5 leads to excluded n5)
    assert {e["id"] for e in body["edges"]} == {"r1", "r2", "r3", "r4"}
    assert body["truncated"] is False

    body = graph_client.get(
        f"{API}/model/elements/c/neighborhood", params={"hops": 3}
    ).json()
    assert body["hops_by_id"]["n5"] == 3
    assert {e["id"] for e in body["edges"]} == {"r1", "r2", "r3", "r4", "r5"}


def test_neighborhood_cap_truncation(graph_client: TestClient) -> None:
    # cap 2: center + one neighbor; deterministic pick = lowest incident rel
    # id of the frontier node (r1 -> n1); everything else is dropped
    body = graph_client.get(
        f"{API}/model/elements/c/neighborhood", params={"hops": 2, "cap": 2}
    ).json()
    assert [n["id"] for n in body["nodes"]] == ["c", "n1"]
    assert body["hops_by_id"] == {"c": 0, "n1": 1}
    assert [e["id"] for e in body["edges"]] == ["r1"]
    assert body["truncated"] is True

    # cap exactly fitting the reachable set is not truncated
    body = graph_client.get(
        f"{API}/model/elements/c/neighborhood", params={"hops": 1, "cap": 3}
    ).json()
    assert body["truncated"] is False


def test_neighborhood_leaf_and_isolated(graph_client: TestClient) -> None:
    body = graph_client.get(
        f"{API}/model/elements/n5/neighborhood", params={"hops": 1}
    ).json()
    assert body["hops_by_id"] == {"n5": 0, "n3": 1}
    assert [e["id"] for e in body["edges"]] == ["r5"]


def test_neighborhood_errors(graph_client: TestClient) -> None:
    assert (
        graph_client.get(f"{API}/model/elements/ghost/neighborhood").status_code == 404
    )
    for params in ({"hops": 0}, {"hops": 6}, {"cap": 0}, {"cap": 501}):
        res = graph_client.get(f"{API}/model/elements/c/neighborhood", params=params)
        assert res.status_code == 422, params


# ---------------------------------------------------------------------------
# GET /model/elements/{id}/relationships
# ---------------------------------------------------------------------------


def test_relationships_direction_filters(graph_client: TestClient) -> None:
    out = graph_client.get(
        f"{API}/model/elements/c/relationships", params={"direction": "out"}
    ).json()
    assert ([r["id"] for r in out["items"]], out["total"]) == (["r1"], 1)

    inc = graph_client.get(
        f"{API}/model/elements/c/relationships", params={"direction": "in"}
    ).json()
    assert ([r["id"] for r in inc["items"]], inc["total"]) == (["r2"], 1)

    both = graph_client.get(f"{API}/model/elements/c/relationships").json()
    assert [r["id"] for r in both["items"]] == ["r1", "r2"]  # sorted by rel id
    assert both["total"] == 2
    assert both["items"][0]["source_id"] == "c"

    none = graph_client.get(f"{API}/model/elements/n5/relationships").json()
    assert ([r["id"] for r in none["items"]], none["total"]) == (["r5"], 1)

    res = graph_client.get(f"{API}/model/elements/ghost/relationships")
    assert res.status_code == 404
    # same envelope as the rest of the /model/elements/{id} family (errors.py
    # KeyError handler), not FastAPI's HTTPException {"detail": ...}
    body = res.json()
    assert set(body) == {"error"}
    assert "ghost" in body["error"]
    res = graph_client.get(
        f"{API}/model/elements/c/relationships", params={"direction": "sideways"}
    )
    assert res.status_code == 422


def test_relationships_paging(graph_client: TestClient) -> None:
    # n2 has r2 (out) and r4 (in); page over the sorted incident set
    body = graph_client.get(
        f"{API}/model/elements/n2/relationships", params={"limit": 1}
    ).json()
    assert ([r["id"] for r in body["items"]], body["total"]) == (["r2"], 2)
    body = graph_client.get(
        f"{API}/model/elements/n2/relationships", params={"limit": 1, "offset": 1}
    ).json()
    assert ([r["id"] for r in body["items"]], body["total"]) == (["r4"], 2)
    # offset beyond the incident set: empty page, total before paging
    body = graph_client.get(
        f"{API}/model/elements/n2/relationships", params={"offset": 9}
    ).json()
    assert body == {"items": [], "total": 2}

    for params in ({"limit": 0}, {"limit": 501}, {"offset": -1}):
        res = graph_client.get(f"{API}/model/elements/n2/relationships", params=params)
        assert res.status_code == 422, params


def test_relationships_self_loop_dedup(client: TestClient) -> None:
    """A self-loop is in BOTH incidence indexes; direction=both lists it once."""
    _load_model(
        client,
        [_item("s", "S"), _item("o", "O")],
        [
            _rel("r-loop", "Links", "s", "s"),
            _rel("r-so", "Links", "s", "o"),
        ],
    )
    both = client.get(f"{API}/model/elements/s/relationships").json()
    assert [r["id"] for r in both["items"]] == ["r-loop", "r-so"]
    assert both["total"] == 2

    out = client.get(
        f"{API}/model/elements/s/relationships", params={"direction": "out"}
    ).json()
    assert [r["id"] for r in out["items"]] == ["r-loop", "r-so"]
    inc = client.get(
        f"{API}/model/elements/s/relationships", params={"direction": "in"}
    ).json()
    assert ([r["id"] for r in inc["items"]], inc["total"]) == (["r-loop"], 1)


# ---------------------------------------------------------------------------
# Containment roots/children
# ---------------------------------------------------------------------------


@pytest.fixture
def tree_client(client: TestClient) -> TestClient:
    """p contains c1 ("Beta") and c2 ("Alpha"); q ALSO contains c2 via a later
    relationship (first containment parent wins -> c2 belongs to p);
    c1 contains c3 (which has no name); x is a free root."""
    _load_model(
        client,
        [
            _item("p", "Parent"),
            _item("q", "Other"),
            _item("c1", "Beta"),
            _item("c2", "Alpha"),
            _item("c3"),  # no name -> display name falls back to id
            _item("x", "X"),
        ],
        [
            _rel("rc1", "Contains", "p", "c1"),
            _rel("rc2", "Contains", "p", "c2"),
            _rel("rc3", "Contains", "q", "c2"),  # loses: c2's first parent is p
            _rel("rc4", "Contains", "c1", "c3"),
        ],
    )
    return client


def test_containment_roots(tree_client: TestClient) -> None:
    # display-name order, as ContainmentTree renders: Other (q) < Parent (p) < X
    body = tree_client.get(f"{API}/model/containment/roots").json()
    assert body["total"] == 3
    assert [i["id"] for i in body["items"]] == ["q", "p", "x"]
    assert [i["child_count"] for i in body["items"]] == [0, 2, 0]
    assert [i["display_name"] for i in body["items"]] == ["Other", "Parent", "X"]

    # paging over the sorted level
    body = tree_client.get(
        f"{API}/model/containment/roots", params={"limit": 1, "offset": 1}
    ).json()
    assert body["total"] == 3
    assert [i["id"] for i in body["items"]] == ["p"]


def test_roots_order_follows_mutation_boundary(tree_client: TestClient) -> None:
    """The roots endpoints read the maintained order index, so a rename
    through the core mutation boundary must reorder the next page — without
    any per-request re-sort."""
    session = get_session()
    assert session.model is not None
    # rename free root "x" (display "X", sorts last) to sort first
    session.model.set_property(session.model.elements["x"], "name", "AAA")
    body = tree_client.get(f"{API}/model/containment/roots").json()
    assert [i["id"] for i in body["items"]][0] == "x"
    assert body["total"] == 3


def test_containment_children(tree_client: TestClient) -> None:
    # display-name order, as ContainmentTree renders: Alpha (c2) before Beta (c1)
    body = tree_client.get(f"{API}/model/elements/p/children").json()
    assert body["total"] == 2
    assert [i["id"] for i in body["items"]] == ["c2", "c1"]
    assert [i["child_count"] for i in body["items"]] == [0, 1]
    assert [i["display_name"] for i in body["items"]] == ["Alpha", "Beta"]

    # paging over the sorted level
    body = tree_client.get(
        f"{API}/model/elements/p/children", params={"limit": 1, "offset": 1}
    ).json()
    assert (body["total"], [i["id"] for i in body["items"]]) == (2, ["c1"])

    # q's containment edge to c2 lost (first parent wins) -> no children
    body = tree_client.get(f"{API}/model/elements/q/children").json()
    assert body == {"items": [], "total": 0}

    # nameless child sorts by its id fallback
    body = tree_client.get(f"{API}/model/elements/c1/children").json()
    assert [i["id"] for i in body["items"]] == ["c3"]

    assert tree_client.get(f"{API}/model/elements/ghost/children").status_code == 404
    res = tree_client.get(f"{API}/model/elements/p/children", params={"limit": 0})
    assert res.status_code == 422


def test_containment_non_containment_rels_ignored(client: TestClient) -> None:
    _load_model(
        client,
        [_item("a", "A"), _item("b", "B")],
        [_rel("r-ab", "Links", "a", "b")],
    )
    body = client.get(f"{API}/model/containment/roots").json()
    assert [i["id"] for i in body["items"]] == ["a", "b"]
    body = client.get(f"{API}/model/elements/a/children").json()
    assert body == {"items": [], "total": 0}


# ---------------------------------------------------------------------------
# GET /model/changes (+ /summary)
# ---------------------------------------------------------------------------


def test_changes_empty_log(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    body = client.get(f"{API}/model/changes").json()
    assert body["format"] == "datarover.cr/v1"
    assert body["complete"] is True
    assert body["baseline"] == {
        "filename": None,
        "elementCount": 1,
        "relationshipCount": 0,
    }
    assert body["ops"] == {
        "elements": {"added": [], "modified": [], "deleted": []},
        "relationships": {"added": [], "modified": [], "deleted": []},
    }
    summary = client.get(f"{API}/model/changes/summary").json()
    assert summary == {
        "batches": 0,
        "ops": 0,
        "adds": 0,
        "modifies": 0,
        "deletes": 0,
        "complete": True,
    }


def test_changes_document_shape(client: TestClient) -> None:
    """Create + update + cascade delete, compared against a hand-written
    datarover.cr/v1 document (the buildChangeRequest export shape)."""
    _load_model(
        client,
        [_item("a", "A"), _item("b", "B")],
        [_rel("r-ab", "Links", "a", "b", weight=2)],
    )
    ops_res = _post_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {"name": "New"},
            },
            {"kind": "update_element", "id": "a", "properties_patch": {"note": "hi"}},
            {"kind": "delete_element", "id": "b"},  # cascades r-ab
        ],
    )
    new_id = ops_res["id_map"]["tmp_x"]

    res = client.get(f"{API}/model/changes")
    assert res.status_code == 200
    doc = res.json()
    created_at = doc.pop("createdAt")
    assert isinstance(created_at, str) and created_at.endswith("Z")
    assert doc == {
        "format": "datarover.cr/v1",
        "baseline": {"filename": None, "elementCount": 2, "relationshipCount": 1},
        "complete": True,
        "ops": {
            "elements": {
                "added": [
                    {
                        "id": new_id,
                        "type_name": "Item",
                        "properties": {"name": "New"},
                        "rev": 1,
                    }
                ],
                "modified": [
                    {
                        "id": "a",
                        "before": {
                            "id": "a",
                            "type_name": "Item",
                            "properties": {"name": "A"},
                            "rev": 0,
                        },
                        "after": {
                            "id": "a",
                            "type_name": "Item",
                            "properties": {"name": "A", "note": "hi"},
                            "rev": 1,
                        },
                    }
                ],
                "deleted": [
                    {
                        "id": "b",
                        "type_name": "Item",
                        "properties": {"name": "B"},
                        "rev": 0,
                    }
                ],
            },
            "relationships": {
                "added": [],
                "modified": [],
                "deleted": [
                    {
                        "id": "r-ab",
                        "type_name": "Links",
                        "source_id": "a",
                        "target_id": "b",
                        "properties": {"weight": 2},
                        "rev": 0,
                    }
                ],
            },
        },
    }

    summary = client.get(f"{API}/model/changes/summary").json()
    assert summary == {
        "batches": 1,
        "ops": 4,
        "adds": 1,
        "modifies": 1,
        "deletes": 2,
        "complete": True,
    }


def test_changes_round_trip_through_apply_cr(client: TestClient) -> None:
    """base + GET /model/changes through POST /model/apply-cr == current model."""
    base = _load_model(
        client,
        [_item("p", "P"), _item("ch", "CH"), _item("x", "X")],
        [
            _rel("r-pch", "Contains", "p", "ch"),
            _rel("r-px", "Links", "p", "x", weight=1),
        ],
    )
    # batch 1: create an element and a relationship onto it
    res1 = _post_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_n",
                "type_name": "Item",
                "properties": {"name": "N"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Links",
                "source_id": "tmp_n",
                "target_id": "x",
                "properties": {"weight": 7},
            },
        ],
    )
    assert "tmp_r" in res1["id_map"]
    # batch 2: modify an element and a relationship
    _post_ops(
        client,
        [
            {"kind": "update_element", "id": "x", "properties_patch": {"note": "xx"}},
            {
                "kind": "update_relationship",
                "id": "r-px",
                "properties_patch": {"weight": 9},
            },
        ],
    )
    # batch 3: cascade delete (removes p, ch, r-pch and the modified r-px)
    _post_ops(client, [{"kind": "delete_element", "id": "p"}])

    changes = client.get(f"{API}/model/changes").json()
    # modify-then-delete collapses to a delete with the FIRST before-state
    deleted_rels = {r["id"]: r for r in changes["ops"]["relationships"]["deleted"]}
    assert deleted_rels["r-px"]["properties"] == {"weight": 1}

    current = client.get(f"{API}/model").json()
    applied = client.post(f"{API}/model/apply-cr", json={"model": base, "cr": changes})
    assert applied.status_code == 200, applied.text
    assert _entity_state(applied.json()["model"]) == _entity_state(current)


def test_changes_compaction_create_then_modify(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    res = _post_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_z",
                "type_name": "Item",
                "properties": {"name": "Z"},
            }
        ],
    )
    zid = res["id_map"]["tmp_z"]
    _post_ops(
        client,
        [{"kind": "update_element", "id": zid, "properties_patch": {"note": "zz"}}],
    )
    ops = client.get(f"{API}/model/changes").json()["ops"]
    assert [e["id"] for e in ops["elements"]["added"]] == [zid]
    assert ops["elements"]["added"][0]["properties"] == {"name": "Z", "note": "zz"}
    assert ops["elements"]["modified"] == []
    assert ops["elements"]["deleted"] == []


def test_changes_compaction_create_then_delete_is_omitted(
    client: TestClient,
) -> None:
    _load_model(client, [_item("a", "A")], [])
    res = _post_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_y",
                "type_name": "Item",
                "properties": {"name": "Y"},
            }
        ],
    )
    _post_ops(client, [{"kind": "delete_element", "id": res["id_map"]["tmp_y"]}])
    body = client.get(f"{API}/model/changes").json()
    assert body["ops"] == {
        "elements": {"added": [], "modified": [], "deleted": []},
        "relationships": {"added": [], "modified": [], "deleted": []},
    }
    assert body["baseline"]["elementCount"] == 1  # base == current
    summary = client.get(f"{API}/model/changes/summary").json()
    assert (summary["batches"], summary["ops"]) == (2, 0)


def test_changes_compaction_modify_twice(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    _post_ops(
        client,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "1st"}}],
    )
    _post_ops(
        client,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "2nd"}}],
    )
    mods = client.get(f"{API}/model/changes").json()["ops"]["elements"]["modified"]
    assert len(mods) == 1
    # FIRST before-state (note absent), LAST after-state
    assert mods[0]["before"]["properties"] == {"name": "A"}
    assert mods[0]["after"]["properties"] == {"name": "A", "note": "2nd"}


def test_changes_relationship_modified_shape(client: TestClient) -> None:
    """A surviving relationship update appears in relationships.modified with
    the first before-state and last after-state (full before/after shape)."""
    _load_model(
        client,
        [_item("a", "A"), _item("b", "B")],
        [_rel("r-ab", "Links", "a", "b", weight=1)],
    )
    _post_ops(
        client,
        [
            {
                "kind": "update_relationship",
                "id": "r-ab",
                "properties_patch": {"weight": 5},
            }
        ],
    )
    _post_ops(
        client,
        [
            {
                "kind": "update_relationship",
                "id": "r-ab",
                "properties_patch": {"weight": 9},
            }
        ],
    )
    ops = client.get(f"{API}/model/changes").json()["ops"]
    assert ops["elements"] == {"added": [], "modified": [], "deleted": []}
    assert ops["relationships"]["added"] == []
    assert ops["relationships"]["deleted"] == []
    assert ops["relationships"]["modified"] == [
        {
            "id": "r-ab",
            "before": {
                "id": "r-ab",
                "type_name": "Links",
                "source_id": "a",
                "target_id": "b",
                "properties": {"weight": 1},  # FIRST before-state
                "rev": 0,
            },
            "after": {
                "id": "r-ab",
                "type_name": "Links",
                "source_id": "a",
                "target_id": "b",
                "properties": {"weight": 9},  # LAST after-state
                "rev": 2,
            },
        }
    ]
    summary = client.get(f"{API}/model/changes/summary").json()
    assert (summary["ops"], summary["modifies"]) == (1, 1)


def test_changes_empty_after_undo(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    _post_ops(
        client,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "n"}}],
    )
    assert client.post(f"{API}/model/undo").status_code == 200
    body = client.get(f"{API}/model/changes").json()
    assert body["ops"]["elements"] == {"added": [], "modified": [], "deleted": []}
    assert body["complete"] is True
    assert client.get(f"{API}/model/summary").json()["undo_depth"] == 0


def test_changes_incomplete_after_op_log_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_module, "OP_LOG_MAX", 1)
    _load_model(client, [_item("a", "A")], [])
    _post_ops(
        client,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "1"}}],
    )
    assert client.get(f"{API}/model/changes").json()["complete"] is True
    _post_ops(
        client,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "2"}}],
    )  # trims the first batch -> history no longer reaches the loaded base
    body = client.get(f"{API}/model/changes").json()
    assert body["complete"] is False
    # the retained history only covers note: 1 -> 2
    mods = body["ops"]["elements"]["modified"]
    assert mods[0]["before"]["properties"] == {"name": "A", "note": "1"}
    summary = client.get(f"{API}/model/changes/summary").json()
    assert summary["complete"] is False
    assert summary["batches"] == 1

    # loading a fresh model resets the truncation marker
    _load_model(client, [_item("a", "A")], [])
    assert client.get(f"{API}/model/changes").json()["complete"] is True


def test_changes_404_without_model(client: TestClient) -> None:
    assert client.get(f"{API}/model/changes").status_code == 404
    assert client.get(f"{API}/model/changes/summary").status_code == 404


# ---------------------------------------------------------------------------
# POST /model/elements/batch
# ---------------------------------------------------------------------------


def test_elements_batch_returns_known_in_request_order_omits_unknown(
    client: TestClient,
) -> None:
    _load_model(client, [_item("a", "A"), _item("b", "B"), _item("c", "C")], [])
    res = client.post(
        f"{API}/model/elements/batch", json={"ids": ["c", "missing", "a"]}
    )
    assert res.status_code == 200, res.text
    ids = [e["id"] for e in res.json()["items"]]
    assert ids == ["c", "a"]  # request order preserved; unknown id dropped


def test_elements_batch_empty_ids_returns_empty(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    res = client.post(f"{API}/model/elements/batch", json={"ids": []})
    assert res.status_code == 200
    assert res.json()["items"] == []


def test_elements_batch_rejects_oversized(client: TestClient) -> None:
    _load_model(client, [_item("a", "A")], [])
    res = client.post(
        f"{API}/model/elements/batch",
        json={"ids": [str(n) for n in range(MAX_PAGE_LIMIT + 1)]},
    )
    assert res.status_code == 422
    assert str(MAX_PAGE_LIMIT) in res.json()["detail"]


def test_elements_batch_404_without_model() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    c.post(
        f"{API}/metamodel",
        content=READ_MM,
        headers={"content-type": "application/x-yaml"},
    )
    res = c.post(f"{API}/model/elements/batch", json={"ids": ["a"]})
    assert res.status_code == 404  # no model loaded


# ---------------------------------------------------------------------------
# POST /model/elements/tree-items
# ---------------------------------------------------------------------------


def test_tree_items_endpoint_projects_and_omits_unknown(client: TestClient) -> None:
    _load_model(client, [_item("a", "Apple"), _item("b")], [])
    res = client.post(f"{API}/model/elements/tree-items", json={"ids": ["a", "b", "nope"]})
    assert res.status_code == 200, res.text
    items = res.json()["items"]
    assert [i["id"] for i in items] == ["a", "b"]  # unknown "nope" omitted, order preserved
    assert items[0]["display_name"] == "Apple"
    assert items[1]["display_name"] == "b"  # no name -> id
    assert set(items[0].keys()) == {"id", "type_name", "display_name", "child_count"}


def test_tree_items_endpoint_rejects_oversized_batch(client: TestClient) -> None:
    _load_model(client, [_item("a", "Apple")], [])
    res = client.post(
        f"{API}/model/elements/tree-items",
        json={"ids": [str(n) for n in range(MAX_PAGE_LIMIT + 1)]},
    )
    assert res.status_code == 422
    assert str(MAX_PAGE_LIMIT) in res.json()["detail"]


# ---------------------------------------------------------------------------
# GET /model/containment/roots/excluded
# ---------------------------------------------------------------------------


def _put_view(client: TestClient, folders: list[dict]) -> None:
    res = client.put(f"{API}/view/snapshot", json={"name": "v", "folders": folders})
    assert res.status_code == 200, res.text


def test_excluded_roots_omits_placed(client: TestClient) -> None:
    _load_model(client, [_item("a", "A"), _item("b", "B"), _item("c", "C")], [])
    _put_view(client, [{"name": "F", "folders": [], "elements": ["b"]}])
    res = client.get(f"{API}/model/containment/roots/excluded")
    assert res.status_code == 200, res.text
    body = res.json()
    assert [i["id"] for i in body["items"]] == ["a", "c"]
    assert body["total"] == 2


def test_excluded_roots_nested_folder_placement(client: TestClient) -> None:
    _load_model(client, [_item("a", "A"), _item("b", "B")], [])
    _put_view(
        client,
        [
            {
                "name": "F",
                "folders": [{"name": "G", "folders": [], "elements": ["a"]}],
                "elements": [],
            }
        ],
    )
    res = client.get(f"{API}/model/containment/roots/excluded")
    assert [i["id"] for i in res.json()["items"]] == ["b"]


def test_excluded_roots_no_view_returns_all_roots(client: TestClient) -> None:
    _load_model(client, [_item("a", "A"), _item("b", "B")], [])
    res = client.get(f"{API}/model/containment/roots/excluded")
    assert [i["id"] for i in res.json()["items"]] == ["a", "b"]
    assert res.json()["total"] == 2


def test_excluded_roots_paging(client: TestClient) -> None:
    _load_model(client, [_item(f"i{n}", f"n{n}") for n in range(5)], [])
    res = client.get(
        f"{API}/model/containment/roots/excluded", params={"limit": 2, "offset": 2}
    )
    body = res.json()
    assert [i["id"] for i in body["items"]] == ["i2", "i3"]
    assert body["total"] == 5


def test_excluded_roots_paging_over_filtered_subset(client: TestClient) -> None:
    # Placed ids must be subtracted BEFORE paging: with i0 and i2 in the view,
    # the excluded pool is [i1, i3, i4], so limit=2/offset=1 -> [i3, i4].
    _load_model(client, [_item(f"i{n}", f"n{n}") for n in range(5)], [])
    _put_view(client, [{"name": "F", "folders": [], "elements": ["i0", "i2"]}])
    res = client.get(
        f"{API}/model/containment/roots/excluded", params={"limit": 2, "offset": 1}
    )
    body = res.json()
    assert [i["id"] for i in body["items"]] == ["i3", "i4"]
    assert body["total"] == 3
