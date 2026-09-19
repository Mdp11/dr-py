"""``GET /replica/snapshot`` names the stored v2 snapshot head is reachable
from by a complete tail, writing one at head when none is; its ``url`` is
``GET /replica/snapshots/{rev}``, the gzip bytes as stored."""

from __future__ import annotations

import gzip
import json
import threading
from collections.abc import Callable, Iterable
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from data_rover.api import content, db, replica
from data_rover.api.db_models import Role, Snapshot, User
from data_rover.api.feed import reset_loop
from data_rover.api.main import create_app
from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry, get_session
from data_rover.api.storage import (
    MemorySnapshotStore,
    get_snapshot_store,
    set_snapshot_store,
)
from data_rover.api.tenancy import add_member

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_snapshot_writers import _ProbingStore

_MM = """
elements:
  - name: Node
    properties:
      - {name: label, datatype: string}
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

_VIEWER = {"x-user-id": "viewer", "x-user-email": "viewer@example.com"}


class _CountingStore(MemorySnapshotStore):
    def __init__(self) -> None:
        super().__init__()
        self.puts = 0
        self.fail = False

    def put(self, key: str, chunks: Iterable[bytes]) -> None:
        self.puts += 1
        if self.fail:
            raise RuntimeError("store down")
        super().put(key, chunks)


@pytest.fixture
def store() -> _CountingStore:
    return _CountingStore()


@pytest.fixture
def client(store: _CountingStore) -> TestClient:
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    set_snapshot_store(store)  # after create_app, which installs its own
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


def _live_digest() -> str:
    session = get_session()
    with session.write_mutex:
        return session.state_digest()


def _descriptor(client: TestClient, **kw: Any) -> dict[str, Any]:
    res = client.get(papi("/replica/snapshot"), **kw)
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _tail(client: TestClient, from_rev: int) -> dict[str, Any]:
    res = client.get(papi("/replica/tail"), params={"from_rev": from_rev})
    assert res.status_code == 200, res.text
    body: dict[str, Any] = res.json()
    return body


def _snapshot_revs() -> list[int]:
    with db.db_session() as s:
        return list(
            s.execute(
                select(Snapshot.rev)
                .where(Snapshot.project_id == DEFAULT_PROJECT_ID)
                .order_by(Snapshot.rev)
            ).scalars()
        )


def _row(rev: int) -> Snapshot:
    with db.db_session() as s:
        row = content.get_snapshot(s, DEFAULT_PROJECT_ID, rev)
        assert row is not None
        s.expunge(row)
        return row


def _blob_header(rev: int) -> dict[str, Any]:
    blob = get_snapshot_store().get(_row(rev).key)
    header: dict[str, Any] = json.loads(gzip.decompress(blob).partition(b"\n")[0])
    return header


def _node(label: str) -> dict[str, Any]:
    return {
        "kind": "create_element",
        "temp_id": "tmp_n",
        "type_name": "Node",
        "properties": {"label": label},
    }


def _ops(client: TestClient, ops: list[dict[str, Any]]) -> None:
    res = client.post(papi("/model/ops"), json={"base_rev": _head(), "ops": ops})
    assert res.status_code == 200, res.text


def _rebind(client: TestClient) -> None:
    res = client.post(
        papi("/locks"),
        json={
            "targets": [
                {"resource_id": "mm", "mode": "exclusive", "type": "metamodel"}
            ],
            "intent": "edit",
        },
    )
    assert res.status_code == 200, res.text
    res = client.post(
        papi("/commits"),
        json={
            "base_rev": _head(),
            "ops": [{"kind": "metamodel.rebind", "blob": _MM_V2}],
            "message": "rebind",
            "lock_tokens": [res.json()["token"]],
        },
    )
    assert res.status_code == 200, res.text


def _legacy_create(client: TestClient) -> None:
    res = client.post(papi("/model/elements"), json={"type": "Node", "properties": {}})
    assert res.status_code == 201, res.text


# --- ways no stored snapshot qualifies ----------------------------------------


def _only_v1(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    _ops(client, [_node("A")])
    with db.db_session() as s:
        s.execute(update(Snapshot).values(format=None))


def _deprecated_post_model(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    with db.db_session() as s:
        s.execute(delete(Snapshot))
    res = client.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text


def _over_the_cap(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    mp.setattr("data_rover.api.commit_states.ENTITY_STATES_MAX", 1)
    _ops(
        client,
        [_node("A"), {**_node("B"), "temp_id": "tmp_b"}],
    )


def _rebind_without_its_snapshot(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    _rebind(client)
    with db.db_session() as s:
        s.execute(delete(Snapshot).where(Snapshot.rev == _head()))


def _past_the_revision_cap(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    mp.setattr("data_rover.api.replica.TAIL_MAX_REVS", 1)
    _ops(client, [_node("A")])
    _ops(client, [_node("B")])


def _touch_model_hole(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    _ops(client, [_node("A")])
    _legacy_create(client)


_NONE_QUALIFIES: dict[str, Callable[[TestClient, pytest.MonkeyPatch], None]] = {
    "only-v1": _only_v1,
    "deprecated-post-model": _deprecated_post_model,
    "over-the-entity-states-cap": _over_the_cap,
    "rebind-without-its-snapshot": _rebind_without_its_snapshot,
    "past-the-revision-cap": _past_the_revision_cap,
    "touch-model-hole": _touch_model_hole,
}


def _two_commits(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    _ops(client, [_node("A")])
    _ops(client, [_node("B")])


def _a_periodic_snapshot(client: TestClient, mp: pytest.MonkeyPatch) -> None:
    mp.setenv("DATA_ROVER_SNAPSHOT_EVERY", "1")
    _ops(client, [_node("A")])
    mp.setenv("DATA_ROVER_SNAPSHOT_EVERY", "200")
    _ops(client, [_node("B")])


_QUALIFIES = {"two-commits": _two_commits, "a-periodic-snapshot": _a_periodic_snapshot}


# --- the descriptor -----------------------------------------------------------


def test_the_descriptor_names_the_newest_v2_snapshot_head_is_reachable_from(
    client: TestClient, store: _CountingStore
) -> None:
    r0 = _head()
    _two_commits(client, pytest.MonkeyPatch())
    puts, revs = store.puts, _snapshot_revs()
    desc = _descriptor(client)
    assert desc["rev"] == r0
    assert store.puts == puts and _snapshot_revs() == revs
    row, header = _row(r0), _blob_header(r0)
    for field in ("metamodel_id", "state_digest", "elements", "relationships"):
        assert desc[field] == getattr(row, field) == header[field], field
    assert desc["state_digest"] != _live_digest()
    assert (
        desc["url"] == f"/api/v1/projects/{DEFAULT_PROJECT_ID}/replica/snapshots/{r0}"
    )


def test_the_descriptor_prefers_a_newer_snapshot(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _a_periodic_snapshot(client, monkeypatch)
    newest = max(_snapshot_revs())
    assert newest == _head() - 1
    assert _descriptor(client)["rev"] == newest


@pytest.mark.parametrize("setup", list(_NONE_QUALIFIES))
def test_the_descriptor_writes_one_at_head_when_none_qualifies(
    client: TestClient,
    store: _CountingStore,
    monkeypatch: pytest.MonkeyPatch,
    setup: str,
) -> None:
    _NONE_QUALIFIES[setup](client, monkeypatch)
    puts = store.puts
    desc = _descriptor(client)
    assert desc["rev"] == _head()
    assert _row(_head()).format == "v2"
    assert desc["state_digest"] == _live_digest()
    assert store.puts == puts + 1


@pytest.mark.parametrize("setup", list(_NONE_QUALIFIES) + list(_QUALIFIES))
def test_the_descriptor_and_the_tail_agree(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, setup: str
) -> None:
    {**_NONE_QUALIFIES, **_QUALIFIES}[setup](client, monkeypatch)
    tail = _tail(client, _descriptor(client)["rev"])
    assert tail["complete"] is True
    assert tail["head_rev"] == _head()


def test_a_second_opener_writes_nothing(
    client: TestClient, store: _CountingStore
) -> None:
    _touch_model_hole(client, pytest.MonkeyPatch())
    puts = store.puts
    first, second = _descriptor(client), _descriptor(client)
    assert first == second
    assert store.puts == puts + 1


def test_the_head_write_happens_under_the_write_mutex(client: TestClient) -> None:
    _touch_model_hole(client, pytest.MonkeyPatch())
    session = get_session()
    probing = _ProbingStore(session.write_mutex)
    set_snapshot_store(probing)
    _descriptor(client)
    assert probing.puts == 1
    assert probing.acquired and not any(probing.acquired)


def test_the_slow_path_looks_again_before_it_writes(
    client: TestClient, store: _CountingStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _two_commits(client, monkeypatch)
    real = replica.pick_snapshot
    calls: list[int] = []

    def declines_once(*args: Any) -> Any:
        calls.append(1)
        return None if len(calls) == 1 else real(*args)

    monkeypatch.setattr(replica, "pick_snapshot", declines_once)
    puts = store.puts
    desc = _descriptor(client)
    assert len(calls) == 2
    assert store.puts == puts
    assert desc["rev"] < _head()


def _mutex_is_free() -> bool:
    mutex = get_session().write_mutex
    out: list[bool] = []

    def _try() -> None:
        got = mutex.acquire(blocking=False)
        if got:
            mutex.release()
        out.append(got)

    t = threading.Thread(target=_try)
    t.start()
    t.join()
    return out[0]


def test_a_failed_head_write_is_a_503(
    client: TestClient, store: _CountingStore
) -> None:
    _touch_model_hole(client, pytest.MonkeyPatch())
    store.fail = True
    res = client.get(papi("/replica/snapshot"))
    assert res.status_code == 503
    assert res.json()["detail"] == "snapshot store unavailable"
    assert _mutex_is_free()


def test_no_model_no_descriptor(client: TestClient) -> None:
    res = client.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert res.status_code == 200, res.text
    assert get_session().model is None
    res = client.get(papi("/replica/snapshot"))
    assert res.status_code == 404
    assert res.json()["detail"] == "No model loaded"


def _seed_viewer() -> None:
    with db.db_session() as s:
        s.add(User(id="viewer", email="viewer@example.com"))
        s.flush()
        add_member(s, DEFAULT_PROJECT_ID, "viewer", Role.viewer)


def test_a_viewer_may_open(client: TestClient, store: _CountingStore) -> None:
    _seed_viewer()
    _touch_model_hole(client, pytest.MonkeyPatch())
    puts = store.puts
    desc = _descriptor(client, headers=_VIEWER)
    assert desc["rev"] == _head() and store.puts == puts + 1
    assert client.get(desc["url"], headers=_VIEWER).status_code == 200


def test_a_non_member_may_not(client: TestClient) -> None:
    stranger = {"x-user-id": "stranger", "x-user-email": "stranger@example.com"}
    assert client.get(papi("/replica/snapshot"), headers=stranger).status_code == 403
    assert client.get(papi("/replica/snapshots/0"), headers=stranger).status_code == 403


# --- the blob -------------------------------------------------------------------


def test_the_blob_is_the_stored_bytes(client: TestClient) -> None:
    desc = _descriptor(client)
    res = client.get(desc["url"])
    assert res.status_code == 200
    stored = get_snapshot_store().get(_row(desc["rev"]).key)
    assert res.headers["content-type"] == "application/gzip"
    assert int(res.headers["content-length"]) == len(stored)
    assert "content-encoding" not in res.headers
    assert res.headers["cache-control"] == "no-store"
    assert res.content == stored
    assert res.content[:2] == b"\x1f\x8b"


def test_the_blob_inflates_to_the_descriptors_header(client: TestClient) -> None:
    _two_commits(client, pytest.MonkeyPatch())
    desc = _descriptor(client)
    header = json.loads(
        gzip.decompress(client.get(desc["url"]).content).partition(b"\n")[0]
    )
    assert header["rev"] == desc["rev"]
    for field in ("metamodel_id", "state_digest", "elements", "relationships"):
        assert header[field] == desc[field], field


def _blob_404(client: TestClient, rev: int) -> None:
    res = client.get(papi(f"/replica/snapshots/{rev}"))
    assert res.status_code == 404
    assert res.json()["detail"] == f"no v2 snapshot at rev {rev}"


def test_no_blob_for_an_unknown_rev(client: TestClient) -> None:
    _blob_404(client, _head() + 7)


def test_no_blob_for_a_v1_snapshot(client: TestClient) -> None:
    rev = _head()
    with db.db_session() as s:
        s.execute(update(Snapshot).values(format=None))
    _blob_404(client, rev)


def test_no_blob_when_the_store_lost_it(client: TestClient) -> None:
    rev = _head()
    get_snapshot_store().delete(_row(rev).key)
    _blob_404(client, rev)


def test_the_blob_route_hydrates_nothing(client: TestClient) -> None:
    _ops(client, [_node("A")])
    rev = _head()
    get_registry().evict(DEFAULT_PROJECT_ID)
    assert get_registry().peek(DEFAULT_PROJECT_ID) is None
    res = client.get(papi(f"/replica/snapshots/{rev}"))
    assert res.status_code == 200
    assert get_registry().peek(DEFAULT_PROJECT_ID) is None
