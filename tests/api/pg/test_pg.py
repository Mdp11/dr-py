"""What only a real Postgres decides: row locks, transaction isolation, the
JSON cast, recursive CTEs, and the snapshot writers' connections.

Every wait is on an ``Event`` or a ``Barrier``; a lock wait that never ends hits
the lane's ``lock_timeout`` and fails the test."""

from __future__ import annotations

import gzip
import json
import threading
from collections.abc import Callable, Iterable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, event, func, select, text
from sqlalchemy.exc import OperationalError

from data_rover.api import commit_load, content, db, snapshot_rows
from data_rover.api.commit_load import ancestor_ids, subtree_ids
from data_rover.api.db_models import ElementRow, ModelRow, Snapshot
from data_rover.api.head import read_head
from data_rover.api.main import create_app
from data_rover.api.project_state import DEFAULT_PROJECT_ID
from data_rover.api.snapshot_codec import decode_snapshot
from data_rover.api.snapshot_rows import write_snapshot_from_rows
from data_rover.api.state_digest import entity_hash, format_digest
from data_rover.api.storage import (
    MemorySnapshotStore,
    get_snapshot_store,
    snapshot_key,
)

from ..commit_oracle import MM, Oracle, assert_rows, model_ops
from ..conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    forget_entity_states,
    head,
    install,
    install_unchecked,
    papi,
    post_commit,
    seed_default_project,
)

PID = DEFAULT_PROJECT_ID


# --- helpers ------------------------------------------------------------------


class Worker:
    """A function run in a thread, whose outcome the test reads after ``join``."""

    def __init__(self, fn: Callable[[], Any], name: str = "worker") -> None:
        self.value: Any = None
        self.error: BaseException | None = None
        self._fn = fn
        self._thread = threading.Thread(target=self._run, name=name, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            self.value = self._fn()
        except BaseException as exc:
            self.error = exc

    def join(self) -> Any:
        self._thread.join()
        if self.error is not None:
            raise self.error
        return self.value


@pytest.fixture
def app_client() -> Callable[[], TestClient]:
    """A factory of clients over one app: ``create_app`` replaces the process's
    snapshot store, so it runs once."""
    seed_default_project()
    app = create_app()

    def make() -> TestClient:
        c = TestClient(app)
        c.headers.update(AUTH_HEADERS)
        return c

    return make


@pytest.fixture
def client(app_client: Callable[[], TestClient]) -> TestClient:
    return app_client()


def chain_model(n: int, *, close: bool = False) -> str:
    """``n0`` contains ``n1`` contains ... ``n{n-1}``, optionally back to ``n0``."""
    elements = [
        {"id": f"n{i}", "type_name": "Node", "properties": {}, "rev": 0}
        for i in range(n)
    ]
    pairs = [(i, i + 1) for i in range(n - 1)] + ([(n - 1, 0)] if close else [])
    relationships = [
        {
            "id": f"c{i}",
            "type_name": "Contains",
            "source_id": f"n{a}",
            "target_id": f"n{b}",
            "properties": {},
            "rev": 0,
        }
        for i, (a, b) in enumerate(pairs)
    ]
    return json.dumps({"elements": elements, "relationships": relationships})


def create_op(eid: str, **props: Any) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": f"tmp_{eid}",
        "id": eid,
        "type_name": "Node",
        "properties": props,
    }


def forget_snapshots() -> None:
    """The project has no snapshot, row or blob: the next opener writes one."""
    with db.db_session() as s:
        s.execute(delete(Snapshot).where(Snapshot.project_id == PID))
    store = get_snapshot_store()
    assert isinstance(store, MemorySnapshotStore)
    store.clear()


def snapshot_rows_of(pid: str = PID) -> list[Snapshot]:
    with db.db_session() as s:
        rows = list(s.scalars(select(Snapshot).where(Snapshot.project_id == pid)))
        s.expunge_all()
    return rows


def snapshot_document(rev: int) -> tuple[bytes, dict[str, Any]]:
    with db.db_session() as s:
        row = content.get_snapshot(s, PID, rev)
        assert row is not None
        key = row.key
    blob = get_snapshot_store().get(key)
    return gzip.decompress(blob), decode_snapshot(blob)


