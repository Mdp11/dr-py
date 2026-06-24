from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api import content, db
from data_rover.api.db_models import MetamodelRow, ModelRow, Project
from data_rover.api.main import create_app
from data_rover.api.storage import (
    MemorySnapshotStore,
    get_snapshot_store,
    set_snapshot_store,
    snapshot_key,
)

from .conftest import AUTH_HEADERS, papi, seed_default_project


#: a minimal but VALID metamodel blob — Task 2's hydration test re-parses it
#: via load_metamodel_str, so it must be loadable (not just any string).
_MM_BLOB = "elements:\n  - name: Node\n"


def _seed_model_row(s) -> None:
    s.add(Project(id="p1", name="P1"))
    s.add(MetamodelRow(id="mm1", name="mm", version=1, blob=_MM_BLOB))
    s.add(ModelRow(id="m1", project_id="p1", metamodel_id="mm1", name="model"))
    s.commit()


def test_strict_mode_defaults_false_and_roundtrips() -> None:
    db.init_engine("sqlite://")
    db.create_all()
    gen = db.get_db()
    s = next(gen)
    try:
        _seed_model_row(s)
        assert content.get_strict_mode(s, "p1") is False  # NULL policy
        content.set_strict_mode(s, "p1", True)
        assert content.get_strict_mode(s, "p1") is True
        content.set_strict_mode(s, "p1", False)
        assert content.get_strict_mode(s, "p1") is False
        assert content.get_strict_mode(s, "missing") is False  # no row
    finally:
        gen.close()
        db.drop_all()


def test_hydrate_session_loads_strict_mode() -> None:
    from data_rover.api import hydration

    db.init_engine("sqlite://")
    db.create_all()
    set_snapshot_store(MemorySnapshotStore())
    gen = db.get_db()
    s = next(gen)
    try:
        _seed_model_row(s)
        # a baseline snapshot so hydration has a model to load
        key = snapshot_key("p1", 0)
        get_snapshot_store().put(
            key,
            [json.dumps({"elements": [], "relationships": []}).encode()],
        )
        content.record_snapshot(s, "p1", rev=0, key=key)
        content.set_strict_mode(s, "p1", True)
        s.commit()
    finally:
        gen.close()

    try:
        session = hydration.hydrate_session("p1")
        assert session.strict_mode is True
    finally:
        set_snapshot_store(None)
        db.drop_all()


# ---------------------------------------------------------------------------
# Task 3 — HTTP route tests
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c

# Strict-mode tests need ops that DO and DON'T conform. A required `name`
# property (multiplicity "1") makes "create a Node with no name" a CONFORMANCE
# (multiplicity) violation — and crucially NOT a structural one. Mirror the
# upload shape of tests/api/test_commits_route.py's `client` fixture.
_MM_STRICT = """
elements:
  - name: Node
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
"""

# create_element ops (free-floating creates need NO lock, so lock_tokens=[]).
VIOLATING_OPS = [
    {"kind": "create_element", "temp_id": "tmp_bad", "type_name": "Node", "properties": {}}
]
CLEAN_OPS = [
    {"kind": "create_element", "temp_id": "tmp_ok", "type_name": "Node",
     "properties": {"name": "ok"}}
]


def _make_owner_with_model(client) -> None:
    """Upload the strict metamodel + an empty model (creates the ModelRow).
    The conftest `client` is already an owner of the default project."""
    r = client.post(
        papi("/metamodel"), content=_MM_STRICT,
        headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    r = client.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text


def _rev(client) -> int:
    return client.get(papi("/model/summary"), headers=AUTH_HEADERS).json()["model_rev"]


def test_settings_get_defaults_false(client) -> None:
    _make_owner_with_model(client)
    r = client.get(papi("/settings"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.json() == {"strict_mode": False}


def test_viewer_can_read_settings(client) -> None:
    _make_owner_with_model(client)
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="vw", email="vw@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "vw", Role.viewer)
        s.commit()
    finally:
        gen.close()
    vw = {"x-user-id": "vw", "x-user-email": "vw@example.com"}
    r = client.get(papi("/settings"), headers=vw)
    assert r.status_code == 200
    assert r.json() == {"strict_mode": False}


def test_owner_can_enable_strict_mode(client) -> None:
    _make_owner_with_model(client)
    r = client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    assert r.status_code == 200
    assert r.json() == {"strict_mode": True}
    assert client.get(papi("/settings"), headers=AUTH_HEADERS).json()["strict_mode"] is True


def test_editor_cannot_toggle_strict_mode(client) -> None:
    _make_owner_with_model(client)
    from data_rover.api import db
    from data_rover.api.db_models import Role, User
    from data_rover.api.session import DEFAULT_PROJECT_ID
    from data_rover.api.tenancy import add_member

    gen = db.get_db()
    s = next(gen)
    try:
        s.add(User(id="ed", email="ed@example.com"))
        add_member(s, DEFAULT_PROJECT_ID, "ed", Role.editor)
        s.commit()
    finally:
        gen.close()
    ed = {"x-user-id": "ed", "x-user-email": "ed@example.com"}
    r = client.patch(papi("/settings"), headers=ed, json={"strict_mode": True})
    assert r.status_code == 403
