from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import reset_session

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"


@pytest.fixture
def client() -> TestClient:
    reset_session()
    app = create_app()
    return TestClient(app)


def test_healthz(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def _upload_example_metamodel(client: TestClient) -> None:
    yaml_text = EXAMPLE.read_text(encoding="utf-8")
    res = client.post(
        "/api/v1/metamodel",
        content=yaml_text,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text


def _empty_model(client: TestClient) -> None:
    res = client.post(
        "/api/v1/model",
        json={"elements": [], "relationships": []},
    )
    assert res.status_code == 200, res.text


MULTI_MAPPING_MM = """
elements:
  - name: Block
  - name: System
  - name: Requirement
  - name: Document
relationships:
  - name: Refers
    mappings:
      - {source: Block, target: Requirement}
      - {source: System, target: Document}
"""


def test_metamodel_multiple_mappings_roundtrip(client: TestClient) -> None:
    res = client.post(
        "/api/v1/metamodel",
        content=MULTI_MAPPING_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text

    res = client.get("/api/v1/metamodel")
    assert res.status_code == 200
    refers = next(r for r in res.json()["relationships"] if r["name"] == "Refers")
    assert [[m["source"], m["target"]] for m in refers["mappings"]] == [
        ["Block", "Requirement"],
        ["System", "Document"],
    ]
    # single-pair shorthand still exposed for backward-compatible consumers
    assert refers["source"] == "Block"
    assert refers["target"] == "Requirement"


def test_full_lifecycle(client: TestClient) -> None:
    _upload_example_metamodel(client)

    res = client.get("/api/v1/metamodel")
    assert res.status_code == 200
    assert {e["name"] for e in res.json()["elements"]} == {
        "NamedElement",
        "Requirement",
        "Block",
    }

    _empty_model(client)

    res = client.post(
        "/api/v1/model/elements",
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
        "/api/v1/model/elements",
        json={
            "type": "Requirement",
            "properties": {"name": "REQ-1", "status": "Draft", "priority": 3},
        },
    )
    assert res.status_code == 201, res.text
    req = res.json()

    res = client.post(
        "/api/v1/model/relationships",
        json={"type": "Satisfies", "source_id": block["id"], "target_id": req["id"]},
    )
    assert res.status_code == 201, res.text
    rel = res.json()
    assert rel["type_name"] == "Satisfies"

    res = client.patch(
        f"/api/v1/model/elements/{block['id']}",
        json={"properties": {"mass": 13.0}},
    )
    assert res.status_code == 200
    assert res.json()["properties"]["mass"] == 13.0

    res = client.get("/api/v1/model")
    assert res.status_code == 200
    snapshot = res.json()
    assert len(snapshot["elements"]) == 2
    assert len(snapshot["relationships"]) == 1

    res = client.get("/api/v1/model/elements", params={"type": "Block"})
    assert res.status_code == 200
    assert len(res.json()) == 1

    res = client.post("/api/v1/model/validate")
    assert res.status_code == 200
    assert res.json() == []

    res = client.delete(f"/api/v1/model/relationships/{rel['id']}")
    assert res.status_code == 204

    res = client.delete(f"/api/v1/model/elements/{block['id']}")
    assert res.status_code == 204

    res = client.get("/api/v1/model")
    assert res.status_code == 200
    assert len(res.json()["elements"]) == 1
    assert res.json()["relationships"] == []


def test_404_when_no_metamodel_loaded(client: TestClient) -> None:
    res = client.get("/api/v1/metamodel")
    assert res.status_code == 404


def test_404_when_no_model_loaded(client: TestClient) -> None:
    _upload_example_metamodel(client)
    res = client.get("/api/v1/model")
    assert res.status_code == 404


def test_upload_model_requires_metamodel(client: TestClient) -> None:
    res = client.post("/api/v1/model", json={"elements": [], "relationships": []})
    assert res.status_code == 404


def test_upload_metamodel_clears_model(client: TestClient) -> None:
    _upload_example_metamodel(client)
    _empty_model(client)
    res = client.post(
        "/api/v1/model/elements",
        json={"type": "Block", "properties": {"name": "X", "mass": 1.0}},
    )
    assert res.status_code == 201
    # Re-upload metamodel; model should be cleared.
    _upload_example_metamodel(client)
    res = client.get("/api/v1/model")
    assert res.status_code == 404


def test_422_on_bad_metamodel(client: TestClient) -> None:
    res = client.post(
        "/api/v1/metamodel",
        content="elements: [{name: A, extends: B}]",
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 422


def _seed_example_model(client: TestClient) -> dict:
    """Load example metamodel + a model with one Block, one Requirement, and a
    Satisfies relationship. Returns the GET snapshot of the model.
    """
    _upload_example_metamodel(client)
    _empty_model(client)
    resp = client.post(
        "/api/v1/model/elements",
        json={"type": "Block", "properties": {"name": "Wing", "mass": 12.5}},
    )
    assert resp.status_code == 201, resp.text
    block = resp.json()
    resp = client.post(
        "/api/v1/model/elements",
        json={
            "type": "Requirement",
            "properties": {"name": "REQ-1", "status": "Draft", "priority": 3},
        },
    )
    assert resp.status_code == 201, resp.text
    req = resp.json()
    resp = client.post(
        "/api/v1/model/relationships",
        json={"type": "Satisfies", "source_id": block["id"], "target_id": req["id"]},
    )
    assert resp.status_code == 201, resp.text
    resp = client.get("/api/v1/model")
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_snapshot_replaces_model(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
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
        "/api/v1/model/snapshot",
        json={"elements": elements, "relationships": relationships},
    )
    assert res.status_code == 200, res.text

    fetched = client.get("/api/v1/model").json()
    assert len(fetched["elements"]) == 3
    assert len(fetched["relationships"]) == 2
    fetched_block = next(e for e in fetched["elements"] if e["id"] == block["id"])
    assert fetched_block["properties"]["mass"] == 21.0
    assert any(e["id"] == "req-new" for e in fetched["elements"])
    assert any(r["id"] == "rel-new" for r in fetched["relationships"])


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
        "/api/v1/model/snapshot",
        json={
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
            "type_name": "NamedElement",
            "properties": {"name": "nope"},
            "rev": 0,
        }
    ]
    res = client.put(
        "/api/v1/model/snapshot",
        json={
            "elements": bad_elements,
            "relationships": snapshot["relationships"],
        },
    )
    assert res.status_code == 422, res.text
    assert "abstract" in res.json()["detail"].lower()


def test_snapshot_rejects_duplicate_element_id(client: TestClient) -> None:
    snapshot = _seed_example_model(client)
    elements = list(snapshot["elements"])
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
        "/api/v1/model/snapshot",
        json={
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
        "/api/v1/model/validate",
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
    inline_elements = []
    for e in snapshot["elements"]:
        clone = {**e, "properties": dict(e["properties"])}
        if clone["type_name"] == "Requirement":
            clone["properties"]["priority"] = 99
        inline_elements.append(clone)

    res = client.post(
        "/api/v1/model/validate",
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
    res = client.post("/api/v1/model/validate")
    assert res.status_code == 200
    assert res.json() == []


def test_delete_metamodel_clears_model(client: TestClient) -> None:
    _upload_example_metamodel(client)
    _empty_model(client)
    res = client.delete("/api/v1/metamodel")
    assert res.status_code == 204
    assert client.get("/api/v1/metamodel").status_code == 404
    assert client.get("/api/v1/model").status_code == 404
