from __future__ import annotations

import gzip
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, hydration
from data_rover.api.db_models import Project
from data_rover.api.main import create_app
from data_rover.api.storage import (
    MemorySnapshotStore,
    get_snapshot_store,
    set_snapshot_store,
    snapshot_key,
)
from data_rover.api.session import Session
from data_rover.core.metamodel.loader import load_metamodel_str

from .conftest import (
    AUTH_HEADERS,
    create_folder_via_commit,
    create_view,
    papi,
    seed_default_project,
)

MM_YAML = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")


@pytest.fixture(autouse=True)
def _env():
    db.init_engine("sqlite://", force=True)
    db.create_all()
    store = MemorySnapshotStore()
    set_snapshot_store(store)
    with db.db_session() as s:
        s.add(Project(id="p1", name="P1"))
    yield
    set_snapshot_store(None)


def _seed_baseline() -> Session:
    """Build an in-memory session with the metamodel + a tiny model, persist it."""
    from data_rover.core.model.model import Model

    mm = load_metamodel_str(MM_YAML)
    model = Model(mm)
    sess = Session(metamodel=mm, model=model)
    with db.db_session() as s:
        mmrow = content.create_metamodel(s, name="smart-city", version=1, blob=MM_YAML)
        content.upsert_model_row(s, "p1", metamodel_id=mmrow.id)
    hydration.persist_baseline("p1", sess, author_id=None)
    return sess


def test_persist_then_hydrate_roundtrip_empty_model() -> None:
    _seed_baseline()
    h = hydration.hydrate_session("p1")
    assert h.metamodel is not None
    assert h.model is not None
    assert h.model_rev == 0
    assert len(h.model.elements) == 0


def test_hydrate_contentless_project_is_empty_session() -> None:
    # no model row at all -> empty session (today's behaviour, keeps tests green)
    h = hydration.hydrate_session("p1")
    assert h.metamodel is None and h.model is None and h.model_rev == 0


def test_hydrate_replays_commit_tail_on_top_of_snapshot() -> None:
    sess = _seed_baseline()
    # one commit that creates an element, recorded as rev 1 with a rev-0 snapshot
    create = {
        "kind": "create_element",
        "temp_id": "e1",
        "type_name": _first_concrete_element_type(sess),
        "properties": {},
    }
    with db.db_session() as s:
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[create], inverse_ops=[], id_map={},
        )
        content.set_model_rev(s, "p1", 1)
    h = hydration.hydrate_session("p1")
    assert h.model_rev == 1
    assert h.model is not None and "e1" in h.model.elements


def _first_concrete_element_type(sess: Session) -> str:
    # Metamodel.elements is the public list[ElementType]; each has .name/.abstract
    assert sess.metamodel is not None, "session must have a metamodel"
    for et in sess.metamodel.elements:
        if not et.abstract:
            return et.name
    raise AssertionError("no concrete element type in smart-city metamodel")


@pytest.fixture
def client() -> TestClient:
    """HTTP-driven fixture for the eviction/rehydration tests below: seeds the
    DEFAULT project (distinct from ``_env``'s "p1") with a real metamodel +
    empty model so a durable ``ModelRow`` exists — hydration's early
    ``if model_row is None: return Session()`` would otherwise skip the view
    entirely, defeating the point of the healing test."""
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    c.post(
        papi("/metamodel"),
        content=MM_YAML,
        headers={"content-type": "application/x-yaml"},
    )
    c.post(papi("/model"), json={"elements": [], "relationships": []})
    return c


