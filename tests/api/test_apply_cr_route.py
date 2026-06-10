"""Tests for POST /api/v1/model/apply-cr route."""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.routes._snapshot import _build_model_from_payload
from data_rover.api.schemas import ChangeRequestIn, ElementOut, RelationshipOut
from data_rover.api.session import reset_session
from data_rover.core.metamodel.loader import load_metamodel_file
from data_rover.core.model.change_request import apply_change_request
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

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


def test_apply_cr_dangling_relationship_after_delete_yields_422(
    client: TestClient,
) -> None:
    """Deleting an element while a relationship still references it must be
    rejected like the former full result-model rebuild did."""
    _upload_metamodel(client)

    b1 = {"id": "b1", "type_name": "Block", "properties": {"name": "B1"}, "rev": 0}
    b2 = {"id": "b2", "type_name": "Block", "properties": {"name": "B2"}, "rev": 0}
    hp = {
        "id": "hp",
        "type_name": "BlockHasPart",
        "source_id": "b1",
        "target_id": "b2",
        "properties": {},
        "rev": 0,
    }
    payload = {
        "model": {"elements": [b1, b2], "relationships": [hp]},
        "cr": {
            "format": "datarover.cr/v1",
            "createdAt": "2024-01-01T00:00:00Z",
            "baseline": {"filename": None, "elementCount": 2, "relationshipCount": 1},
            "ops": {
                "elements": {"added": [], "modified": [], "deleted": [b2]},
                "relationships": {"added": [], "modified": [], "deleted": []},
            },
        },
    }
    res = client.post("/api/v1/model/apply-cr", json=payload)
    assert res.status_code == 422, res.text
    assert "unknown target" in res.json()["detail"]


def test_apply_cr_issues_equal_full_validation_of_result(
    client: TestClient,
) -> None:
    """THE incremental-validation correctness gate: the issues returned by
    apply-cr (full base run + dirty-scoped re-validation + ValidationState
    merge) must equal a from-scratch FULL validation of the result model."""
    _upload_metamodel(client)

    elements = [
        {"id": "b1", "type_name": "Block", "properties": {"name": "B1"}, "rev": 0},
        {"id": "b2", "type_name": "Block", "properties": {"name": "B2"}, "rev": 0},
        # duplicate pair (same name, both unowned)
        {"id": "b3", "type_name": "Block", "properties": {"name": "Dup"}, "rev": 0},
        {"id": "b4", "type_name": "Block", "properties": {"name": "Dup"}, "rev": 0},
        {
            "id": "r1",
            "type_name": "Requirement",
            "properties": {"name": "R1", "status": "Draft", "priority": 3},
            "rev": 0,
        },
        {"id": "edel", "type_name": "Block", "properties": {"name": "Del"}, "rev": 0},
        {"id": "q1", "type_name": "Block", "properties": {"name": "Q"}, "rev": 0},
    ]
    relationships = [
        {
            "id": "hp1",
            "type_name": "BlockHasPart",
            "source_id": "b1",
            "target_id": "b2",
            "properties": {},
            "rev": 0,
        },
        {
            "id": "hpq",
            "type_name": "BlockHasPart",
            "source_id": "b1",
            "target_id": "q1",
            "properties": {},
            "rev": 0,
        },
        {
            "id": "s1",
            "type_name": "Satisfies",
            "source_id": "edel",
            "target_id": "r1",
            "properties": {},
            "rev": 0,
        },
    ]
    cr = {
        "format": "datarover.cr/v1",
        "createdAt": "2024-01-01T00:00:00Z",
        "baseline": {"filename": None, "elementCount": 7, "relationshipCount": 3},
        "ops": {
            "elements": {
                # b5 duplicates b1; b6 misses its required name
                "added": [
                    {
                        "id": "b5",
                        "type_name": "Block",
                        "properties": {"name": "B1"},
                        "rev": 0,
                    },
                    {"id": "b6", "type_name": "Block", "properties": {}, "rev": 0},
                ],
                "modified": [
                    # de-duplicate b4
                    {
                        "id": "b4",
                        "before": {
                            "id": "b4",
                            "type_name": "Block",
                            "properties": {"name": "Dup"},
                            "rev": 0,
                        },
                        "after": {
                            "id": "b4",
                            "type_name": "Block",
                            "properties": {"name": "Unique"},
                            "rev": 0,
                        },
                    },
                    # facet violation: priority above max
                    {
                        "id": "r1",
                        "before": {
                            "id": "r1",
                            "type_name": "Requirement",
                            "properties": {
                                "name": "R1",
                                "status": "Draft",
                                "priority": 3,
                            },
                            "rev": 0,
                        },
                        "after": {
                            "id": "r1",
                            "type_name": "Requirement",
                            "properties": {
                                "name": "R1",
                                "status": "Draft",
                                "priority": 99,
                            },
                            "rev": 0,
                        },
                    },
                ],
                "deleted": [
                    {
                        "id": "edel",
                        "type_name": "Block",
                        "properties": {"name": "Del"},
                        "rev": 0,
                    }
                ],
            },
            "relationships": {
                # q1 gets a second containment parent (multi-parent issue)
                "added": [
                    {
                        "id": "hp2",
                        "type_name": "BlockHasPart",
                        "source_id": "b2",
                        "target_id": "q1",
                        "properties": {},
                        "rev": 0,
                    }
                ],
                "modified": [],
                "deleted": [
                    {
                        "id": "s1",
                        "type_name": "Satisfies",
                        "source_id": "edel",
                        "target_id": "r1",
                        "properties": {},
                        "rev": 0,
                    }
                ],
            },
        },
    }

    res = client.post(
        "/api/v1/model/apply-cr", json={"model": {"elements": elements,
                                                  "relationships": relationships},
                                        "cr": cr},
    )
    assert res.status_code == 200, res.text
    got = sorted(
        (i["severity"], i["message"], tuple(i["target_ids"]))
        for i in res.json()["issues"]
    )

    # from-scratch reference: build the result model and validate it fully
    metamodel = load_metamodel_file(EXAMPLE)
    base = _build_model_from_payload(
        metamodel,
        [ElementOut.model_validate(e) for e in elements],
        [RelationshipOut.model_validate(r) for r in relationships],
    )
    result = apply_change_request(base, ChangeRequestIn.model_validate(cr).to_core())
    expected = sorted(
        (i.severity.value, i.message, tuple(i.target_ids))
        for i in default_pipeline().validate(result, Scope.all())
    )

    assert got == expected
    assert expected, "scenario must actually produce issues"
