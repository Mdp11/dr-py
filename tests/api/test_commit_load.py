"""The commit check runs on a partial model loaded from the head rows.

``plan_load`` decides which rows a batch needs; ``load_and_apply`` runs the batch
on them and, when the batch reaches an entity the plan did not foresee, loads
that entity and runs the whole batch again on a fresh partial model.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.dialects import postgresql

from data_rover.api import commit_load, content, db, head as head_mod
from data_rover.api.db_models import Commit, ElementRow, EntityRefRow, RelationshipRow
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry
from data_rover.core.metamodel.loader import load_metamodel_str

from .commit_oracle import MM, Oracle, assert_rows, model_ops, session
from .conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    commit_ops,
    head,
    install,
    papi,
    post_commit,
    seed_default_project,
)

CONTAINMENT = ["Contains"]


def _el(eid: str, **props: Any) -> dict[str, Any]:
    return {"id": eid, "type_name": "Node", "properties": props, "rev": 1}


def _rel(rid: str, typ: str, source: str, target: str, **props: Any) -> dict[str, Any]:
    return {
        "id": rid,
        "type_name": typ,
        "source_id": source,
        "target_id": target,
        "properties": props,
        "rev": 1,
    }


def _tree() -> dict[str, Any]:
    """Thirty-two entities. Containment::

        R -> A -> A1 -> A1a, A1b      D -> D1      X  Y  Z   (roots)
               -> A2
          -> B -> B1, B2
          -> C -> C1

    ``X.ref`` points into A's subtree, ``Y.refs`` holds a dangling id, and the
    links are A2-B1, B2-A1 (into A's subtree), X-Z, C-D1, and Z-Y with ``via`` A.
    """
    tree = {
        "R": ["A", "B", "C"],
        "A": ["A1", "A2"],
        "A1": ["A1a", "A1b"],
        "B": ["B1", "B2"],
        "C": ["C1"],
        "D": ["D1"],
    }
    names = [
        "R", "A", "A1", "A1a", "A1b", "A2", "B", "B1", "B2", "C", "C1",
        "D", "D1", "X", "Y", "Z",
    ]  # fmt: skip
    elements = [_el(n, label=n) for n in names]
    for e in elements:
        if e["id"] == "X":
            e["properties"]["ref"] = "A1a"
        if e["id"] == "Y":
            e["properties"]["refs"] = ["B1", "ghost"]
    relationships = []
    for parent, kids in tree.items():
        for kid in kids:
            relationships.append(_rel(f"c-{parent}-{kid}", "Contains", parent, kid))
    relationships += [
        _rel("L1", "Link", "A2", "B1"),
        _rel("L2", "Link", "B2", "A1"),
        _rel("L3", "Link", "X", "Z"),
        _rel("L4", "Link", "C", "D1"),
        _rel("L5", "Link", "Z", "Y", via="A"),
    ]
    assert len(elements) + len(relationships) == 32
    return {"elements": elements, "relationships": relationships}


@pytest.fixture(autouse=True)
def client(_fresh_db: None) -> TestClient:
    """The app first (building it resets the snapshot store), then the project."""
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    seed_default_project()
    install(metamodel=MM, model=json.dumps(_tree()))
    return c


def _plan(ops: list[dict[str, Any]], extra: frozenset[str] = frozenset()):
    with session() as s:
        return commit_load.plan_load(
            s, DEFAULT_PROJECT_ID, load_metamodel_str(MM), model_ops(ops), extra
        )


def _ids(rows: Any) -> tuple[set[str], set[str]]:
    return (
        {r["id"] for r in rows.elements},
        {r["id"] for r in rows.relationships},
    )


def _delete(eid: str) -> dict[str, Any]:
    return {"kind": "delete_element", "id": eid}


def _contains(source: str, target: str, temp: str = "tmp_c") -> dict[str, Any]:
    return {
        "kind": "create_relationship",
        "temp_id": temp,
        "type_name": "Contains",
        "source_id": source,
        "target_id": target,
        "properties": {},
    }


# --- plan_load ----------------------------------------------------------------


def test_plan_for_a_delete_loads_the_subtree_its_edges_and_its_referencers() -> None:
    rows = _plan([_delete("A")])
    subtree = {"A", "A1", "A1a", "A1b", "A2"}
    incident = {"c-R-A", "c-A-A1", "c-A-A2", "c-A1-A1a", "c-A1-A1b", "L1", "L2"}
    elements, relationships = _ids(rows)
    # the subtree, the other ends of its relationships (R, B1, B2), the
    # referencers of its members and of its relationships (X.ref -> A1a, and
    # the relationship L5 whose via is A, with its own ends Z and Y)
    assert elements == subtree | {"R", "B1", "B2", "X", "Z", "Y"}
    assert relationships == incident | {"L5"}
    assert rows.edges_complete == subtree
    assert rows.referencers_complete == subtree | incident
    assert rows.absent == frozenset()
    # in sequence order, as a model holds them
    assert [r["id"] for r in rows.elements] == [n for n in _names() if n in elements]


def _names() -> list[str]:
    return [e["id"] for e in _tree()["elements"]]


def test_plan_for_a_containment_connect_loads_the_ancestor_chain() -> None:
    rows = _plan([_contains("A1a", "Z")])
    elements, relationships = _ids(rows)
    chain = {"A1a", "A1", "A", "R"}
    assert elements == chain | {"Z"}
    assert relationships == {"c-R-A", "c-A-A1", "c-A1-A1a"}
    assert rows.parents_complete == chain | {"Z"}
    assert rows.edges_complete == frozenset()


def test_plan_for_an_update_loads_the_parents_and_the_reference_targets() -> None:
    rows = _plan(
        [{"kind": "update_element", "id": "A1b", "properties_patch": {"ref": "D1"}}]
    )
    elements, relationships = _ids(rows)
    assert elements == {"A1b", "A1", "A", "R", "D1"}
    assert relationships == {"c-R-A", "c-A-A1", "c-A1-A1b"}
    assert rows.parents_complete == {"A1b", "A1", "A", "R"}


def test_plan_puts_an_unknown_id_in_absent() -> None:
    rows = _plan(
        [
            {
                "kind": "update_element",
                "id": "nope",
                "properties_patch": {"label": "x"},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {"ref": "ghost-too"},
            },
        ]
    )
    assert _ids(rows) == (set(), set())
    assert {"nope", "ghost-too"} <= rows.absent


def test_plan_loads_the_referencers_of_a_hinted_create_id() -> None:
    # Y.refs holds "ghost": creating an element under that id changes Y's verdict
    rows = _plan(
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_g",
                "id": "ghost",
                "type_name": "Node",
                "properties": {},
            }
        ]
    )
    elements, _ = _ids(rows)
    assert "Y" in elements and "ghost" in rows.referencers_complete
    assert "ghost" in rows.absent


def test_plan_loads_the_referencers_of_a_restored_id() -> None:
    # a revert reinstates an element under its canonical id (no tmp_ prefix)
    rows = _plan(
        [
            {
                "kind": "create_element",
                "temp_id": "A1a",
                "type_name": "Node",
                "properties": {},
            },
            {
                "kind": "create_element",
                "temp_id": "gone",
                "type_name": "Node",
                "properties": {},
            },
        ]
    )
    elements, _ = _ids(rows)
    assert "X" in elements  # X.ref -> A1a
    assert {"A1a", "gone"} <= rows.referencers_complete
    assert "gone" in rows.absent


def test_plan_makes_every_element_of_an_extra_subtree_complete() -> None:
    rows = _plan([], extra=frozenset({"C"}))
    assert rows.edges_complete == {"C", "C1"}
    assert {"C", "C1", "R", "D1"} <= _ids(rows)[0]  # R and D1: ends of c-R-C and L4


def test_plan_makes_what_a_batch_attaches_a_delete_root_when_it_deletes() -> None:
    rows = _plan([_contains("X", "C"), _delete("X")])
    assert rows.edges_complete == {"X", "C", "C1"}
    assert {"C", "c-C-C1"} <= {r["id"] for r in (*rows.elements, *rows.relationships)}
    # without a delete in the batch an attachment needs no subtree
    assert _plan([_contains("X", "C")]).edges_complete == frozenset()


def test_plan_chunks_its_in_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    ops = [_delete("A"), _contains("A1a", "Z", "tmp_k")]
    whole = _plan(ops)
    monkeypatch.setattr(commit_load, "CHUNK", 2)
    chunked = _plan(ops)
    assert chunked == whole


def test_subtree_and_ancestor_ids_follow_only_the_containment_types() -> None:
    with session() as s:
        assert commit_load.subtree_ids(s, DEFAULT_PROJECT_ID, ["A"], CONTAINMENT) == {
            "A",
            "A1",
            "A1a",
            "A1b",
            "A2",
        }
        assert commit_load.subtree_ids(s, DEFAULT_PROJECT_ID, ["A"], ["Link"]) == {"A"}
        assert commit_load.ancestor_ids(
            s, DEFAULT_PROJECT_ID, ["A1b"], CONTAINMENT
        ) == {"A1b", "A1", "A", "R"}
        assert commit_load.ancestor_ids(s, DEFAULT_PROJECT_ID, ["A1b"], ["Link"]) == {
            "A1b"
        }
        # an id that is no element answers nothing
        assert (
            commit_load.subtree_ids(s, DEFAULT_PROJECT_ID, ["nope"], CONTAINMENT)
            == set()
        )


def test_the_walks_end_on_a_containment_cycle() -> None:
    install(
        metamodel=MM,
        model=json.dumps(
            {
                "elements": [_el("a"), _el("b"), _el("c")],
                "relationships": [
                    _rel("r1", "Contains", "a", "b"),
                    _rel("r2", "Contains", "b", "c"),
                    _rel("r3", "Contains", "c", "a"),
                ],
            }
        ),
    )
    with session() as s:
        every = {"a", "b", "c"}
        assert (
            commit_load.subtree_ids(s, DEFAULT_PROJECT_ID, ["a"], CONTAINMENT) == every
        )
        assert (
            commit_load.ancestor_ids(s, DEFAULT_PROJECT_ID, ["a"], CONTAINMENT) == every
        )


# --- the rounds -----------------------------------------------------------------


def _attach_then_delete() -> list[dict[str, Any]]:
    return [_contains("X", "C"), _delete("X")]


def _plan_without_attachments(monkeypatch: pytest.MonkeyPatch) -> None:
    """A planner that does not foresee what the batch attaches: C is then only
    an endpoint, and the delete reaches it by surprise."""
    real = commit_load._scan

    def scan(*args: Any, **kwargs: Any) -> Any:
        named = real(*args, **kwargs)
        named.attached.clear()
        return named

    monkeypatch.setattr(commit_load, "_scan", scan)


class _Rounds:
    """Counts how many times the last request planned its load (a request that
    names missing locks is answered, and retried, by the test helper)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.n = 0
        real_plan = commit_load.plan_load
        real_lock = content.lock_model_row

        def counting(*args: Any, **kwargs: Any) -> Any:
            self.n += 1
            return real_plan(*args, **kwargs)

        def new_request(*args: Any, **kwargs: Any) -> Any:
            self.n = 0
            return real_lock(*args, **kwargs)

        monkeypatch.setattr(commit_load, "plan_load", counting)
        monkeypatch.setattr(content, "lock_model_row", new_request)


def test_attach_then_delete_is_planned_in_one_round(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    oracle = Oracle(json.dumps(_tree()))
    assert oracle.run(model_ops(_attach_then_delete())).status == 200
    rounds = _Rounds(monkeypatch)
    commit_ops(client, _attach_then_delete())
    assert rounds.n == 1
    assert not {"X", "C", "C1"} & set(head().elements)
    assert_rows(oracle, DEFAULT_PROJECT_ID, "attach then delete")


def test_attach_then_delete_reruns(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _plan_without_attachments(monkeypatch)
    oracle = Oracle(json.dumps(_tree()))
    want = oracle.run(model_ops(_attach_then_delete()))
    assert want.status == 200
    rounds = _Rounds(monkeypatch)
    commit_ops(client, _attach_then_delete())
    assert rounds.n == 2
    now = head()
    assert not {"X", "C", "C1"} & set(now.elements)
    assert not {"c-R-C", "c-C-C1", "c-X-C", "L3", "L4"} & set(now.relationships)
    assert_rows(oracle, DEFAULT_PROJECT_ID, "attach then delete")


class _Records(logging.Handler):
    def __init__(self) -> None:
        super().__init__(logging.ERROR)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def test_round_bound(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _plan_without_attachments(monkeypatch)
    monkeypatch.setattr(commit_load, "MAX_ROUNDS", 1)
    before = head()
    with session() as s:
        commits_before = len(content.commits_after(s, DEFAULT_PROJECT_ID, -1))
    records = _Records()
    # the handler sits on the logger itself: another test's logging setup may
    # have switched propagation off
    monkeypatch.setattr(commit_load.logger, "disabled", False)
    commit_load.logger.addHandler(records)
    try:
        r = post_commit(client, _attach_then_delete())
    finally:
        commit_load.logger.removeHandler(records)
    assert r.status_code == 500, r.text
    assert r.json() == {"detail": "commit check did not converge"}
    logged = " ".join(records.messages)
    assert "create_relationship=1" in logged and "delete_element=1" in logged
    after = head()
    assert after == before
    with session() as s:
        assert len(content.commits_after(s, DEFAULT_PROJECT_ID, -1)) == commits_before
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None and row.model_rev == before.rev
    assert get_registry().get(DEFAULT_PROJECT_ID).model_rev == before.rev


def test_a_batch_that_never_reaches_an_unplanned_entity_takes_one_round(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    rounds = _Rounds(monkeypatch)
    commit_ops(
        client,
        [
            {"kind": "delete_element", "id": "D"},
            {
                "kind": "update_element",
                "id": "B",
                "properties_patch": {"ref": "B1", "label": "b"},
            },
        ],
    )
    assert rounds.n == 1


def test_same_batch_temp_ids_need_no_rows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    rounds = _Rounds(monkeypatch)
    node = {"kind": "create_element", "type_name": "Node", "properties": {}}
    body = commit_ops(
        client,
        [
            {**node, "temp_id": "tmp_a"},
            {**node, "temp_id": "tmp_b"},
            {
                "kind": "update_element",
                "id": "tmp_a",
                "properties_patch": {"label": "a"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Link",
                "source_id": "tmp_a",
                "target_id": "tmp_b",
                "properties": {},
            },
            {
                "kind": "update_relationship",
                "id": "tmp_r",
                "properties_patch": {"via": "A"},
            },
            {"kind": "delete_relationship", "id": "tmp_r"},
            {"kind": "delete_element", "id": "tmp_b"},
        ],
    )
    assert rounds.n == 1
    assert set(body["deleted_element_ids"]) == {body["id_map"]["tmp_b"]}


def test_an_unknown_temp_id_is_the_422_a_full_model_gives(client: TestClient) -> None:
    r = post_commit(
        client,
        [
            {
                "kind": "update_element",
                "id": "tmp_never",
                "properties_patch": {"label": "x"},
            }
        ],
    )
    want = Oracle(json.dumps(_tree())).run(
        model_ops(
            [
                {
                    "kind": "update_element",
                    "id": "tmp_never",
                    "properties_patch": {"label": "x"},
                }
            ]
        )
    )
    assert (r.status_code, r.json()) == (want.status, want.body)
    assert r.status_code == 422


@pytest.mark.parametrize(
    "ops",
    [
        [{"kind": "delete_element", "id": "L1"}],  # a relationship's id
        [{"kind": "update_element", "id": "L1", "properties_patch": {"label": "x"}}],
        [{"kind": "delete_relationship", "id": "A"}],  # an element's id
        [{"kind": "update_relationship", "id": "A", "properties_patch": {"via": "B"}}],
        [_contains("L1", "A", "tmp_x")],
    ],
)
def test_an_id_of_the_other_table_is_the_422_a_full_model_gives(
    client: TestClient, ops: list[dict[str, Any]]
) -> None:
    want = Oracle(json.dumps(_tree())).run(model_ops(ops))
    r = post_commit(client, ops)
    assert (r.status_code, r.json()) == (want.status, want.body)
    assert r.status_code == 422


# --- the metamodel is read under the mutex ---------------------------------------


def test_a_commit_never_checks_against_a_rebind_that_is_refused(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A rebind refused after it swapped the candidate in puts the old metamodel
    back before it releases the mutex. A commit that arrives meanwhile must not
    have read the candidate: rows of a type only the candidate has would land."""
    import threading

    import data_rover.api.routes.commits as commits_mod
    from data_rover.core.validation.issue import Issue, IssueCategory, Severity

    from .test_commits_metamodel_ops import _acquire_mm

    candidate = MM.replace("relationships:", "  - name: Ghosty\nrelationships:", 1)
    other = TestClient(create_app())
    other.headers.update(AUTH_HEADERS)
    token = _acquire_mm(client)
    rev = head().rev

    rebind_swapped = threading.Event()
    other_read = threading.Event()
    real_blockers = commits_mod.structural_blockers
    real_require = commits_mod.require_model

    def refuse_inside_the_rebind(model: Any, ids: Any) -> Any:
        if not rebind_swapped.is_set():
            rebind_swapped.set()
            other_read.wait()  # the other commit reads the session now
            return [Issue(Severity.ERROR, "forced", ["X"], IssueCategory.STRUCTURAL)]
        return real_blockers(model, ids)

    def reading(session_: Any) -> Any:
        out = real_require(session_)
        if rebind_swapped.is_set():
            other_read.set()
        return out

    monkeypatch.setattr(commits_mod, "structural_blockers", refuse_inside_the_rebind)
    monkeypatch.setattr(commits_mod, "require_model", reading)
    answers: dict[str, Any] = {}

    def rebind() -> None:
        answers["rebind"] = client.post(
            papi("/commits"),
            json={
                "base_rev": rev,
                "ops": [{"kind": "metamodel.rebind", "blob": candidate}],
                "lock_tokens": [token],
            },
        )

    def create() -> None:
        answers["create"] = other.post(
            papi("/commits"),
            json={
                "base_rev": rev,
                "ops": [
                    {
                        "kind": "create_element",
                        "temp_id": "tmp_g",
                        "type_name": "Ghosty",
                        "properties": {},
                    }
                ],
            },
        )

    first = threading.Thread(target=rebind)
    first.start()
    rebind_swapped.wait()
    second = threading.Thread(target=create)
    second.start()
    first.join()
    second.join()
    monkeypatch.undo()
    assert answers["rebind"].status_code == 422, answers["rebind"].text
    assert answers["create"].status_code in (409, 422), answers["create"].text
    assert {e["type_name"] for e in head().elements.values()} == {"Node"}
    mm = get_registry().get(DEFAULT_PROJECT_ID).metamodel
    assert mm is not None and not mm.is_element_type("Ghosty")


def test_a_session_not_at_the_revision_before_the_commit_is_dropped_not_advanced(
    client: TestClient,
) -> None:
    session_ = get_registry().get(DEFAULT_PROJECT_ID)
    base = head().rev
    session_.model_rev = base + 5  # a mirror that has drifted from the row
    body = commit_ops(
        client,
        [{"kind": "update_element", "id": "B1", "properties_patch": {"label": "z"}}],
    )
    assert body["model_rev"] == base + 1  # the row is the authority
    assert session_.model_rev == base + 5  # the dropped session was not advanced
    # the next request hydrates from the journal, which holds the commit
    assert head().elements["B1"]["properties"]["label"] == "z"
    fresh = get_registry().get(DEFAULT_PROJECT_ID)
    assert fresh is not session_ and fresh.model_rev == base + 1


# --- the rounds do not grow with the batch -----------------------------------------


def test_many_attached_elements_then_a_delete_take_one_round(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Attach more elements than ``MAX_ROUNDS`` under X, then delete X: each is
    planned as a delete root, so the batch does not need a round apiece."""
    n = commit_load.MAX_ROUNDS + 4
    model = json.dumps(
        {
            "elements": [_el("X"), *(_el(f"{k}{i}") for i in range(n) for k in "cd")],
            "relationships": [
                _rel(f"k{i}", "Contains", f"c{i}", f"d{i}") for i in range(n)
            ],
        }
    )
    install(metamodel=MM, model=model)
    ops = [_contains("X", f"c{i}", f"tmp_{i}") for i in range(n)] + [_delete("X")]
    oracle = Oracle(model)
    want = oracle.run(model_ops(ops))
    assert want.status == 200
    rounds = _Rounds(monkeypatch)
    commit_ops(client, ops)
    assert rounds.n == 1
    assert head().elements == {}
    assert_rows(oracle, DEFAULT_PROJECT_ID, "attached then deleted")


# --- the transaction ----------------------------------------------------------------


def test_the_check_reads_rows_not_the_session_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """While the batch is checked the session model is an empty one: an answer
    that came from it would be wrong."""
    from data_rover.core.model.model import Model

    session_ = get_registry().get(DEFAULT_PROJECT_ID)
    real = commit_load.load_and_apply

    def blind(*args: Any, **kwargs: Any) -> Any:
        kept = session_.model
        assert kept is not None
        session_.model = Model(kept.metamodel)
        try:
            return real(*args, **kwargs)
        finally:
            session_.model = kept

    monkeypatch.setattr(commit_load, "load_and_apply", blind)
    body = commit_ops(
        client,
        [
            {"kind": "update_element", "id": "B1", "properties_patch": {"label": "z"}},
            _delete("D"),
        ],
    )
    assert "D1" in body["deleted_element_ids"]
    assert head().elements["B1"]["properties"]["label"] == "z"


def test_the_stale_rev_is_judged_on_the_row_under_the_lock(client: TestClient) -> None:
    """``model_rev`` and the tail come from the database inside the commit's
    transaction: a commit the session has not heard of is still seen."""
    base = head().rev
    update = {"kind": "update_element", "id": "B1", "properties_patch": {"label": "1"}}
    commit_ops(client, [update])
    session_ = get_registry().get(DEFAULT_PROJECT_ID)
    session_.model_rev = base  # the session mirror lags the row
    r = post_commit(
        client,
        [{**update, "properties_patch": {"label": "2"}}],
        base_rev=base,
    )
    assert r.status_code == 409
    assert r.json() == {
        "detail": "conflicting concurrent commits",
        "model_rev": base + 1,
    }
    assert head().elements["B1"]["properties"]["label"] == "1"


def test_the_model_row_is_read_for_update(monkeypatch: pytest.MonkeyPatch) -> None:
    with session() as s:
        seen: list[Any] = []
        real = s.execute

        def spy(stmt: Any, *a: Any, **k: Any) -> Any:
            seen.append(stmt)
            return real(stmt, *a, **k)

        monkeypatch.setattr(s, "execute", spy)
        row = content.lock_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        (stmt,) = seen
        assert "FOR UPDATE" in str(stmt.compile(dialect=postgresql.dialect()))


def test_the_lock_comes_before_the_load_and_the_writes_follow_the_digest(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    import data_rover.api.routes.commits as commits_mod
    from sqlalchemy.orm import Session as SaSession

    order: list[str] = []

    def spying(owner: Any, name: str, label: str) -> None:
        real = getattr(owner, name)

        def wrapper(*a: Any, **k: Any) -> Any:
            order.append(label)
            return real(*a, **k)

        monkeypatch.setattr(owner, name, wrapper)

    spying(content, "lock_model_row", "lock")
    spying(commit_load, "plan_load", "plan")
    spying(commits_mod, "fold_batch", "digest")
    spying(head_mod, "write_batch", "write_batch")
    spying(commits_mod, "_stage_commit", "stage")
    spying(SaSession, "commit", "commit")
    commit_ops(
        client,
        [{"kind": "update_element", "id": "B1", "properties_patch": {"label": "z"}}],
    )
    # the helper's first request is refused for want of locks; the second lands
    last = len(order) - 1 - order[::-1].index("lock")
    landed = order[last:]
    assert landed[:2] == ["lock", "plan"]
    steps = [s for s in landed if s in {"digest", "write_batch", "stage", "commit"}]
    assert steps == ["digest", "write_batch", "stage", "commit"]


@pytest.mark.parametrize("failing", ["write_batch", "stage", "commit"])
def test_a_failed_write_leaves_nothing(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, failing: str
) -> None:
    import data_rover.api.routes.commits as commits_mod
    from sqlalchemy.orm import Session as SaSession

    before = head()
    with session() as s:
        refs_before = {
            tuple(r)
            for r in s.execute(
                select(EntityRefRow.referencer_id, EntityRefRow.target_id)
            )
        }
        digest_before = content.get_model_row(s, DEFAULT_PROJECT_ID).state_digest  # type: ignore[union-attr]

    def boom(*a: Any, **k: Any) -> Any:
        raise RuntimeError("down")

    if failing == "write_batch":
        monkeypatch.setattr(head_mod, "write_batch", boom)
    elif failing == "stage":
        monkeypatch.setattr(commits_mod, "_stage_commit", boom)
    else:
        real_commit = SaSession.commit
        real_append = content.append_commit
        staged: list[bool] = []

        def append(*a: Any, **k: Any) -> Any:
            staged.append(True)
            return real_append(*a, **k)

        def commit_fails_once_staged(self: Any) -> None:
            if staged:
                raise RuntimeError("down")
            real_commit(self)

        monkeypatch.setattr(content, "append_commit", append)
        monkeypatch.setattr(SaSession, "commit", commit_fails_once_staged)
    r = post_commit(
        client,
        [
            {"kind": "update_element", "id": "B1", "properties_patch": {"ref": "C"}},
            _delete("D"),
        ],
    )
    monkeypatch.undo()
    assert r.status_code == 500, r.text
    assert head() == before
    with session() as s:
        refs_after = {
            tuple(r)
            for r in s.execute(
                select(EntityRefRow.referencer_id, EntityRefRow.target_id)
            )
        }
        assert refs_after == refs_before
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        assert row.state_digest == digest_before and row.model_rev == before.rev
        assert s.execute(select(Commit).where(Commit.rev > before.rev)).first() is None
    assert get_registry().get(DEFAULT_PROJECT_ID).model_rev == before.rev


def test_a_project_whose_rows_are_not_written_gets_them_before_the_check(
    client: TestClient,
) -> None:
    with session() as s:
        for table in (EntityRefRow, RelationshipRow, ElementRow):
            s.execute(delete(table))
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        row.next_seq = None
        row.state_digest = None
        s.commit()
    oracle = Oracle(json.dumps(_tree()))
    ops = [
        {"kind": "update_element", "id": "B1", "properties_patch": {"label": "z"}},
        _delete("D"),
    ]
    assert oracle.run(model_ops(ops)).status == 200
    commit_ops(client, ops)
    assert_rows(oracle, DEFAULT_PROJECT_ID, "rows written from the session model")


def test_a_refused_commit_ends_the_transaction_the_row_lock_lives_in(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sqlalchemy.orm import Session as SaSession

    rollbacks: list[int] = []
    real = SaSession.rollback

    def counting(self: Any) -> None:
        rollbacks.append(1)
        real(self)

    monkeypatch.setattr(SaSession, "rollback", counting)
    stale = client.post(
        papi("/commits"),
        json={"base_rev": 99, "ops": [_delete("A")]},
        headers=AUTH_HEADERS,
    )
    assert stale.status_code == 409
    assert len(rollbacks) >= 1
    rollbacks.clear()
    assert post_commit(client, [_delete("nope")]).status_code == 422
    assert len(rollbacks) >= 1


def test_every_commit_stores_its_entity_states(client: TestClient) -> None:
    """No cap: a batch of any size stores its states."""
    from data_rover.api import commit_states

    assert not hasattr(commit_states, "ENTITY_STATES_MAX")
    commit_ops(client, [_delete("D")])
    with session() as s:
        row = content.get_commit(s, DEFAULT_PROJECT_ID, head().rev)
        assert row is not None and row.entity_states is not None
        assert set(row.entity_states["elements"]) == {"D", "D1"}


def test_an_empty_head_plans_to_nothing() -> None:
    install(metamodel=MM, model=EMPTY_MODEL)
    rows = _plan([{"kind": "update_element", "id": "x", "properties_patch": {}}])
    assert (rows.elements, rows.relationships) == ([], [])
    assert rows.absent == {"x"}