def test_hydration_heals_missing_folder_ids(client: TestClient) -> None:
    """An old blob (no folder ids) is healed at hydration and persisted back
    WITHOUT consuming a view_rev — normalization is not an edit."""
    from data_rover.api import content, db
    from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

    gen = db.get_db()
    s = next(gen)
    try:
        vid = content.create_view(
            s,
            DEFAULT_PROJECT_ID,
            name="v",
            blob='{"name": "v", "folders": [{"name": "A"}], "artifacts": []}',
        ).id
        s.commit()
    finally:
        gen.close()

    get_registry().evict(DEFAULT_PROJECT_ID)
    r = client.get(papi(f"/views/{vid}"))
    assert r.status_code == 200
    assert len(r.json()["view"]["folders"][0]["id"]) == 32
    assert r.json()["view_rev"] == 0

    gen = db.get_db()
    s = next(gen)
    try:
        row = content.get_view(s, DEFAULT_PROJECT_ID, vid)
        assert row is not None and '"id"' in row.blob and row.view_rev == 0
    finally:
        gen.close()


def test_hydration_loads_every_view(client: TestClient) -> None:
    """A cold session hydrates ALL of the project's views into
    ``session.views`` — the commit path relies on the dict being complete."""
    from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

    a = create_view(client, "A", {"folders": [{"name": "FA"}]})
    b = create_view(client, "B", {"folders": [{"name": "FB"}]})
    get_registry().evict(DEFAULT_PROJECT_ID)
    session = get_registry().get(DEFAULT_PROJECT_ID)
    assert {vid: v.folders[0].name for vid, v in session.views.items()} == {
        a: "FA",
        b: "FB",
    }
    assert [v["name"] for v in client.get(papi("/views")).json()] == ["A", "B"]


