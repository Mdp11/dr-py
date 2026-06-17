from __future__ import annotations

import os

from fastapi.testclient import TestClient

from data_rover.api import db
from data_rover.api.main import create_app
from data_rover.api.storage import MemorySnapshotStore, set_snapshot_store


def test_dev_seed_imports_smart_city_example(monkeypatch) -> None:
    monkeypatch.setenv("DATA_ROVER_DATABASE_URL", "sqlite://")
    monkeypatch.setenv("DATA_ROVER_DEV_SEED", "true")
    monkeypatch.setenv("DATA_ROVER_SNAPSHOT_STORE", "memory")
    monkeypatch.setenv("DATA_ROVER_IDLE_EVICT_SECONDS", "0")
    db.init_engine("sqlite://", force=True)
    set_snapshot_store(MemorySnapshotStore())
    try:
        c = TestClient(create_app())
        headers = {"x-user-id": "default-user", "x-user-email": "dev@example.com"}
        s = c.get("/api/v1/projects/default/model/summary", headers=headers).json()
        assert s["element_count"] > 0  # the example model is loaded
    finally:
        set_snapshot_store(None)
