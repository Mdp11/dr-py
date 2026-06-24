from __future__ import annotations

import json

from data_rover.api import content, db
from data_rover.api.db_models import MetamodelRow, ModelRow, Project
from data_rover.api.storage import (
    MemorySnapshotStore,
    get_snapshot_store,
    set_snapshot_store,
    snapshot_key,
)


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
