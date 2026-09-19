"""``GET /replica/tail``: the deltas that bring a replica from ``from_rev`` to
head, each the feed's ``commit`` event of its journal row — served whole or
not at all."""

from __future__ import annotations

import threading
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from data_rover.api import content, db
from data_rover.api.db_models import Commit, Role, User
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.replica import TAIL_MAX_REVS, scope_of_ops, tail_is_complete
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session
from data_rover.api.tenancy import add_member

from .conftest import (
    AUTH_HEADERS,
    create_folder_via_commit,
    feed_url,
    papi,
    seed_default_project,
)

# --- the completeness rule --------------------------------------------------


def test_a_contiguous_expressible_range_is_complete() -> None:
    assert tail_is_complete([(4, True), (5, True), (6, True)], 3, 6)


def test_an_empty_range_at_head_is_complete() -> None:
    assert tail_is_complete([], 6, 6)


@pytest.mark.parametrize(
    "marks",
    [
        [(5, True), (6, True)],
        [(4, True), (6, True)],
        [(4, True), (5, True)],
        [],
    ],
    ids=["first", "middle", "last", "all"],
)
def test_a_missing_revision_is_incomplete(marks: list[tuple[int, bool]]) -> None:
    assert not tail_is_complete(marks, 3, 6)


def test_an_inexpressible_revision_is_incomplete() -> None:
    assert not tail_is_complete([(4, True), (5, False), (6, True)], 3, 6)


def test_the_revision_cap_is_inclusive() -> None:
    n = TAIL_MAX_REVS
    assert tail_is_complete([(r, True) for r in range(1, n + 1)], 0, n)
    assert not tail_is_complete([(r, True) for r in range(1, n + 2)], 0, n + 1)


def test_a_from_rev_beyond_head_is_incomplete() -> None:
    assert not tail_is_complete([], 7, 6)


# --- the scope of a journal row ---------------------------------------------

_MODEL_OP = {"kind": "create_element"}
_ARTIFACT_OP = {"kind": "create_artifact"}
_VIEW_OP = {"kind": "create_folder"}
_LAYOUT_OP = {"kind": "metamodel.move_node"}


@pytest.mark.parametrize(
    ("ops", "scope"),
    [
        ([_MODEL_OP], ["model"]),
        ([_ARTIFACT_OP], ["artifact"]),
        ([_VIEW_OP], ["view"]),
        ([_LAYOUT_OP], ["metamodel-layout"]),
        ([_VIEW_OP, _MODEL_OP, _ARTIFACT_OP], ["artifact", "model", "view"]),
        ([_LAYOUT_OP, _ARTIFACT_OP], ["artifact", "metamodel-layout"]),
        ([], ["model"]),
    ],
)
def test_scope_of_ops(ops: list[dict[str, Any]], scope: list[str]) -> None:
    # A row holding a metamodel.rebind never reaches a delta (a tail across
    # it is incomplete), so its scope is left unspecified.
    assert scope_of_ops(ops) == scope


# --- the route --------------------------------------------------------------

