from __future__ import annotations

from data_rover.api import db
from data_rover.api.db_models import Project
from data_rover.api.main import create_app
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store


def test_dev_seed_creates_schema_without_seeding_a_project(monkeypatch) -> None:
    """dev_seed on SQLite creates the tenancy+content schema but seeds NO
    default project and NO users. The single admin is provisioned only by
    _ensure_bootstrap_admin; projects are created via the wizard / importer."""
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", "sqlite://")
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "true")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_STORE", "memory")
    monkeypatch.setenv("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
    db.init_engine("sqlite://", force=True)
    set_snapshot_store(MemorySnapshotStore())
    try:
        create_app()  # builds the app + runs dev-seed
        gen = db.get_db()
        s = next(gen)
        try:
            # schema exists (the query does not raise) and no default project
            assert s.get(Project, "default") is None
        finally:
            gen.close()
    finally:
        set_snapshot_store(None)
