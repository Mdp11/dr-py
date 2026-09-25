"""GET /artifacts/payloads: every artifact of the project with its payload,
or the named ids that exist."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, tenancy
from data_rover.api.db_models import ArtifactKind, Project, Role
from data_rover.api.main import create_app
from data_rover.api.routes.rules import parse_result

from .conftest import AUTH_HEADERS, TEST_USER_ID, papi, seed_default_project

NAV = {
    "kind": "path",
    "start": {"kind": "scope", "types": ["Block"]},
    "steps": [],
}
SNIP = {"code": "def value(el):\n    return 1\n"}
RULES_YAML = (
    "# comments stay in the payload\n"
    "rules:\n"
    "  - name: tall\n"
    "    applies_to: Block\n"
    "    then: {property: height, gt: 1}\n"
)


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _create(client: TestClient, kind: str, name: str, payload: dict) -> dict:
    res = client.post(
        papi("/artifacts"), json={"kind": kind, "name": name, "payload": payload}
    )
    assert res.status_code == 201, res.text
    created: dict = res.json()
    return created


def test_every_payload_in_list_order(client: TestClient) -> None:
    b = _create(client, "navigation", "b nav", NAV)
    s = _create(client, "code_snippet", "snip", SNIP)
    a = _create(client, "navigation", "a nav", {**NAV, "steps": []})

    listed = client.get(papi("/artifacts")).json()["items"]
    res = client.get(papi("/artifacts/payloads"))

    assert res.status_code == 200, res.text
    items = res.json()["items"]
    assert [i["id"] for i in items] == [i["id"] for i in listed]
    assert {i["id"] for i in items} == {a["id"], b["id"], s["id"]}
    by_id = {i["id"]: i for i in items}
    assert by_id[b["id"]]["payload"] == b["payload"]
    assert by_id[s["id"]]["payload"] == s["payload"]
    assert by_id[a["id"]]["artifact_rev"] == 1
    assert by_id[a["id"]]["kind"] == "navigation"
    assert by_id[a["id"]]["name"] == "a nav"


def test_named_ids_that_exist(client: TestClient) -> None:
    a = _create(client, "navigation", "a", NAV)
    b = _create(client, "navigation", "b", NAV)
    _create(client, "navigation", "c", NAV)

    res = client.get(
        papi("/artifacts/payloads"), params=[("id", b["id"]), ("id", "ghost")]
    )
    assert res.status_code == 200, res.text
    assert [i["id"] for i in res.json()["items"]] == [b["id"]]

    both = client.get(
        papi("/artifacts/payloads"), params=[("id", b["id"]), ("id", a["id"])]
    )
    assert [i["id"] for i in both.json()["items"]] == [a["id"], b["id"]]


def test_payloads_is_not_read_as_an_artifact_id(client: TestClient) -> None:
    res = client.get(papi("/artifacts/payloads"))
    assert res.status_code == 200, res.text
    assert res.json() == {"items": []}


def test_a_viewer_reads_payloads(client: TestClient) -> None:
    a = _create(client, "navigation", "a", NAV)
    with db.db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(
            s, project_id="default", user_id="viewer-1", role=Role.viewer
        )
    viewer = TestClient(create_app())
    viewer.headers.update({"x-user-id": "viewer-1", "x-user-email": "v@example.com"})

    res = viewer.get(papi("/artifacts/payloads"))
    assert res.status_code == 200, res.text
    assert [i["id"] for i in res.json()["items"]] == [a["id"]]


def test_another_projects_artifact_never_appears(client: TestClient) -> None:
    own = _create(client, "navigation", "own", NAV)
    with db.db_session() as s:
        s.add(Project(id="other", name="Other"))
        s.flush()
        foreign = content.create_artifact(
            s,
            "other",
            kind=ArtifactKind.navigation,
            name="foreign",
            payload=NAV,
            updated_by=TEST_USER_ID,
        )
        foreign_id = foreign.id
        s.commit()

    every = client.get(papi("/artifacts/payloads")).json()["items"]
    assert [i["id"] for i in every] == [own["id"]]
    named = client.get(
        papi("/artifacts/payloads"), params=[("id", foreign_id), ("id", own["id"])]
    ).json()["items"]
    assert [i["id"] for i in named] == [own["id"]]


def test_a_rules_item_carries_its_parse(client: TestClient) -> None:
    r = _create(
        client, "validation_rules", "rules", {"schema_version": 1, "yaml": RULES_YAML}
    )
    n = _create(client, "navigation", "nav", NAV)

    by_id = {
        i["id"]: i for i in client.get(papi("/artifacts/payloads")).json()["items"]
    }

    rules = by_id[r["id"]]["rules"]
    assert rules == parse_result(RULES_YAML).model_dump(mode="json")
    assert rules["ok"] is True
    assert '"gt":1.0' in rules["document"]
    assert by_id[n["id"]]["rules"] is None


def test_rules_is_the_last_key_and_the_rest_is_unchanged(client: TestClient) -> None:
    r = _create(
        client, "validation_rules", "rules", {"schema_version": 1, "yaml": RULES_YAML}
    )
    n = _create(client, "navigation", "nav", NAV)

    by_id = {
        i["id"]: i for i in client.get(papi("/artifacts/payloads")).json()["items"]
    }

    for created in (r, n):
        single = client.get(papi(f"/artifacts/{created['id']}")).json()
        item = by_id[created["id"]]
        assert list(item) == [*single, "rules"]
        assert {k: v for k, v in item.items() if k != "rules"} == single


def test_a_rules_payload_without_yaml_parses_as_empty(client: TestClient) -> None:
    with db.db_session() as s:
        row = content.create_artifact(
            s,
            "default",
            kind=ArtifactKind.validation_rules,
            name="bare",
            payload={"schema_version": 1},
            updated_by=TEST_USER_ID,
        )
        row_id = row.id

    (item,) = client.get(papi("/artifacts/payloads")).json()["items"]
    assert item["id"] == row_id
    assert item["rules"] == {"ok": True, "document": "{}", "errors": []}