_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
      - {name: weight, datatype: float}
      - {name: meta, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""

_MM_V2 = (
    _MM
    + """
  - name: Refers
    source: Node
    target: Node
"""
)

_SNIP = {
    "schema_version": 1,
    "language": "python",
    "code": "def value(el):\n    return 1\n",
}

_VIEWER = {"x-user-id": "viewer", "x-user-email": "viewer@example.com"}


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    res = c.post(papi("/model/upload"), content=b'{"elements":[],"relationships":[]}')
    assert res.status_code == 200, res.text
    return c


def _head() -> int:
    return get_session().model_rev


def _tail(client: TestClient, from_rev: int) -> dict[str, Any]:
    res = client.get(papi("/replica/tail"), params={"from_rev": from_rev})
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _node(temp_id: str, label: str, **props: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": temp_id,
        "type_name": "Node",
        "properties": {"label": label, **props},
    }


def _contains(temp_id: str, source: str, target: str) -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp_id,
        "type_name": "Contains",
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


def _lock(client: TestClient, targets: list[dict[str, Any]], intent: str) -> str:
    res = client.post(papi("/locks"), json={"targets": targets, "intent": intent})
    assert res.status_code == 200, res.text
    token: str = res.json()["token"]
    return token


def _element_lock(client: TestClient, eid: str, intent: str = "edit") -> str:
    return _lock(client, [{"resource_id": eid, "mode": "exclusive"}], intent)


def _mm_lock(client: TestClient) -> str:
    return _lock(
        client,
        [{"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}],
        "edit",
    )


def _commit(
    client: TestClient, ops: list[dict[str, Any]], tokens: list[str] | None = None
) -> dict[str, Any]:
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": _head(),
            "ops": ops,
            "message": f"commit at {_head()}",
            "lock_tokens": tokens or [],
        },
    )
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _ops(client: TestClient, ops: list[dict[str, Any]]) -> dict[str, Any]:
    res = client.post(papi("/model/ops"), json={"base_rev": _head(), "ops": ops})
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _rebind(client: TestClient) -> None:
    _commit(client, [{"kind": "metamodel.rebind", "blob": _MM_V2}], [_mm_lock(client)])


def _assert_incomplete(client: TestClient, from_rev: int) -> None:
    body = _tail(client, from_rev)
    assert body == {
        "from_rev": from_rev,
        "head_rev": _head(),
        "complete": False,
        "deltas": [],
    }


def _assert_complete(client: TestClient, from_rev: int) -> dict[str, Any]:
    body = _tail(client, from_rev)
    assert body["complete"] is True
    assert body["from_rev"] == from_rev and body["head_rev"] == _head()
    assert [d["rev"] for d in body["deltas"]] == list(range(from_rev + 1, _head() + 1))
    return body


def test_a_tail_delta_is_the_feed_event_of_its_commit(client: TestClient) -> None:
    r0 = _head()
    events: list[dict[str, Any]] = []
    with client.websocket_connect(feed_url()) as ws:
        ws.receive_json()  # snapshot

        def commit(ops: list[dict[str, Any]], tokens: list[str] | None = None) -> Any:
            body = _commit(client, ops, tokens)
            event = ws.receive_json()
            while event["type"] != "commit":
                event = ws.receive_json()
            events.append(event)
            return body

        # creates, a relationship, and an update holding a float and a nested
        # dict whose keys are not sorted
        body = commit(
            [
                _node("tmp_a", "A", weight=1.5),
                _node("tmp_b", "B"),
                _node("tmp_d", "D"),
                _contains("tmp_r", "tmp_a", "tmp_b"),
                {
                    "kind": "update_element",
                    "id": "tmp_a",
                    "properties_patch": {
                        "weight": 0.1,
                        "meta": {"z": 1, "a": {"y": 2.0, "b": [3, 1e-7]}},
                    },
                },
            ]
        )
        a, d = body["id_map"]["tmp_a"], body["id_map"]["tmp_d"]
        # a delete that cascades to a child
        commit(
            [{"kind": "delete_element", "id": a}],
            [_element_lock(client, a, "delete")],
        )
        # an element created and deleted within one commit
        commit([_node("tmp_x", "X"), {"kind": "delete_element", "id": "tmp_x"}])
        # an element deleted and created again under its id
        commit(
            [{"kind": "delete_element", "id": d}, {**_node("tmp_d2", "D2"), "id": d}],
            [_element_lock(client, d, "delete")],
        )
        # artifact only
        commit(
            [
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_art",
                    "artifact_kind": "code_snippet",
                    "name": "s1",
                    "payload": _SNIP,
                }
            ]
        )
        # view only (the helper commits through POST /commits itself)
        create_folder_via_commit(client, "F")
        event = ws.receive_json()
        while event["type"] != "commit":
            event = ws.receive_json()
        events.append(event)
        # layout only
        commit(
            [
                {
                    "kind": "metamodel.move_node",
                    "node": "el:Node",
                    "pos": {"x": 1, "y": 2},
                }
            ],
            [_mm_lock(client)],
        )
        # model and artifact mixed
        commit(
            [
                _node("tmp_m", "M"),
                {
                    "kind": "create_artifact",
                    "temp_id": "tmp_art2",
                    "artifact_kind": "code_snippet",
                    "name": "s2",
                    "payload": _SNIP,
                },
            ]
        )

    assert events[2]["deleted_element_ids"]
    assert events[3]["recreated_element_ids"] == [d]
    assert [e["scope"] for e in events[4:]] == [
        ["artifact"],
        ["view"],
        ["metamodel-layout"],
        ["artifact", "model"],
    ]
    body = _assert_complete(client, r0)
    assert body["deltas"] == events


def test_ops_and_undo_rows_are_in_the_tail(client: TestClient) -> None:
    r0 = _head()
    first = _ops(client, [_node("tmp_a", "A"), _node("tmp_b", "B")])
    a = first["id_map"]["tmp_a"]
    second = _ops(
        client,
        [
            {"kind": "delete_element", "id": a},
            {**_node("tmp_a2", "A2"), "id": a},
        ],
    )
    res = client.post(papi("/model/undo"))
    assert res.status_code == 200, res.text
    undo = res.json()
    body = _assert_complete(client, r0)
    for delta, carrier in zip(body["deltas"], (first, second, undo), strict=True):
        assert delta["rev"] == carrier["model_rev"]
        for field in (
            "prev_rev",
            "state_digest",
            "changed_elements",
            "changed_relationships",
            "deleted_element_ids",
            "deleted_relationship_ids",
            "recreated_element_ids",
            "recreated_relationship_ids",
        ):
            assert delta[field] == carrier[field], field
        assert delta["scope"] == ["model"]
    assert second["recreated_element_ids"] == [a]


def test_the_tail_from_head_is_empty_and_complete(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "A")])
    body = _assert_complete(client, _head())
    assert body["deltas"] == []


def test_a_tail_from_the_middle_starts_there(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "A")])
    _ops(client, [_node("tmp_b", "B")])
    body = _assert_complete(client, _head() - 1)
    (delta,) = body["deltas"]
    assert delta["prev_rev"] == _head() - 1


