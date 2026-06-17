from __future__ import annotations

from pathlib import Path

from data_rover.api import content, db, hydration, importer
from data_rover.api.db_models import Project, User
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")
VIEW = Path("examples/smart-city.view.json").read_text(encoding="utf-8")


def _env():
    db.init_engine("sqlite://", force=True)
    db.create_all()
    set_snapshot_store(MemorySnapshotStore())


def test_import_creates_project_baseline_and_hydrates() -> None:
    _env()
    try:
        importer.import_project(
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL, view_json=VIEW,
        )
        with db.db_session() as s:
            assert s.get(Project, "proj") is not None
            assert s.get(User, "u1") is not None
            assert content.get_model_row(s, "proj").model_rev == 0
            assert content.latest_snapshot(s, "proj").rev == 0
        sess = hydration.hydrate_session("proj")
        assert sess.model is not None and len(sess.model.elements) > 0
        assert sess.view is not None
    finally:
        set_snapshot_store(None)


def test_import_is_idempotent_noop_when_project_exists() -> None:
    _env()
    try:
        importer.import_project(
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL,
        )
        importer.import_project(  # second call must not raise or duplicate
            project_id="proj", name="Smart City", owner_id="u1",
            metamodel_yaml=MM, model_json=MODEL,
        )
        with db.db_session() as s:
            assert content.get_model_row(s, "proj").model_rev == 0
    finally:
        set_snapshot_store(None)
