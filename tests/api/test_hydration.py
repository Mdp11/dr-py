from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db, hydration
from data_rover.api.db_models import Project
from data_rover.api.main import create_app
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store
from data_rover.api.session import Session
from data_rover.core.metamodel.loader import load_metamodel_str

from .conftest import AUTH_HEADERS, create_folder_via_commit, papi, seed_default_project

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
        content.upsert_single_view(
            s,
            DEFAULT_PROJECT_ID,
            name="v",
            blob='{"name": "v", "folders": [{"name": "A"}], "artifacts": []}',
            bump_rev=False,
        )
        s.commit()
    finally:
        gen.close()

    get_registry().evict(DEFAULT_PROJECT_ID)
    r = client.get(papi("/view"))
    assert r.status_code == 200
    assert len(r.json()["view"]["folders"][0]["id"]) == 32
    assert r.json()["view_rev"] == 0

    gen = db.get_db()
    s = next(gen)
    try:
        row = content.get_single_view(s, DEFAULT_PROJECT_ID)
        assert row is not None and '"id"' in row.blob and row.view_rev == 0
    finally:
        gen.close()


def test_view_op_commit_survives_eviction(client: TestClient) -> None:
    """Regression for final-review Fix 4c: this is the test that would catch
    a "wrong blob staged" bug. ``POST /commits``' view-op step 'e' stages the
    resulting ``session.view`` blob on the SAME DB transaction as the
    ``Commit`` row (see its docstring's atomicity note), but nothing else in
    the suite proves that staged blob is what a COLD session actually reads
    back. Commit a view batch, evict the session (dropping the in-memory
    cache entirely — ``get_registry().evict`` mirrors
    ``test_commits_revert.py::test_revert_survives_eviction`` and this
    module's own folder-id-healing harness above), then re-read via
    ``GET /view`` and assert it matches: hydration reads the durable
    ``ViewRow`` directly (a materialized head, never replayed from the op
    journal — view ops are explicitly SKIPPED on model replay), so this path
    is the one thing that would catch a commit that staged the wrong blob."""
    from data_rover.api.session import DEFAULT_PROJECT_ID, get_registry

    setup = create_folder_via_commit(client, "A")
    fid = setup["id_map"]["tmp_setup"]

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
            "ops": [{"kind": "rename_folder", "id": fid, "name": "A2"}],
            "message": "m",
            "lock_tokens": [token],
        },
    )
    assert r.status_code == 200, r.text
    expected_view_rev = r.json()["view_rev"]

    before = client.get(papi("/view")).json()
    assert before["view"]["folders"][0]["name"] == "A2"

    get_registry().evict(DEFAULT_PROJECT_ID)  # snapshot-then-drop

    after = client.get(papi("/view")).json()  # re-hydrate from the durable row
    assert after == before
    assert after["view"]["folders"][0]["name"] == "A2"
    assert after["view_rev"] == expected_view_rev
