from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_registry
from tests.api.conftest import (
    AUTH_HEADERS,
    create_folder_via_commit,
    papi,
    seed_default_project,
    install,
    head,
)

MM = Path("examples/smart-city.metamodel.yaml").read_text(encoding="utf-8")
MODEL = Path("examples/smart-city.model.json").read_text(encoding="utf-8")


def test_upload_survives_eviction_via_hydration() -> None:
    seed_default_project()
    c = TestClient(create_app())
    install(metamodel=MM, model=MODEL)
    before = head()

    get_registry().evict("default")  # snapshot-then-drop

    after = head()  # re-hydrates
    assert len(after.elements) == len(before.elements)
    assert len(after.relationships) == len(before.relationships)
    assert after.rev == before.rev


def test_view_persists_across_eviction() -> None:
    seed_default_project()
    c = TestClient(create_app())
    install(metamodel=MM, model=MODEL)
    vid = create_folder_via_commit(c, "My Folder")["view_id"]

    get_registry().evict("default")

    v = c.get(papi(f"/views/{vid}"), headers=AUTH_HEADERS).json()
    assert v["view"]["folders"][0]["name"] == "My Folder"
