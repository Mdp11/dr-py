from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api import main
from data_rover.api.main import create_app
from data_rover.api.session import get_registry
from tests.api.conftest import (
    seed_default_project,
    install,
    head,
)

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def test_idle_sweep_evicts_and_snapshots_stale_sessions() -> None:
    seed_default_project()
    c = TestClient(create_app())
    install(metamodel=MM, model=MODEL)
    assert "default" in get_registry().project_ids()

    # sweep far in the future -> session is stale -> evicted (snapshot taken)
    evicted = main._idle_sweep_once(now=time.monotonic() + 10_000, ttl=1.0)
    assert "default" in evicted
    assert "default" not in get_registry().project_ids()

    # data survives: next request re-hydrates from the snapshot
    assert len(head().elements) > 0


def test_idle_sweep_keeps_fresh_sessions() -> None:
    seed_default_project()
    c = TestClient(create_app())
    install(metamodel=MM, model=MODEL)
    assert main._idle_sweep_once(now=time.monotonic(), ttl=10_000.0) == []
