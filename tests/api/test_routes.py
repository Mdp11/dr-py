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


def _seed_example_model(client: TestClient) -> dict:
    """Create the example metamodel + a 'demo' model with one Block and one
    Requirement and a Satisfies relationship between them. Returns the GET
    snapshot of the model.
    """
    yaml_text = EXAMPLE.read_text(encoding="utf-8")
    resp = client.put(
        "/api/v1/metamodels/example",
        content=yaml_text,
        headers={"content-type": "application/x-yaml"},
    )
    assert resp.status_code == 200, resp.text
    resp = client.post(
        "/api/v1/models", json={"name": "demo", "metamodel": "example"}
    )
    assert resp.status_code == 201, resp.text
    resp = client.post(
        "/api/v1/models/demo/elements",
        json={"type": "Block", "properties": {"name": "Wing", "mass": 12.5}},
    )
    assert resp.status_code == 201, resp.text
    block = resp.json()
    resp = client.post(
        "/api/v1/models/demo/elements",
        json={
            "type": "Requirement",
            "properties": {"name": "REQ-1", "status": "Draft", "priority": 3},
        },
    )
    assert resp.status_code == 201, resp.text
    req = resp.json()
    resp = client.post(
        "/api/v1/models/demo/relationships",
        json={"type": "Satisfies", "source_id": block["id"], "target_id": req["id"]},
    )
    assert resp.status_code == 201, resp.text
    resp = client.get("/api/v1/models/demo")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_snapshot_round_trip(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    rev = snapshot["rev"]
    assert rev >= 1
    elements = list(snapshot["elements"])
    relationships = list(snapshot["relationships"])

    # Modify a property on the Block.
    block = next(e for e in elements if e["type_name"] == "Block")
    block["properties"]["mass"] = 21.0

    # Add a new Requirement element + a new Satisfies relationship.
    new_req = {
        "id": "req-new",
        "type_name": "Requirement",
        "properties": {"name": "REQ-2", "status": "Draft", "priority": 2},
        "rev": 0,
    }
    elements.append(new_req)
    new_rel = {
        "id": "rel-new",
        "type_name": "Satisfies",
        "source_id": block["id"],
        "target_id": "req-new",
        "properties": {},
        "rev": 0,
    }
    relationships.append(new_rel)

    res = client.put(
        "/api/v1/models/demo/snapshot",
        json={"rev": rev, "elements": elements, "relationships": relationships},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["rev"] == rev + 1

    fetched = client.get("/api/v1/models/demo").json()
    assert fetched["rev"] == rev + 1
    assert len(fetched["elements"]) == 3
    assert len(fetched["relationships"]) == 2
    fetched_block = next(e for e in fetched["elements"] if e["id"] == block["id"])
    assert fetched_block["properties"]["mass"] == 21.0
    assert any(e["id"] == "req-new" for e in fetched["elements"])
    assert any(r["id"] == "rel-new" for r in fetched["relationships"])


def test_snapshot_conflict(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    stale_rev = snapshot["rev"] - 1
    res = client.put(
        "/api/v1/models/demo/snapshot",
        json={
            "rev": stale_rev,
            "elements": snapshot["elements"],
            "relationships": snapshot["relationships"],
        },
    )
    assert res.status_code == 409, res.text
    body = res.json()
    assert "error" in body
    message = body["error"].lower()
    # Stable words from `ConflictError` text -- guards against accidental
    # rewording that still happens to contain "rev".
    assert any(token in message for token in ("stale write", "expected", "current"))


def test_snapshot_rejects_unknown_type(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    bad_elements = list(snapshot["elements"]) + [
        {
            "id": "bogus",
            "type_name": "NotAType",
            "properties": {},
            "rev": 0,
        }
    ]
    res = client.put(
        "/api/v1/models/demo/snapshot",
        json={
            "rev": snapshot["rev"],
            "elements": bad_elements,
            "relationships": snapshot["relationships"],
        },
    )
    assert res.status_code == 422, res.text


def test_snapshot_rejects_abstract_type(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    bad_elements = list(snapshot["elements"]) + [
        {
            "id": "abstract-instance",
            "type_name": "NamedElement",  # abstract in example metamodel
            "properties": {"name": "nope"},
            "rev": 0,
        }
    ]
    res = client.put(
        "/api/v1/models/demo/snapshot",
        json={
            "rev": snapshot["rev"],
            "elements": bad_elements,
            "relationships": snapshot["relationships"],
        },
    )
    assert res.status_code == 422, res.text
    assert "abstract" in res.json()["detail"].lower()


def test_snapshot_rejects_duplicate_element_id(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    elements = list(snapshot["elements"])
    # Duplicate the first element's id onto a fresh Block payload.
    dup_id = elements[0]["id"]
    elements.append(
        {
            "id": dup_id,
            "type_name": "Block",
            "properties": {"name": "Other", "mass": 1.0},
            "rev": 0,
        }
    )
    res = client.put(
        "/api/v1/models/demo/snapshot",
        json={
            "rev": snapshot["rev"],
            "elements": elements,
            "relationships": snapshot["relationships"],
        },
    )
    assert res.status_code == 422, res.text
    assert "duplicate" in res.json()["detail"].lower()


def test_validate_inline_rejects_abstract_type(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    inline_elements = list(snapshot["elements"]) + [
        {
            "id": "abstract-instance",
            "type_name": "NamedElement",
            "properties": {"name": "nope"},
            "rev": 0,
        }
    ]
    res = client.post(
        "/api/v1/models/demo/validate",
        json={
            "inline": {
                "elements": inline_elements,
                "relationships": snapshot["relationships"],
            }
        },
    )
    assert res.status_code == 422, res.text
    assert "abstract" in res.json()["detail"].lower()


def test_validate_inline(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    # Use an inline body where priority is out of range (1..5).
    inline_elements = []
    for e in snapshot["elements"]:
        clone = {**e, "properties": dict(e["properties"])}
        if clone["type_name"] == "Requirement":
            clone["properties"]["priority"] = 99
        inline_elements.append(clone)

    res = client.post(
        "/api/v1/models/demo/validate",
        json={
            "inline": {
                "elements": inline_elements,
                "relationships": snapshot["relationships"],
            }
        },
    )
    assert res.status_code == 200, res.text
    issues = res.json()
    assert any(
        "priority" in i["message"] and "above max" in i["message"] for i in issues
    ), issues

    # Stored model should be untouched: validating it produces no issues.
    res = client.post("/api/v1/models/demo/validate")
    assert res.status_code == 200
    assert res.json() == []


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