def test_a_tail_is_incomplete_across_a_baseline(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "A")])
    r1 = _head()
    res = client.post(
        papi("/model/upload"), content=b'{"elements":[],"relationships":[]}'
    )
    assert res.status_code == 200, res.text
    _assert_incomplete(client, r1)
    _ops(client, [_node("tmp_b", "B")])
    _assert_incomplete(client, r1)
    _assert_complete(client, _head() - 1)


def test_a_tail_is_incomplete_across_a_commit_over_the_entity_states_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    r0 = _head()
    monkeypatch.setattr("data_rover.api.commit_states.ENTITY_STATES_MAX", 1)
    _ops(client, [_node("tmp_a", "A"), _node("tmp_b", "B")])
    over = _head()
    _ops(client, [_node("tmp_c", "C")])
    _assert_incomplete(client, r0)
    _assert_complete(client, over)


def test_a_tail_is_incomplete_across_a_row_older_than_the_digest(
    client: TestClient,
) -> None:
    r0 = _head()
    _ops(client, [_node("tmp_a", "A")])
    old = _head()
    _ops(client, [_node("tmp_b", "B")])
    with db.db_session() as s:
        s.execute(
            update(Commit)
            .where(Commit.project_id == DEFAULT_PROJECT_ID, Commit.rev == old)
            .values(state_digest=None)
        )
    _assert_incomplete(client, r0)
    _assert_complete(client, old)


def test_a_tail_is_incomplete_across_a_rebind(client: TestClient) -> None:
    r0 = _head()
    _ops(client, [_node("tmp_a", "A")])
    _rebind(client)
    rebind = _head()
    _ops(client, [_node("tmp_b", "B")])
    _assert_incomplete(client, r0)
    _assert_incomplete(client, rebind - 1)
    _assert_complete(client, rebind)


def _legacy_create(client: TestClient) -> None:
    res = client.post(papi("/model/elements"), json={"type": "Node", "properties": {}})
    assert res.status_code == 201, res.text


def test_a_tail_is_incomplete_across_a_bump_with_no_row_at_head(
    client: TestClient,
) -> None:
    r0 = _head()
    _ops(client, [_node("tmp_a", "A")])
    _legacy_create(client)
    # nothing landed since: only the session's head reveals the hole
    _assert_incomplete(client, r0)


def test_a_tail_is_incomplete_across_a_bump_with_no_row_in_the_middle(
    client: TestClient,
) -> None:
    r0 = _head()
    _ops(client, [_node("tmp_a", "A")])
    _legacy_create(client)
    hole = _head()
    _ops(client, [_node("tmp_b", "B")])
    _assert_incomplete(client, r0)
    _assert_complete(client, hole)


def test_a_tail_is_incomplete_past_the_revision_cap(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("data_rover.api.replica.TAIL_MAX_REVS", 2)
    r0 = _head()
    for label in ("A", "B", "C"):
        _ops(client, [_node("tmp_n", label)])
    _assert_incomplete(client, r0)
    _assert_complete(client, r0 + 1)


def test_a_tail_is_incomplete_from_beyond_head(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "A")])
    _assert_incomplete(client, _head() + 5)


def test_an_incomplete_tail_loads_no_rows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _no_rows(*_: object, **__: object) -> None:
        raise AssertionError("rows loaded")

    monkeypatch.setattr(content, "commits_between", _no_rows)
    _ops(client, [_node("tmp_a", "A")])
    _assert_incomplete(client, _head() + 1)


def test_the_head_is_read_under_the_write_mutex(client: TestClient) -> None:
    _ops(client, [_node("tmp_a", "A")])
    session = get_session()
    answers: list[int] = []

    def ask() -> None:
        res = client.get(papi("/replica/tail"), params={"from_rev": 0})
        answers.append(res.status_code)

    worker = threading.Thread(target=ask)
    with session.write_mutex:
        worker.start()
        worker.join(0.5)
        assert worker.is_alive() and answers == []
    worker.join(10)
    assert answers == [200]


def test_tail_requires_from_rev(client: TestClient) -> None:
    assert client.get(papi("/replica/tail")).status_code == 422
    res = client.get(papi("/replica/tail"), params={"from_rev": -1})
    assert res.status_code == 422


def test_a_viewer_may_read_the_tail(client: TestClient) -> None:
    with db.db_session() as s:
        s.add(User(id="viewer", email="viewer@example.com"))
        s.flush()
        add_member(s, DEFAULT_PROJECT_ID, "viewer", Role.viewer)
    _ops(client, [_node("tmp_a", "A")])
    res = client.get(
        papi("/replica/tail"), params={"from_rev": _head() - 1}, headers=_VIEWER
    )
    assert res.status_code == 200, res.text
    assert res.json()["complete"] is True


def test_a_non_member_may_not(client: TestClient) -> None:
    res = client.get(
        papi("/replica/tail"),
        params={"from_rev": 0},
        headers={"x-user-id": "stranger", "x-user-email": "stranger@example.com"},
    )
    assert res.status_code == 403
