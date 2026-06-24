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


# ---------------------------------------------------------------------------
# Task 4 — strict-mode enforcement in the commit handler
# ---------------------------------------------------------------------------


def test_strict_mode_blocks_conformance_commit(client) -> None:
    _make_owner_with_model(client)
    # sanity: without strict mode the SAME batch is allowed (counted, not blocked)
    ok = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": VIOLATING_OPS, "message": "soft", "lock_tokens": [],
    })
    assert ok.status_code == 200, ok.text  # default (non-strict) path

    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    rev_before = _rev(client)
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": rev_before, "ops": VIOLATING_OPS, "message": "x", "lock_tokens": [],
    })
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "strict-mode conformance blocker"
    assert len(r.json()["conformance_blockers"]) >= 1
    assert _rev(client) == rev_before  # rolled back, no rev bump


def test_strict_mode_allows_clean_commit(client) -> None:
    _make_owner_with_model(client)
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": CLEAN_OPS, "message": "ok", "lock_tokens": [],
    })
    assert r.status_code == 200, r.text


# rebind target: renames Node -> Widget so the existing element no longer conforms
_MM_RENAMED = """
elements:
  - name: Widget
relationships:
  - name: Contains
    containment: true
    source: Widget
    target: Widget
"""


def test_open_reports_strict_mode(client) -> None:
    _make_owner_with_model(client)
    assert client.get(papi("/open"), headers=AUTH_HEADERS).json()["strict_mode"] is False
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    assert client.get(papi("/open"), headers=AUTH_HEADERS).json()["strict_mode"] is True


def test_preview_reports_would_block(client) -> None:
    _make_owner_with_model(client)
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    r = client.post(papi("/commits/preview"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": VIOLATING_OPS,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["conformance_error_count"] >= 1
    assert body["would_block"] is True


def test_rebind_exempt_from_strict_mode(client) -> None:
    _make_owner_with_model(client)
    # land an element so the rename produces a conformance issue post-rebind
    client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": CLEAN_OPS, "message": "n", "lock_tokens": [],
    })
    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})
    before = _rev(client)
    r = client.post(
        papi("/metamodel/rebind") + f"?base_rev={before}&message=swap",
        content=_MM_RENAMED, headers={"content-type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text  # rebind exempt even under strict mode
    assert r.json()["validation_error_count"] >= 1


def test_strict_mode_ignores_preexisting_issues_outside_dirty_set(client) -> None:
    # Land a non-conforming element AND a valid element while NON-strict,
    # then turn strict on and update the valid element. The update's dirty set
    # contains only the valid element (and its uniqueness group, which does NOT
    # include the violating element — different property values).
    # Scoped enforcement => the second commit succeeds even though the model
    # still holds the first element's issue.
    _make_owner_with_model(client)
    client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": VIOLATING_OPS, "message": "soft", "lock_tokens": [],
    })
    valid_r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client), "ops": CLEAN_OPS, "message": "valid-create", "lock_tokens": [],
    })
    valid_id = valid_r.json()["id_map"]["tmp_ok"]

    client.patch(papi("/settings"), headers=AUTH_HEADERS, json={"strict_mode": True})

    # Acquire an exclusive lock on the valid element before committing the update.
    lock_r = client.post(papi("/locks"), headers=AUTH_HEADERS, json={
        "targets": [{"resource_id": valid_id, "mode": "exclusive"}],
        "intent": "edit",
    })
    assert lock_r.status_code == 200, lock_r.text
    lock_token = lock_r.json()["token"]

    # update_element: dirty set = the valid element + its uniqueness group.
    # The violating element (no name) is in a different group → stays outside scope.
    r = client.post(papi("/commits"), headers=AUTH_HEADERS, json={
        "base_rev": _rev(client),
        "ops": [{"kind": "update_element", "id": valid_id, "properties_patch": {"name": "renamed"}}],
        "message": "update-valid",
        "lock_tokens": [lock_token],
    })
    assert r.status_code == 200, r.text  # pre-existing violating element is outside dirty set
