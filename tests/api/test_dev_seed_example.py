from __future__ import annotations

import json

from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.main import create_app
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store

OWNER = {"x-user-id": "default-user", "x-user-email": "dev@example.com"}


def _seed_app(monkeypatch) -> TestClient:
    """Build a dev-seeded app on in-memory SQLite + memory snapshots."""
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", "sqlite://")
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "true")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_STORE", "memory")
    monkeypatch.setenv("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
    db.init_engine("sqlite://", force=True)
    set_snapshot_store(MemorySnapshotStore())
    return TestClient(create_app())


def test_dev_seed_imports_smart_city_example(monkeypatch) -> None:
    try:
        c = _seed_app(monkeypatch)
        s = c.get("/api/v1/projects/default/model/summary", headers=OWNER).json()
        assert s["element_count"] > 0  # the example model is loaded
    finally:
        set_snapshot_store(None)


def test_dev_seed_uses_configured_seed_paths(monkeypatch) -> None:
    # Explicit env paths (relative to the repo root) are honoured, not just the
    # bundled fallback.
    monkeypatch.setenv(
        "DATA_ROVER_SEED_METAMODEL", "examples/smart-city.metamodel.yaml"
    )
    monkeypatch.setenv("DATA_ROVER_SEED_MODEL", "examples/smart-city.model.json")
    monkeypatch.setenv("DATA_ROVER_SEED_VIEW", "examples/smart-city.view.json")
    try:
        c = _seed_app(monkeypatch)
        s = c.get("/api/v1/projects/default/model/summary", headers=OWNER).json()
        assert s["element_count"] > 0
    finally:
        set_snapshot_store(None)


def test_dev_seed_provisions_users_from_file(monkeypatch, tmp_path) -> None:
    users_file = tmp_path / "dev-users.json"
    users_file.write_text(
        json.dumps(
            {
                "users": [
                    {"id": "alice", "email": "alice@example.com", "role": "editor"},
                    {"id": "bob", "role": "viewer"},  # email defaulted
                ]
            }
        )
    )
    monkeypatch.setenv("DATA_ROVER_DEV_USERS_FILE", str(users_file))
    try:
        c = _seed_app(monkeypatch)
        members = {
            m["user_id"]: m
            for m in c.get("/api/v1/projects/default/members", headers=OWNER).json()
        }
        assert members["alice"]["role"] == "editor"
        assert members["bob"]["role"] == "viewer"
        assert members["bob"]["email"] == "bob@example.com"  # defaulted
        # the provisioned users can actually open the project with their role
        for uid, role in (("alice", "editor"), ("bob", "viewer")):
            r = c.get(
                "/api/v1/projects/default/open", headers={"x-user-id": uid}
            ).json()
            assert r["role"] == role
    finally:
        set_snapshot_store(None)
