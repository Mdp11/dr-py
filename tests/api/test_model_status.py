"""GET /model/status: non-hydrating open/validation progress (spec §3/§4)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_registry, get_session
from data_rover.api.validation_sweep import SweepProgress

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    properties:
      - {name: name, datatype: string}
"""


def _client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def test_status_unknown_project_404() -> None:
    c = _client()
    assert c.get("/api/v1/projects/nope/model/status").status_code == 404


def test_status_empty_then_ready() -> None:
    c = _client()
    # a contentless project hydrates to an empty session on first data touch;
    # status itself must NOT hydrate: before any touch the project is cold
    assert c.get(f"{API}/model/status").json()["state"] == "cold"
    assert get_registry().peek("default") is None  # peek did not hydrate
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200
    assert c.get(f"{API}/model/status").json()["state"] == "empty"
    res = c.post(
        f"{API}/model/upload",
        json={"elements": [{"id": "e1", "type_name": "Item", "properties": {}}], "relationships": []},
    )
    assert res.status_code == 200
    body = c.get(f"{API}/model/status").json()
    # conftest pins the sweep sync, so the model is ready immediately
    assert body["state"] == "ready"
    assert body["model_rev"] == get_session().model_rev


def test_status_reports_running_sweep() -> None:
    c = _client()
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200
    res = c.post(
        f"{API}/model/upload",
        json={"elements": [{"id": "e1", "type_name": "Item", "properties": {}}], "relationships": []},
    )
    assert res.status_code == 200
    session = get_session()
    session.validation_sweep = SweepProgress(total=10, done=4, running=True)
    body = c.get(f"{API}/model/status").json()
    assert body["state"] == "validating"
    assert body["validation"] == {"running": True, "done": 4, "total": 10}
