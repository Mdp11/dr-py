"""``ProjectState`` and its registry: what a project's state loads, how it is
shared, evicted and discarded, and that no request builds a model."""

from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, project_state
from data_rover.api.db_models import Membership, Project, Role, Snapshot
from data_rover.api.feed import ClientConn, reset_loop
from data_rover.api.lock_mirror import get_lease_mirror, to_mirrored
from data_rover.api.locking import Lease, LockIntent, LockMode, RequiredLock
from data_rover.api.main import create_app
from data_rover.api.project_state import (
    DEFAULT_PROJECT_ID,
    ProjectState,
    ProjectStateRegistry,
    get_project_state,
    get_registry,
)

from .conftest import (
    AUTH_HEADERS,
    EMPTY_MODEL,
    SMART_CITY_MM,
    commit_ops,
    default_state,
    feed_url,
    head,
    install,
    no_model_built,
    papi,
    seed_default_project,
)

_NODE_MM = """
elements:
  - name: Node
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    reset_loop()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    install(metamodel=_NODE_MM, model=EMPTY_MODEL)
    return c


def _lease_rows(project_id: str = "p1") -> list[RequiredLock]:
    return [
        RequiredLock(
            resource_id=f"{project_id}-e1",
            mode=LockMode.EXCLUSIVE,
            intent=LockIntent.EDIT,
        )
    ]


def _hold(state: ProjectState) -> None:
    state.lock_table.acquire(
        "u1", _lease_rows(state.project_id), now=time.monotonic(), ttl=300.0
    )


def _project(project_id: str) -> None:
    with db.db_session() as s:
        s.add(Project(id=project_id, name=project_id))


# --- what a state loads ----------------------------------------------------


def test_default_project_id_is_default() -> None:
    assert DEFAULT_PROJECT_ID == "default"


def test_a_project_with_no_model_row_loads_empty() -> None:
    _project("p1")
    state = get_registry().get("p1")
    assert (state.project_id, state.metamodel, state.model_rev) == ("p1", None, 0)
    assert state.views == {} and state.strict_mode is False


def test_a_state_loads_the_metamodel_rev_and_strict_mode(client: TestClient) -> None:
    with db.db_session() as s:
        content.set_strict_mode(s, DEFAULT_PROJECT_ID, True)
        content.set_model_rev(s, DEFAULT_PROJECT_ID, 7)
    get_registry().reset()
    state = default_state()
    assert state.metamodel is not None
    assert state.metamodel.element_type("Node") is not None
    assert (state.model_rev, state.strict_mode) == (7, True)


def test_a_project_with_no_head_rows_still_loads(client: TestClient) -> None:
    """The state never needs rows: it is the commit and the descriptor that
    answer 409 for a project that has none."""
    with db.db_session() as s:
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None
        row.next_seq = None
        row.state_digest = None
    get_registry().reset()
    assert default_state().metamodel is not None
    r = client.post(
        papi("/commits"),
        json={"base_rev": 0, "ops": []},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "project has no head rows: re-import it"


def test_a_state_loads_every_view(client: TestClient) -> None:
    from .conftest import create_view

    a = create_view(client, "A", {"folders": [{"name": "FA"}]})
    b = create_view(client, "B", {"folders": [{"name": "FB"}]})
    get_registry().reset()
    state = default_state()
    assert {vid: v.folders[0].name for vid, v in state.views.items()} == {
        a: "FA",
        b: "FB",
    }
    assert [v["name"] for v in client.get(papi("/views")).json()] == ["A", "B"]


def test_loading_heals_missing_folder_ids_without_an_edit(client: TestClient) -> None:
    """An old blob (no folder ids) gets them when the state loads, persisted back
    without consuming a view_rev: normalization is not an edit."""
    with db.db_session() as s:
        vid = content.create_view(
            s,
            DEFAULT_PROJECT_ID,
            name="v",
            blob='{"name": "v", "folders": [{"name": "A"}], "artifacts": []}',
        ).id
    get_registry().reset()
    r = client.get(papi(f"/views/{vid}"))
    assert r.status_code == 200
    assert len(r.json()["view"]["folders"][0]["id"]) == 32
    assert r.json()["view_rev"] == 0
    with db.db_session() as s:
        row = content.get_view(s, DEFAULT_PROJECT_ID, vid)
        assert row is not None and '"id"' in row.blob and row.view_rev == 0


def test_a_committed_view_edit_is_what_the_next_load_reads(
    client: TestClient,
) -> None:
    """A view op's blob is staged on the commit's transaction, and a state loaded
    after eviction reads exactly it."""
    from .conftest import create_folder_via_commit

    setup = create_folder_via_commit(client, "A")
    vid, fid = setup["view_id"], setup["id_map"]["tmp_setup"]
    r = client.post(
        papi("/locks"),
        json={
            "targets": [{"resource_id": fid, "mode": "exclusive", "type": "folder"}],
            "intent": "edit",
        },
    )
    assert r.status_code == 200, r.text
    base = client.get(papi("/open")).json()["model_rev"]
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A2"}],
            "message": "m",
            "lock_tokens": [r.json()["token"]],
        },
    )
    assert r.status_code == 200, r.text
    before = client.get(papi(f"/views/{vid}")).json()
    assert before["view"]["folders"][0]["name"] == "A2"
    get_registry().reset()
    assert client.get(papi(f"/views/{vid}")).json() == before


# --- no model --------------------------------------------------------------


def test_requests_build_no_model(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Open, commit, lock, tail and feed on a project whose state is loaded
    cold, with every way of building a whole model made to fail."""
    get_registry().reset()
    no_model_built(monkeypatch)

    assert client.get(papi("/open")).status_code == 200
    created = commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {},
            }
        ],
    )
    nid = created["id_map"]["tmp_a"]
    lock = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": nid, "mode": "exclusive"}], "intent": "edit"},
    )
    assert lock.status_code == 200, lock.text
    tail = client.get(papi("/replica/tail"), params={"from_rev": 0})
    assert tail.status_code == 200 and tail.json()["head_rev"] == 1
    with client.websocket_connect(feed_url()) as ws:
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["model_rev"] == 1
        assert [le["resource_id"] for le in snap["locks"]] == [nid]
    assert nid in head().elements


