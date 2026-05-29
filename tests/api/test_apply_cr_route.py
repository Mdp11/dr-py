"""Tests for POST /api/v1/model/apply-cr route."""
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


def _upload_metamodel(client: TestClient) -> None:
    yaml_text = EXAMPLE.read_text(encoding="utf-8")
    res = client.post(
        "/api/v1/metamodel",
        content=yaml_text,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text


def _make_apply_cr_payload(model_elements: list[dict], cr_ops: dict) -> dict:
    return {
        "model": {
            "elements": model_elements,
            "relationships": [],
        },
        "cr": {
            "format": "datarover.cr/v1",
            "createdAt": "2024-01-01T00:00:00Z",
            "baseline": {
                "filename": None,
                "elementCount": len(model_elements),
                "relationshipCount": 0,
            },
            "ops": cr_ops,
        },
    }


def test_apply_cr_happy_path(client: TestClient) -> None:
    """Adding a new element via CR returns 200 with both elements and does not
    set the session model."""
    _upload_metamodel(client)

    e1 = {"id": "e1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0}
    e2_added = {
        "id": "e2",
        "type_name": "Block",
        "properties": {"name": "B"},
        "rev": 0,
    }

    payload = _make_apply_cr_payload(
        model_elements=[e1],
        cr_ops={
            "elements": {
                "added": [e2_added],
                "modified": [],
                "deleted": [],
            },
            "relationships": {
                "added": [],
                "modified": [],
                "deleted": [],
            },
        },
    )

    res = client.post("/api/v1/model/apply-cr", json=payload)
    assert res.status_code == 200, res.text

    body = res.json()
    assert "model" in body
    assert "issues" in body

    result_ids = {e["id"] for e in body["model"]["elements"]}
    assert result_ids == {"e1", "e2"}


def test_apply_cr_does_not_set_session_model(client: TestClient) -> None:
    """After a successful apply-cr, GET /api/v1/model should still return 404."""
    _upload_metamodel(client)

    e1 = {"id": "e1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0}
    e2_added = {
        "id": "e2",
        "type_name": "Block",
        "properties": {"name": "B"},
        "rev": 0,
    }

    payload = _make_apply_cr_payload(
        model_elements=[e1],
        cr_ops={
            "elements": {
                "added": [e2_added],
                "modified": [],
                "deleted": [],
            },
            "relationships": {
                "added": [],
                "modified": [],
                "deleted": [],
            },
        },
    )

    res = client.post("/api/v1/model/apply-cr", json=payload)
    assert res.status_code == 200, res.text

    # Session model must not have been set
    get_res = client.get("/api/v1/model")
    assert get_res.status_code == 404


def test_apply_cr_conflict_id_exists(client: TestClient) -> None:
    """CR that adds an element whose id already exists yields 409 with conflicts."""
    _upload_metamodel(client)

    e1 = {"id": "e1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0}
    # CR tries to add e1 which already exists in the model
    payload = _make_apply_cr_payload(
        model_elements=[e1],
        cr_ops={
            "elements": {
                "added": [e1],  # same id — conflict!
                "modified": [],
                "deleted": [],
            },
            "relationships": {
                "added": [],
                "modified": [],
                "deleted": [],
            },
        },
    )

    res = client.post("/api/v1/model/apply-cr", json=payload)
    assert res.status_code == 409, res.text

    body = res.json()
    assert "conflicts" in body
    assert len(body["conflicts"]) >= 1
    conflict = body["conflicts"][0]
    assert conflict["kind"] == "id_exists"
    assert conflict["entity"] == "element"


def test_apply_cr_unknown_type_in_cr_yields_422(client: TestClient) -> None:
    """A CR that adds an element with a type_name not in the metamodel must return 422."""
    _upload_metamodel(client)

    e1 = {"id": "e1", "type_name": "Block", "properties": {"name": "A"}, "rev": 0}
    # e2 has a type_name that does not exist in the metamodel
    e2_unknown_type = {
        "id": "e2",
        "type_name": "NonExistentType",
        "properties": {},
        "rev": 0,
    }

    payload = _make_apply_cr_payload(
        model_elements=[e1],
        cr_ops={
            "elements": {
                "added": [e2_unknown_type],
                "modified": [],
                "deleted": [],
            },
            "relationships": {
                "added": [],
                "modified": [],
                "deleted": [],
            },
        },
    )

    res = client.post("/api/v1/model/apply-cr", json=payload)
    assert res.status_code == 422, res.text