def digest_of(document: dict[str, Any]) -> str:
    value = 0
    for entity in (*document["elements"], *document["relationships"]):
        value ^= entity_hash(entity["id"], entity["rev"])
    return format_digest(value)


class HookedStore:
    """The snapshot store, running ``before_put`` once a writer has read its
    header and before it streams a line (the stream is consumed by ``put``)."""

    def __init__(self, real: Any, before_put: Callable[[], None]) -> None:
        self._real = real
        self._before_put = before_put

    def put(self, key: str, chunks: Iterable[bytes]) -> None:
        self._before_put()
        self._real.put(key, chunks)

    def get(self, key: str) -> bytes:
        return self._real.get(key)  # type: ignore[no-any-return]

    def exists(self, key: str) -> bool:
        return self._real.exists(key)  # type: ignore[no-any-return]

    def delete(self, key: str) -> None:
        self._real.delete(key)


def hook_puts(monkeypatch: pytest.MonkeyPatch, before_put: Callable[[], None]) -> None:
    hooked = HookedStore(get_snapshot_store(), before_put)
    monkeypatch.setattr(snapshot_rows, "get_snapshot_store", lambda: hooked)


def row_lock_is_held(pid: str = PID) -> bool:
    """Whether another connection is refused the project's ``ModelRow`` lock."""
    with db.get_engine().connect() as conn:
        try:
            conn.execute(
                select(ModelRow.project_id)
                .where(ModelRow.project_id == pid)
                .with_for_update(nowait=True)
            ).all()
        except OperationalError as exc:
            assert getattr(exc.orig, "sqlstate", None) == "55P03", exc
            return True
        finally:
            conn.rollback()
    return False


# --- concurrent commits ---------------------------------------------------------


def test_concurrent_commits_serialize(app_client: Callable[[], TestClient]) -> None:
    install(metamodel=MM, model=EMPTY_MODEL)
    batches = {
        "a": [create_op("a1", label="a"), create_op("a2", label="a")],
        "b": [create_op("b1", label="b")],
    }
    barrier = threading.Barrier(2)

    def commit(name: str) -> Any:
        c = app_client()
        barrier.wait()
        return post_commit(c, batches[name], base_rev=0)

    workers = {name: Worker(lambda n=name: commit(n)) for name in batches}  # type: ignore[misc]
    responses = {name: w.join() for name, w in workers.items()}

    accepted = sorted(
        (
            (r.json()["model_rev"], name)
            for name, r in responses.items()
            if r.status_code == 200
        )
    )
    refused = [r for r in responses.values() if r.status_code != 200]
    assert accepted, [r.text for r in responses.values()]
    assert [rev for rev, _ in accepted] == list(range(1, len(accepted) + 1))
    for r in refused:
        assert r.status_code == 409, r.text
    assert len(accepted) + len(refused) == 2

    oracle = Oracle(EMPTY_MODEL)
    last: str | None = None
    for _rev, name in accepted:
        outcome = oracle.run(model_ops(batches[name]))
        assert outcome.status == 200
        last = outcome.digest
    assert_rows(oracle, PID, "after the accepted commits")
    body = responses[accepted[-1][1]].json()
    assert body["state_digest"] == last
    assert head().rev == len(accepted)


