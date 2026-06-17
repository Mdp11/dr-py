from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api import main
from data_rover.api.main import create_app
from data_rover.api.session import get_registry
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def test_idle_sweep_evicts_and_snapshots_stale_sessions() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    assert "default" in get_registry().project_ids()

    # sweep far in the future -> session is stale -> evicted (snapshot taken)
    evicted = main._idle_sweep_once(now=time.monotonic() + 10_000, ttl=1.0)
    assert "default" in evicted
    assert "default" not in get_registry().project_ids()

    # data survives: next request re-hydrates from the snapshot
    s = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()
    assert s["element_count"] > 0


def test_idle_sweep_keeps_fresh_sessions() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    assert main._idle_sweep_once(now=time.monotonic(), ttl=10_000.0) == []
