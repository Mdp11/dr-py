from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.deps import _repo_for
from data_rover.api.main import create_app
from data_rover.api.settings import Settings, get_settings

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: Settings(data_dir=tmp_path)
    _repo_for.cache_clear()
    return TestClient(app)


def test_healthz(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_full_lifecycle(client: TestClient, tmp_path: Path) -> None:
    yaml_text = EXAMPLE.read_text(encoding="utf-8")
    res = client.put(
        "/api/v1/metamodels/example",
        content=yaml_text,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    assert (tmp_path / "example.metamodel.yaml").exists()

    res = client.get("/api/v1/metamodels")
    assert res.status_code == 200
    assert res.json() == ["example"]

    res = client.get("/api/v1/metamodels/example")
    assert res.status_code == 200
    assert {e["name"] for e in res.json()["elements"]} == {
        "NamedElement",
        "Requirement",
        "Block",
    }

    res = client.post(
        "/api/v1/models",
        json={"name": "demo", "metamodel": "example"},
    )
    assert res.status_code == 201, res.text
    assert (tmp_path / "demo.model.json").exists()
    assert (tmp_path / "_models.json").exists()

    res = client.post(
        "/api/v1/models/demo/elements",
        json={
            "type": "Block",
            "properties": {"name": "Wing", "mass": 12.5},
        },
    )
    assert res.status_code == 201, res.text
    block = res.json()
    assert block["type_name"] == "Block"
    assert block["properties"] == {"name": "Wing", "mass": 12.5}

    res = client.post(
        "/api/v1/models/demo/elements",
        json={
            "type": "Requirement",
            "properties": {"name": "REQ-1", "status": "Draft", "priority": 3},
        },
    )
    assert res.status_code == 201, res.text
    req = res.json()

    res = client.post(
        "/api/v1/models/demo/relationships",
        json={"type": "Satisfies", "source_id": block["id"], "target_id": req["id"]},
    )
    assert res.status_code == 201, res.text
    rel = res.json()
    assert rel["type_name"] == "Satisfies"

    res = client.patch(
        f"/api/v1/models/demo/elements/{block['id']}",
        json={"properties": {"mass": 13.0}},
    )
    assert res.status_code == 200
    assert res.json()["properties"]["mass"] == 13.0

    res = client.get("/api/v1/models/demo")
    assert res.status_code == 200
    snapshot = res.json()
    assert len(snapshot["elements"]) == 2
    assert len(snapshot["relationships"]) == 1

    res = client.get("/api/v1/models/demo/elements", params={"type": "Block"})
    assert res.status_code == 200
    assert len(res.json()) == 1

    res = client.post("/api/v1/models/demo/validate")
    assert res.status_code == 200
    assert res.json() == []

    res = client.delete(f"/api/v1/models/demo/relationships/{rel['id']}")
    assert res.status_code == 204

    res = client.delete(f"/api/v1/models/demo/elements/{block['id']}")
    assert res.status_code == 204

    res = client.get("/api/v1/models/demo")
    assert res.status_code == 200
    assert len(res.json()["elements"]) == 1
    assert res.json()["relationships"] == []


def test_404_on_missing_model(client: TestClient) -> None:
    res = client.get("/api/v1/models/nope")
    assert res.status_code == 404


def test_422_on_bad_metamodel(client: TestClient) -> None:
    res = client.put(
        "/api/v1/metamodels/bad",
        content="elements: [{name: A, extends: B}]",
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 422


def test_delete_metamodel_with_bound_model_fails(client: TestClient) -> None:
    yaml_text = EXAMPLE.read_text(encoding="utf-8")
    client.put(
        "/api/v1/metamodels/example",
        content=yaml_text,
        headers={"content-type": "application/x-yaml"},
    )
    client.post("/api/v1/models", json={"name": "demo", "metamodel": "example"})
    res = client.delete("/api/v1/metamodels/example")
    assert res.status_code == 422
