"""POST /model/search — server-side advanced search.

The advanced-search dialog used to evaluate criteria client-side over only the
fetched subset of a lazily-loaded model, so matches outside the loaded page
were silently missed. These tests pin the server-side engine (a port of
frontend/src/lib/search/evaluate.ts) that evaluates over the WHOLE model.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes.read import MAX_PAGE_LIMIT
from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

SEARCH_MM = """\
metamodel: people
elements:
  - name: Person
    properties:
      - {name: name, datatype: string}
      - {name: age, datatype: integer}
      - {name: bio, datatype: string}
  - name: Company
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Knows
    containment: false
    source: Person
    target: Person
  - name: WorksAt
    containment: false
    source: Person
    target: Company
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/metamodel",
        content=SEARCH_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    return c


def _load(client: TestClient, elements: list[dict], relationships: list[dict]) -> None:
    res = client.post(
        f"{API}/model", json={"elements": elements, "relationships": relationships}
    )
    assert res.status_code == 200, res.text


def _person(eid: str, name: str | None = None, **props) -> dict:
    properties = dict(props)
    if name is not None:
        properties["name"] = name
    return {"id": eid, "type_name": "Person", "properties": properties}


def _company(eid: str, name: str | None = None, **props) -> dict:
    properties = dict(props)
    if name is not None:
        properties["name"] = name
    return {"id": eid, "type_name": "Company", "properties": properties}