def test_a_commit_moves_the_states_rev_to_the_rows(client: TestClient) -> None:
    state = default_state()
    assert state.model_rev == 0
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {},
            }
        ],
    )
    assert state.model_rev == head().rev == 1
    assert default_state() is state


# --- sharing ---------------------------------------------------------------


def test_get_returns_one_state_per_project() -> None:
    reg = ProjectStateRegistry()
    assert reg.get("p1") is reg.get("p1")
    assert reg.get("p1") is not reg.get("p2")


def test_states_are_isolated() -> None:
    reg = ProjectStateRegistry()
    reg.get("p1").model_rev = 5
    assert reg.get("p2").model_rev == 0


def test_racing_gets_share_one_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """The barrier is in the worker, so every thread enters ``get`` together; the
    per-project init-once lock lets one load and the rest find its result."""
    loads: list[str] = []
    real = project_state._load

    def counting(project_id: str) -> ProjectState:
        loads.append(project_id)
        return real(project_id)

    monkeypatch.setattr(project_state, "_load", counting)
    reg = ProjectStateRegistry()
    barrier = threading.Barrier(8)
    out: list[ProjectState] = []

    def worker() -> None:
        barrier.wait()
        out.append(reg.get("p1"))

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert loads == ["p1"]
    assert len(out) == 8 and all(s is out[0] for s in out)


def test_peek_neither_loads_nor_refreshes() -> None:
    reg = ProjectStateRegistry()
    assert reg.peek("p1") is None
    state = reg.get("p1")
    stamp = state.last_access
    assert reg.peek("p1") is state
    assert state.last_access == stamp


def test_get_project_state_resolves_the_path_project() -> None:
    # require_membership is the auth gate (Depends-injected, covered by
    # test_authz); a stub membership exercises the registry resolution alone
    stub = Membership(user_id="u", project_id="proj-a", role=Role.owner)
    assert get_project_state("proj-a", stub) is get_registry().get("proj-a")


def test_reset_drops_every_state() -> None:
    reg = ProjectStateRegistry()
    first = reg.get("p1")
    reg.reset()
    assert reg.get("p1") is not first


# --- eviction --------------------------------------------------------------


def test_evict_drops_a_state_with_no_leases_or_clients() -> None:
    reg = ProjectStateRegistry()
    first = reg.get("p1")
    assert reg.evict("p1") is True
    assert reg.project_ids() == []
    assert reg.get("p1") is not first


def test_evict_of_an_unknown_id_drops_nothing() -> None:
    assert ProjectStateRegistry().evict("never-created") is False


def test_evict_writes_no_snapshot(client: TestClient) -> None:
    get_registry().get(DEFAULT_PROJECT_ID)
    commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {},
            }
        ],
    )

    def snapshots() -> list[tuple[int, str]]:
        with db.db_session() as s:
            rows = s.query(Snapshot).filter_by(project_id=DEFAULT_PROJECT_ID).all()
            return sorted((r.rev, r.key) for r in rows)

    before = snapshots()
    assert get_registry().evict(DEFAULT_PROJECT_ID) is True
    assert snapshots() == before