def test_the_commit_holds_the_row_lock_for_its_transaction(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    install(metamodel=MM, model=EMPTY_MODEL)
    inside, proceed = threading.Event(), threading.Event()
    real_plan = commit_load.plan_load

    def held_plan(*a: Any, **k: Any) -> Any:
        inside.set()
        proceed.wait()
        return real_plan(*a, **k)

    monkeypatch.setattr(commit_load, "plan_load", held_plan)
    assert not row_lock_is_held()
    worker = Worker(lambda: post_commit(client, [create_op("a1")], base_rev=0))
    inside.wait()
    try:
        assert row_lock_is_held()
    finally:
        proceed.set()
    assert worker.join().status_code == 200
    assert not row_lock_is_held()


def test_the_commit_reads_the_revision_the_lock_holder_committed(
    client: TestClient,
) -> None:
    """A holder of the row lock that moves the revision makes a commit made at
    the old one stale: the lock read is refreshed, not served from a snapshot."""
    install(metamodel=MM, model=EMPTY_MODEL)
    holder = db.db_session()
    s = holder.__enter__()
    try:
        row = content.lock_model_row(s, PID)
        assert row is not None
        assert row_lock_is_held()
        content.append_commit(
            s,
            PID,
            rev=1,
            commit_id="x",
            author_id=None,
            ops=[],
            inverse_ops=[],
            id_map={},
        )
        content.set_model_rev(s, PID, 1)
    finally:
        holder.__exit__(None, None, None)
    r = post_commit(client, [create_op("a1")], base_rev=0)
    assert r.status_code == 409, r.text
    assert head().elements == {}


# --- values -----------------------------------------------------------------------

VALUES_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
      - {name: n, datatype: integer}
      - {name: x, datatype: float}
      - {name: nan, datatype: string}
      - {name: inf, datatype: string}
"""

VALUES_MODEL = """{
  "elements": [
    {"id": "a", "type_name": "Node", "rev": 0, "properties": {
      "x": 1.0, "n": 1152921504606846976, "nan": NaN, "inf": Infinity,
      "label": "-Infinity"}}
  ],
  "relationships": []
}"""


def test_values_round_trip(client: TestClient) -> None:
    install(metamodel=VALUES_MM, model=VALUES_MODEL)

    def check(eid: str, want: dict[str, Any]) -> None:
        with db.db_session() as s:
            (stored,) = s.scalars(
                select(ElementRow.properties).where(
                    ElementRow.project_id == PID, ElementRow.id == eid
                )
            )
            elements, _ = read_head(s, PID)
        got = next(e for e in elements if e["id"] == eid)["properties"]
        assert repr(got) == repr(want), eid
        assert '"x":1.0' in stored and f'"n":{2**60}' in stored, stored

    check(
        "a",
        {
            "x": 1.0,
            "n": 2**60,
            "nan": "NaN",
            "inf": "Infinity",
            "label": "-Infinity",
        },
    )
    r = post_commit(
        client,
        [create_op("b", x=1.0, n=2**60, nan="NaN", inf="Infinity")],
        base_rev=0,
    )
    assert r.status_code == 200, r.text
    check("b", {"x": 1.0, "n": 2**60, "nan": "NaN", "inf": "Infinity"})

    rev = write_snapshot_from_rows(PID)
    assert rev == 1
    text_, document = snapshot_document(rev)
    assert text_.count(b'"x":1.0') == 2
    assert text_.count(b'"n":1152921504606846976') == 2
    assert b'"nan":"NaN"' in text_ and b'"inf":"Infinity"' in text_
    for entity in document["elements"]:
        assert repr(entity["properties"]["x"]) == "1.0"
        assert entity["properties"]["n"] == 2**60
    assert digest_of(document) == head_digest()


def head_digest() -> str:
    with db.db_session() as s:
        row = content.get_model_row(s, PID)
        assert row is not None and row.state_digest is not None
        return row.state_digest


# --- recursive CTEs ---------------------------------------------------------------


def test_ctes() -> None:
    n = 5000
    install(metamodel=MM, model=chain_model(n))
    everything = {f"n{i}" for i in range(n)}
    with db.db_session() as s:
        assert subtree_ids(s, PID, ["n0"], ["Contains"]) == everything
        assert subtree_ids(s, PID, ["n2500"], ["Contains"]) == {
            f"n{i}" for i in range(2500, n)
        }
        assert ancestor_ids(s, PID, [f"n{n - 1}"], ["Contains"]) == everything
        assert ancestor_ids(s, PID, ["n10"], ["Contains"]) == {
            f"n{i}" for i in range(11)
        }
        # a relationship in ``skip`` is not followed; a missing start is absent
        assert subtree_ids(s, PID, ["n0", "nope"], ["Contains"], skip=["c9"]) == {
            f"n{i}" for i in range(10)
        }
        # no containment type: the starts alone
        assert subtree_ids(s, PID, ["n0"], []) == {"n0"}


def test_ctes_end_on_a_containment_cycle() -> None:
    install(metamodel=MM, model=EMPTY_MODEL)
    install_unchecked(metamodel=MM, model=chain_model(50, close=True))
    everything = {f"n{i}" for i in range(50)}
    with db.db_session() as s:
        assert subtree_ids(s, PID, ["n7"], ["Contains"]) == everything
        assert ancestor_ids(s, PID, ["n7"], ["Contains"]) == everything


def test_a_deep_subtree_delete_through_the_commit_path(client: TestClient) -> None:
    n = 400
    model = chain_model(n)
    install(metamodel=MM, model=model)
    ops = [{"kind": "delete_element", "id": "n0"}]
    oracle = Oracle(model)
    want = oracle.run(model_ops(ops))
    assert want.status == 200
    r = post_commit(client, ops, base_rev=0)
    assert r.status_code == 200, r.text
    assert r.json()["state_digest"] == want.digest
    assert len(r.json()["deleted_element_ids"]) == n
    assert_rows(oracle, PID, "after the cascade")
    assert head().elements == {}


# --- the snapshot writer ----------------------------------------------------------


def test_snapshot_repeatable_read(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A snapshot running while a commit lands writes the state it began at."""
    model = chain_model(6)
    install(metamodel=MM, model=model)
    before = json.loads(model)
    forget_snapshots()
    reached, proceed = threading.Event(), threading.Event()

    def hold() -> None:
        reached.set()
        proceed.wait()

    hook_puts(monkeypatch, hold)
    worker = Worker(lambda: write_snapshot_from_rows(PID), name="snapshot")
    reached.wait()
    try:
        r = post_commit(
            client,
            [
                create_op("late", label="after"),
                {
                    "kind": "update_element",
                    "id": "n0",
                    "properties_patch": {"label": "changed"},
                },
            ],
            base_rev=0,
        )
        assert r.status_code == 200, r.text
    finally:
        proceed.set()
    assert worker.join() == 0

    _, document = snapshot_document(0)
    assert [e["id"] for e in document["elements"]] == [
        e["id"] for e in before["elements"]
    ]
    assert all("label" not in e["properties"] for e in document["elements"])
    assert digest_of(document) == digest_of(before)
    (row,) = snapshot_rows_of()
    assert row.rev == 0 and row.state_digest == digest_of(document)
    assert head().rev == 1


def test_snapshot_reads_in_a_repeatable_read_transaction_with_a_server_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    install(metamodel=MM, model=chain_model(50))
    forget_snapshots()
    monkeypatch.setattr(snapshot_rows, "YIELD_PER", 7)
    seen: list[tuple[str, bool]] = []

    def record(conn: Any, cursor: Any, statement: str, *_a: Any) -> None:
        if threading.current_thread().name == "snapshot":
            seen.append((statement, getattr(cursor, "name", None) is not None))

    engine = db.get_engine()
    event.listen(engine, "before_cursor_execute", record)
    try:
        assert (
            Worker(lambda: write_snapshot_from_rows(PID), name="snapshot").join() == 0
        )
    finally:
        event.remove(engine, "before_cursor_execute", record)

    # Postgres refuses the SET unless it is the transaction's first statement
    assert seen[0][0] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"
    streamed = [s for s, server_side in seen if server_side]
    assert any("FROM elements" in s for s in streamed), seen
    assert any("FROM relationships" in s for s in streamed), seen
    _, document = snapshot_document(0)
    assert len(document["elements"]) == 50 and len(document["relationships"]) == 49


def test_the_snapshot_writer_has_its_own_connection_under_the_row_lock(
    client: TestClient,
) -> None:
    install(metamodel=MM, model=chain_model(5))
    forget_snapshots()
    with db.db_session() as s:
        assert content.lock_model_row(s, PID) is not None
        assert row_lock_is_held()
        assert write_snapshot_from_rows(PID) == 0
    # the descriptor takes the lock itself and writes under it
    forget_snapshots()
    r = client.get(papi("/replica/snapshot"))
    assert r.status_code == 200, r.text
    assert r.json()["rev"] == 0
    assert [s.rev for s in snapshot_rows_of()] == [0]
    assert not row_lock_is_held()


def test_the_job_and_the_descriptor_write_the_same_rev_at_once(
    app_client: Callable[[], TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both writers stream, then both record the one ``(project, rev)`` row, from
    their own READ COMMITTED sessions: neither fails."""
    install(metamodel=MM, model=chain_model(30))
    forget_snapshots()
    both_streaming = threading.Barrier(2)

    def meet() -> None:
        both_streaming.wait()

    hook_puts(monkeypatch, meet)
    job = Worker(lambda: write_snapshot_from_rows(PID), name="job")
    descriptor = Worker(
        lambda: app_client().get(papi("/replica/snapshot")), name="descriptor"
    )
    response = descriptor.join()
    assert response.status_code == 200, response.text
    assert job.join() == 0
    assert response.json()["rev"] == 0
    (row,) = snapshot_rows_of()
    assert row.rev == 0 and row.format == "v2"
    assert (row.elements, row.relationships) == (30, 29)
    assert row.state_digest == head_digest()


def test_a_job_held_mid_stream_does_not_block_the_descriptor(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    install(metamodel=MM, model=chain_model(30))
    forget_snapshots()
    reached, proceed = threading.Event(), threading.Event()

    def hold_the_job() -> None:
        if threading.current_thread().name == "job":
            reached.set()
            proceed.wait()

    hook_puts(monkeypatch, hold_the_job)
    job = Worker(lambda: write_snapshot_from_rows(PID), name="job")
    reached.wait()
    try:
        response = client.get(papi("/replica/snapshot"))
        assert response.status_code == 200, response.text
        assert [s.rev for s in snapshot_rows_of()] == [0]
        assert not row_lock_is_held()
    finally:
        proceed.set()
    assert job.join() == 0
    (row,) = snapshot_rows_of()
    assert row.rev == 0 and row.state_digest == head_digest()
    assert row.key == snapshot_key(PID, 0)


# --- the tail ------------------------------------------------------------------------


def test_tail_null_cast(client: TestClient) -> None:
    """K-36: ``CAST(entity_states AS VARCHAR) = 'null'`` is the stored JSON text on
    Postgres, so a row whose states are JSON ``null`` is not served as a delta,
    and one whose states hold ``null`` values is."""
    with db.db_session() as s:
        assert s.execute(
            text(
                "select cast('null'::json as varchar) = 'null', "
                "cast(null::json as varchar) is null"
            )
        ).one() == (True, True)

    install(metamodel=MM, model=EMPTY_MODEL)
    for ops in (
        [create_op("a", label="x"), create_op("b")],
        [{"kind": "delete_element", "id": "a"}],
        [create_op("c")],
    ):
        r = post_commit(client, ops)
        assert r.status_code == 200, r.text

    def tail(from_rev: int) -> dict[str, Any]:
        r = client.get(papi("/replica/tail"), params={"from_rev": from_rev})
        assert r.status_code == 200, r.text
        body: dict[str, Any] = r.json()
        return body

    full = tail(0)
    assert full["complete"] is True and [d["rev"] for d in full["deltas"]] == [1, 2, 3]
    assert full["deltas"][1]["deleted_element_ids"] == ["a"]
    assert full["deltas"][1]["changed_elements"] == []
    with db.db_session() as s:
        states = content.get_commit(s, PID, 2)
        assert states is not None and states.entity_states is not None
        assert states.entity_states["elements"]["a"]["after"] is None

    forget_entity_states(2)  # JSON null, as a Python None is stored
    assert tail(0)["complete"] is False
    assert tail(2)["complete"] is True

    with db.db_session() as s:  # SQL NULL
        s.execute(text("update commits set entity_states = null where rev = 3"))
    assert tail(2)["complete"] is False
    assert tail(3)["complete"] is True
    with db.db_session() as s:
        assert s.scalar(select(func.count()).select_from(ElementRow)) == 2