def _rel(rid: str, type_name: str, source: str, target: str) -> dict:
    return {
        "id": rid,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


def _search(client: TestClient, body: dict) -> dict:
    res = client.post(f"{API}/model/search", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def _ids(page: dict) -> list[str]:
    key = "elements" if page["target"] == "element" else "relationships"
    return [e["id"] for e in page[key]]


# ---------------------------------------------------------------------------
# core regression: searches the WHOLE model, not a fetched page
# ---------------------------------------------------------------------------


def test_search_covers_full_model_beyond_one_page(client: TestClient) -> None:
    # more elements than any single read page; the engine must see all of them
    n = MAX_PAGE_LIMIT + 50
    people = [_person(f"p{i}", f"Person {i}", age=i) for i in range(n)]
    _load(client, people, [])
    page = _search(
        client,
        {"target": "element", "criteria": [{"type": "entity_type", "names": ["Person"]}]},
    )
    assert page["total"] == n  # all matched, not just the first page
    assert len(_ids(page)) == MAX_PAGE_LIMIT  # paged response


# ---------------------------------------------------------------------------
# per-criterion behavior
# ---------------------------------------------------------------------------


def test_search_entity_type(client: TestClient) -> None:
    _load(client, [_person("p1", "Ann"), _company("c1", "Acme")], [])
    page = _search(
        client,
        {"target": "element", "criteria": [{"type": "entity_type", "names": ["Company"]}]},
    )
    assert _ids(page) == ["c1"]


def test_search_property_ops(client: TestClient) -> None:
    _load(
        client,
        [
            _person("p1", "Ann", age=30, bio="loves cats"),
            _person("p2", "Bob", age=40),
            _person("p3", "Cy", age=20, bio=""),
        ],
        [],
    )

    def ids(crit: dict) -> list[str]:
        return _ids(_search(client, {"target": "element", "criteria": [crit]}))

    assert ids({"type": "property", "name": "age", "op": "gt", "value": "25"}) == ["p1", "p2"]
    assert ids({"type": "property", "name": "age", "op": "lte", "value": "20"}) == ["p3"]
    assert ids({"type": "property", "name": "age", "op": "equals", "value": "40"}) == ["p2"]
    assert ids({"type": "property", "name": "bio", "op": "contains", "value": "CAT"}) == ["p1"]
    assert ids({"type": "property", "name": "bio", "op": "matches", "value": "^loves"}) == ["p1"]
    # exists: a present, non-empty value (empty string and missing both fail)
    assert ids({"type": "property", "name": "bio", "op": "exists", "value": ""}) == ["p1"]
    assert sorted(
        ids({"type": "property", "name": "bio", "op": "is_empty", "value": ""})
    ) == ["p2", "p3"]


def test_search_name_id(client: TestClient) -> None:
    _load(client, [_person("alpha", "Ann"), _person("p2", "Bob")], [])

    def ids(crit: dict) -> list[str]:
        return _ids(_search(client, {"target": "element", "criteria": [crit]}))

    assert ids({"type": "name_id", "field": "name", "op": "equals", "value": "Ann"}) == ["alpha"]
    assert ids({"type": "name_id", "field": "id", "op": "contains", "value": "alph"}) == ["alpha"]


def test_search_relation_count_and_orphan(client: TestClient) -> None:
    _load(
        client,
        [_person("a", "A"), _person("b", "B"), _person("c", "C")],
        [_rel("r1", "Knows", "a", "b"), _rel("r2", "Knows", "a", "c")],
    )

    def ids(crit: dict) -> list[str]:
        return sorted(_ids(_search(client, {"target": "element", "criteria": [crit]})))

    # a has 2 outgoing Knows
    assert ids(
        {"type": "relation_count", "op": "at_least", "count": 2, "direction": "outgoing", "relTypes": []}
    ) == ["a"]
    # c is reachable only as a target; orphan = no relations either way
    assert ids({"type": "orphan"}) == []
    _load(
        client,
        [_person("a", "A"), _person("lonely", "L")],
        [],
    )
    assert ids({"type": "orphan"}) == ["a", "lonely"]


def test_search_connected_to_type(client: TestClient) -> None:
    _load(
        client,
        [_person("p1", "Ann"), _person("p2", "Bob"), _company("c1", "Acme")],
        [_rel("r1", "WorksAt", "p1", "c1")],
    )
    page = _search(
        client,
        {
            "target": "element",
            "criteria": [
                {"type": "connected_to_type", "direction": "either", "names": ["Company"]}
            ],
        },
    )
    assert _ids(page) == ["p1"]


def test_search_relationship_target_and_endpoint_type(client: TestClient) -> None:
    _load(
        client,
        [_person("p1", "Ann"), _person("p2", "Bob"), _company("c1", "Acme")],
        [_rel("r1", "Knows", "p1", "p2"), _rel("r2", "WorksAt", "p1", "c1")],
    )
    # all relationships whose target is a Company
    page = _search(
        client,
        {
            "target": "relationship",
            "criteria": [{"type": "endpoint_type", "endpoint": "target", "names": ["Company"]}],
        },
    )
    assert page["target"] == "relationship"
    assert _ids(page) == ["r2"]


def test_search_multiple_criteria_are_anded(client: TestClient) -> None:
    _load(
        client,
        [
            _person("p1", "Ann", age=30),
            _person("p2", "Bob", age=30),
            _company("c1", "Acme"),
        ],
        [],
    )
    page = _search(
        client,
        {
            "target": "element",
            "criteria": [
                {"type": "entity_type", "names": ["Person"]},
                {"type": "property", "name": "age", "op": "equals", "value": "30"},
                {"type": "name_id", "field": "name", "op": "contains", "value": "An"},
            ],
        },
    )
    assert _ids(page) == ["p1"]


def test_search_paging(client: TestClient) -> None:
    _load(client, [_person(f"p{i}", f"P{i}") for i in range(5)], [])
    body = {"target": "element", "criteria": [], "limit": 2, "offset": 2}
    page = _search(client, body)
    assert page["total"] == 5
    assert _ids(page) == ["p2", "p3"]


def test_search_404_without_model() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        f"{API}/model/search", json={"target": "element", "criteria": []}
    )
    assert res.status_code == 404


def test_search_any_of_group_ors_members_and_ands_with_siblings(
    client: TestClient,
) -> None:
    _load(
        client,
        [
            _person("p1", "Ann", age=30),
            _person("p2", "Bob", age=40),
            _person("p3", "Cy", age=20),
            _company("c1", "Acme"),
        ],
        [],
    )
    page = _search(
        client,
        {
            "target": "element",
            "criteria": [
                {"type": "entity_type", "names": ["Person"]},
                {"type": "any_of", "criteria": [
                    {"type": "property", "name": "age", "op": "equals", "value": "30"},
                    {"type": "name_id", "field": "name", "op": "contains", "value": "Cy"},
                ]},
            ],
        },
    )
    assert _ids(page) == ["p1", "p3"]


def test_search_empty_any_of_group_is_no_op(client: TestClient) -> None:
    _load(client, [_person("p1", "Ann"), _person("p2", "Bob")], [])
    page = _search(
        client,
        {"target": "element", "criteria": [{"type": "any_of", "criteria": []}]},
    )
    assert _ids(page) == ["p1", "p2"]


def test_search_nested_any_of_rejected(client: TestClient) -> None:
    res = client.post(
        f"{API}/model/search",
        json={
            "target": "element",
            "criteria": [{"type": "any_of",
                          "criteria": [{"type": "any_of", "criteria": []}]}],
        },
    )
    assert res.status_code == 422