def test_evict_refuses_while_a_lease_is_live() -> None:
    reg = ProjectStateRegistry()
    state = reg.get("p1")
    _hold(state)
    assert reg.evict("p1") is False
    assert reg.get("p1") is state
    # and the lease is still there
    assert state.lock_table.active_leases(time.monotonic())


def test_evict_refuses_while_a_feed_client_is_connected() -> None:
    reg = ProjectStateRegistry()
    state = reg.get("p1")
    state.hub.register(ClientConn(user_id="bob", queue=asyncio.Queue()))
    assert reg.evict("p1") is False
    assert "p1" in reg.project_ids()


def test_evict_refuses_a_state_used_within_the_ttl() -> None:
    """A request that got the state after the sweeper listed it as idle keeps
    it: a request must never be left holding a state the registry dropped."""
    reg = ProjectStateRegistry()
    reg.get("p1")
    now = time.monotonic()
    assert reg.evict("p1", now=now, ttl=10.0) is False
    assert reg.evict("p1", now=now + 10.0, ttl=10.0) is True


def test_idle_lists_stale_projects() -> None:
    reg = ProjectStateRegistry()
    reg.get("p1")
    # ``now`` is anchored to the monotonic clock ``last_access`` is stamped
    # from: that clock is uptime-based, so an absolute constant can read a
    # just-used state as long idle on a freshly booted host
    now = time.monotonic()
    assert reg.idle(now=now, ttl=10.0) == []
    assert reg.idle(now=now + 10.0, ttl=10.0) == ["p1"]


def test_discard_drops_a_guarded_state() -> None:
    """discard is the delete-project path: a live lease or a connected feed
    client must not keep a dead project's state registered."""
    reg = ProjectStateRegistry()
    state = reg.get("p1")
    _hold(state)
    state.hub.register(ClientConn(user_id="u1", queue=asyncio.Queue(maxsize=8)))
    reg.discard("p1")
    assert reg.project_ids() == []


def test_discard_of_an_unknown_id_is_a_no_op() -> None:
    ProjectStateRegistry().discard("never-created")


def test_a_state_restores_mirrored_leases_when_loaded() -> None:
    _project("p1")
    lease = Lease(
        resource_id="e1",
        mode=LockMode.EXCLUSIVE,
        holder="u1",
        holder_email="u1@example.com",
        token="tok-1",
        intent=LockIntent.EDIT,
        expires_at=time.monotonic() + 120.0,
    )
    get_lease_mirror().write(
        "p1", to_mirrored([lease], mono_now=time.monotonic(), wall_now=time.time())
    )
    state = get_registry().get("p1")
    restored = state.lock_table.active_leases(time.monotonic())
    assert [(le.resource_id, le.token) for le in restored] == [("e1", "tok-1")]
    # a held lease makes the state un-evictable; the mirror keeps it for a restart
    assert get_registry().evict("p1") is False


def test_an_evicted_state_restores_leases_from_the_mirror_on_the_next_get() -> None:
    _project("p1")
    reg = get_registry()
    assert reg.get("p1").lock_table.active_leases(time.monotonic()) == []
    assert reg.evict("p1") is True
    lease = Lease(
        resource_id="e1",
        mode=LockMode.EXCLUSIVE,
        holder="u1",
        holder_email="",
        token="tok-2",
        intent=LockIntent.EDIT,
        expires_at=time.monotonic() + 120.0,
    )
    get_lease_mirror().write(
        "p1", to_mirrored([lease], mono_now=time.monotonic(), wall_now=time.time())
    )
    again = reg.get("p1")
    assert [le.token for le in again.lock_table.active_leases(time.monotonic())] == [
        "tok-2"
    ]


def test_a_lease_taken_over_http_keeps_the_state_registered(
    client: TestClient,
) -> None:
    created = commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_a",
                "type_name": "Node",
                "properties": {},
            }
        ],
    )
    nid = created["id_map"]["tmp_a"]
    state = default_state()
    lock = client.post(
        papi("/locks"),
        json={"targets": [{"resource_id": nid, "mode": "exclusive"}], "intent": "edit"},
    )
    assert lock.status_code == 200, lock.text
    assert get_registry().evict(DEFAULT_PROJECT_ID) is False
    assert default_state() is state
    leases = client.get(papi("/locks")).json()["leases"]
    assert [le["resource_id"] for le in leases] == [nid]


# --- rows ------------------------------------------------------------------


def test_the_state_holds_no_model_attribute() -> None:
    state = ProjectState(project_id="p1")
    assert not hasattr(state, "model")


def test_loading_uses_the_smart_city_metamodel_blob(client: TestClient) -> None:
    install(metamodel=SMART_CITY_MM, model=EMPTY_MODEL)
    get_registry().reset()
    state = default_state()
    assert state.metamodel is not None and state.model_rev == 0