def test_view_op_commit_survives_eviction(client: TestClient) -> None:
    """Catches a "wrong blob staged" bug: ``POST /commits``' view-op step 'e' stages the
    resulting view blob on the SAME DB transaction as the
    ``Commit`` row (see its docstring's atomicity note), but nothing else in
    the suite proves that staged blob is what a COLD session actually reads
    back. Commit a view batch, evict the session (dropping the in-memory
    cache entirely — ``get_registry().evict`` mirrors
    ``test_commits_revert.py::test_revert_survives_eviction`` and this
    module's own folder-id-healing harness above), then re-read via
    ``GET /views/{id}`` and assert it matches: hydration reads the durable
    ``ViewRow`` directly (a materialized head, never replayed from the op
    journal — view ops are explicitly SKIPPED on model replay), so this path
    is the one thing that would catch a commit that staged the wrong blob."""
    from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

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
    token = r.json()["token"]
    base = client.get(papi("/open")).json()["model_rev"]
    r = client.post(
        papi("/commits"),
        json={
            "base_rev": base,
            "ops": [{"kind": "rename_folder", "view_id": vid, "id": fid, "name": "A2"}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    expected_view_rev = r.json()["view_revs"][vid]

    before = client.get(papi(f"/views/{vid}")).json()
    assert before["view"]["folders"][0]["name"] == "A2"

    get_registry().evict(DEFAULT_PROJECT_ID)  # snapshot-then-drop

    after = client.get(papi(f"/views/{vid}")).json()  # re-hydrate from the durable row
    assert after == before
    assert after["view"]["folders"][0]["name"] == "A2"
    assert after["view_rev"] == expected_view_rev


def test_hydrate_replay_ignores_id_hint_in_restore_mode() -> None:
    """Canonical journal ops carry the final id as temp_id; a stray `id` key
    is ignored by restore-mode replay."""
    sess = _seed_baseline()
    create = {
        "kind": "create_element",
        "temp_id": "e1",
        "id": "ignored",
        "type_name": _first_concrete_element_type(sess),
        "properties": {},
    }
    with db.db_session() as s:
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[create], inverse_ops=[], id_map={},
        )
        content.set_model_rev(s, "p1", 1)
    h = hydration.hydrate_session("p1")
    assert h.model is not None
    assert "e1" in h.model.elements and "ignored" not in h.model.elements


def test_hydrate_builds_the_search_index() -> None:
    """Hydration rebuilds from a snapshot (search index reset) and must kick
    the builder; under the conftest's sync pin the index is complete by the
    time the session is returned."""
    from data_rover.core.model.element import Element

    sess = _seed_baseline()
    assert sess.model is not None
    sess.model.elements["x1"] = Element(
        id="x1", type_name=_first_concrete_element_type(sess), properties={"name": "turbine"}
    )
    sess.model.indexes.rebuild()
    hydration.persist_baseline("p1", sess, author_id=None)
    h = hydration.hydrate_session("p1")
    assert h.model is not None
    assert h.search_index_build is not None and h.search_index_build.running is False
    assert h.model.indexes.search_ready is True
    assert h.model.indexes.search_candidates("turbine") == {"x1"}


def test_snapshot_blob_is_gzip_under_the_gz_key() -> None:
    _seed_baseline()
    key = snapshot_key("p1", 0)
    assert key.endswith(".json.gz")
    blob = get_snapshot_store().get(key)
    assert blob[:2] == b"\x1f\x8b"
    assert gzip.decompress(blob) == b'{"elements":[],"relationships":[]}'
    with db.db_session() as s:
        snap = content.latest_snapshot(s, "p1")
        assert snap is not None and snap.key == key


def test_persist_then_hydrate_roundtrip_nonempty_model() -> None:
    from data_rover.core.model.element import Element

    sess = _seed_baseline()
    assert sess.model is not None
    et = _first_concrete_element_type(sess)
    for i in range(3):
        sess.model.elements[f"x{i}"] = Element(
            id=f"x{i}", type_name=et, properties={"name": f"türbine {i}", "n": i}
        )
    sess.model.indexes.rebuild()
    hydration.persist_baseline("p1", sess, author_id=None)
    h = hydration.hydrate_session("p1")
    assert h.model is not None
    assert sorted(h.model.elements) == ["x0", "x1", "x2"]
    assert h.model.elements["x2"].properties == {"name": "türbine 2", "n": 2}


def test_hydrate_loads_a_legacy_plain_json_snapshot_row() -> None:
    """A row written before compression: indented JSON under a ``.json`` key.
    Neither the key nor the bytes are migrated — the reader sniffs."""
    mm = load_metamodel_str(MM_YAML)
    et = next(t.name for t in mm.elements if not t.abstract)
    legacy_key = "projects/p1/snapshots/0.json"
    doc = {
        "elements": [{"id": "old1", "type_name": et, "properties": {"name": "v"}, "rev": 0}],
        "relationships": [],
    }
    get_snapshot_store().put(
        legacy_key, [json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8")]
    )
    with db.db_session() as s:
        mmrow = content.create_metamodel(s, name="smart-city", version=1, blob=MM_YAML)
        content.upsert_model_row(s, "p1", metamodel_id=mmrow.id)
        content.record_snapshot(s, "p1", rev=0, key=legacy_key)
    h = hydration.hydrate_session("p1")
    assert h.model is not None
    assert h.model.elements["old1"].properties == {"name": "v"}
    assert h.model.indexes.search_ready is True  # sync pin: index built after load


def test_reconstruct_model_at_reads_the_compressed_snapshot() -> None:
    from data_rover.core.model.element import Element

    sess = _seed_baseline()
    assert sess.model is not None
    et = _first_concrete_element_type(sess)
    sess.model.elements["base"] = Element(id="base", type_name=et, properties={})
    sess.model.indexes.rebuild()
    hydration.persist_baseline("p1", sess, author_id=None)
    create = {"kind": "create_element", "temp_id": "e1", "type_name": et, "properties": {}}
    with db.db_session() as s:
        content.append_commit(
            s, "p1", rev=1, commit_id="c1", author_id=None,
            ops=[create], inverse_ops=[], id_map={},
        )
        content.set_model_rev(s, "p1", 1)
    at0 = hydration.reconstruct_model_at("p1", 0)
    at1 = hydration.reconstruct_model_at("p1", 1)
    assert at0 is not None and sorted(at0.elements) == ["base"]
    assert at1 is not None and sorted(at1.elements) == ["base", "e1"]
    assert at1.indexes.search_ready is False  # transient model: no search index
