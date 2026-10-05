"""A commit lands unless it corrupts the model graph; conformance is the
client's to report, never the server's to reject."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from httpx import Response

from data_rover.api.db import db_session
from data_rover.api.db_models import Commit
from data_rover.api.main import create_app

from .conftest import (
    AUTH_HEADERS,
    commit_ops,
    head,
    install,
    papi,
    post_commit,
    seed_default_project,
)

_MM = """
elements:
  - name: Node
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
      - {name: link, datatype: Node, multiplicity: "0..1"}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


def _node(eid: str, **props: object) -> dict:
    return {"id": eid, "type_name": "Node", "properties": {"name": eid, **props}}


def _contains(rid: str, source: str, target: str) -> dict:
    return {
        "id": rid,
        "type_name": "Contains",
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


def _install(elements: list[dict], relationships: list[dict] | None = None) -> None:
    install(
        metamodel=_MM,
        model=json.dumps(
            {"elements": elements, "relationships": relationships or []}
        ),
    )


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _update(eid: str, **patch: object) -> dict:
    return {"kind": "update_element", "id": eid, "properties_patch": patch}


def _contains_op(temp: str, source: str, target: str) -> dict:
    return {
        "kind": "create_relationship",
        "temp_id": temp,
        "type_name": "Contains",
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


def _blocked(client: TestClient, ops: list[dict]) -> None:
    rev = head().rev
    r = post_commit(client, ops)
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["detail"] == "structural validation blocker"
    assert body["structural_blockers"]
    assert head().rev == rev


def test_reference_to_a_missing_id_is_blocked(client) -> None:
    _install([_node("a")])
    _blocked(client, [_update("a", link="nowhere")])


def test_second_containment_parent_is_blocked(client) -> None:
    _install(
        [_node("p1"), _node("p2"), _node("c")],
        [_contains("r1", "p1", "c")],
    )
    _blocked(client, [_contains_op("tmp_r2", "p2", "c")])


def test_containment_cycle_is_blocked(client) -> None:
    _install([_node("a"), _node("b")], [_contains("r1", "a", "b")])
    _blocked(client, [_contains_op("tmp_r2", "b", "a")])


def test_deleting_an_element_an_untouched_one_references_is_blocked(client) -> None:
    _install([_node("a", link="b"), _node("b")])
    _blocked(client, [{"kind": "delete_element", "id": "b"}])
    assert "b" in head().elements


def test_existing_structural_issue_on_an_untouched_neighbour_does_not_block(
    client,
) -> None:
    _install([_node("a"), _node("b", link="nowhere")])
    body = commit_ops(client, [_update("a", name="renamed")])
    assert body["model_rev"] == 1
    assert head().elements["a"]["properties"]["name"] == "renamed"


def test_conformance_errors_land_under_strict_mode_with_the_reported_count(
    client,
) -> None:
    _install([])
    r = client.patch(papi("/settings"), json={"strict_mode": True})
    assert r.status_code == 200, r.text
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": head().rev,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_bad",
                    "type_name": "Node",
                    "properties": {},
                }
            ],
            "validation_error_count": 1,
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["validation_error_count"] == 1
    assert len(head().elements) == 1


def test_open_answers_without_issue_counts(client) -> None:
    _install([_node("a")])
    body = client.get(papi("/open")).json()
    assert "issue_counts" not in body
    assert body["model_rev"] == 0
    assert body["element_count"] == 1


def test_preview_answers_no_issues(client) -> None:
    _install([])
    client.patch(papi("/settings"), json={"strict_mode": True})
    r = client.post(
        papi("/commits/preview"),
        json={
            "base_rev": 0,
            "ops": [
                {
                    "kind": "create_element",
                    "temp_id": "tmp_bad",
                    "type_name": "Node",
                    "properties": {},
                }
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["issues"] == []
    assert r.json()["structural_blockers"] == []
    assert r.json()["would_block"] is False
    assert head().elements == {}


_MM_LINKS = """
elements:
  - name: Node
    properties:
      - {name: ref, datatype: %s, multiplicity: "0..1"}
relationships:
  - name: Link
    containment: %s
    source: Node
    target: Node
"""


def _rebind(client: TestClient, blob: str) -> Response:
    lock = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}],
            "intent": "edit",
        },
    )
    assert lock.status_code == 200, lock.text
    return client.post(
        papi("/commits"),
        json={
            "base_rev": head().rev,
            "ops": [{"kind": "metamodel.rebind", "blob": blob}],
            "lock_tokens": [lock.json()["token"]],
        },
    )


def test_rebind_that_gives_an_untouched_element_two_parents_is_blocked(
    client,
) -> None:
    install(
        metamodel=_MM_LINKS % ("string", "false"),
        model=json.dumps(
            {
                "elements": [
                    {"id": i, "type_name": "Node", "properties": {}}
                    for i in ("p1", "p2", "c")
                ],
                "relationships": [
                    {**_contains("r1", "p1", "c"), "type_name": "Link"},
                    {**_contains("r2", "p2", "c"), "type_name": "Link"},
                ],
            }
        ),
    )
    r = _rebind(client, _MM_LINKS % ("string", "true"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "structural validation blocker"
    assert head().rev == 0


def test_rebind_that_makes_a_value_a_dangling_reference_is_blocked(client) -> None:
    install(
        metamodel=_MM_LINKS % ("string", "false"),
        model=json.dumps(
            {
                "elements": [
                    {"id": "a", "type_name": "Node", "properties": {"ref": "ghost"}}
                ],
                "relationships": [],
            }
        ),
    )
    r = _rebind(client, _MM_LINKS % ("Node", "false"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "structural validation blocker"
    assert head().rev == 0


def test_revert_blocks_on_a_structural_blocker(client) -> None:
    _install([_node("a")])
    commit_ops(client, [_update("a", name="renamed")])
    # a journal whose inverse restores a reference to an element that is gone
    with db_session() as s:
        row = s.query(Commit).filter_by(rev=1).one()
        row.inverse_ops = [_update("a", link="ghost")]
        s.commit()
    r = client.post(
        papi("/commits/revert"), json={"target_rev": 0, "base_rev": head().rev}
    )
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "structural validation blocker"
    assert head().rev == 1
    assert head().elements["a"]["properties"]["name"] == "renamed"
