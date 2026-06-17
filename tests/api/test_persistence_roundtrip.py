from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_registry
from tests.api.conftest import AUTH_HEADERS, papi, seed_default_project

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def test_upload_survives_eviction_via_hydration() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    before = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()

    get_registry().evict("default")  # snapshot-then-drop

    after = c.get(papi("/model/summary"), headers=AUTH_HEADERS).json()  # re-hydrates
    assert after["element_count"] == before["element_count"]
    assert after["relationship_count"] == before["relationship_count"]
    assert after["model_rev"] == before["model_rev"]


def test_view_persists_across_eviction() -> None:
    seed_default_project()
    c = TestClient(create_app())
    c.post(papi("/metamodel"), content=MM, headers=AUTH_HEADERS)
    c.post(papi("/model/upload"), content=MODEL.encode(), headers=AUTH_HEADERS)
    c.put(papi("/view/snapshot"),
          json={"name": "My View", "folders": []}, headers=AUTH_HEADERS)

    get_registry().evict("default")

    v = c.get(papi("/view"), headers=AUTH_HEADERS).json()
    assert v["view"]["name"] == "My View"
