from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import (
    default_state,
    AUTH_HEADERS,
    seed_default_project,
    install,
    EMPTY_MODEL,
    commit_ops,
    head,
)

EXAMPLE = Path(__file__).resolve().parents[2] / "examples" / "example.metamodel.yaml"
API = "/api/v1/projects/default"


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def test_healthz(client: TestClient) -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def _upload_example_metamodel(client: TestClient) -> None:
    yaml_text = EXAMPLE.read_text(encoding="utf-8")
    res = client.post(
        f"{API}/metamodel",
        content=yaml_text,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text


def _empty_model(client: TestClient) -> None:
    install(metamodel=EXAMPLE.read_text(encoding="utf-8"), model=EMPTY_MODEL)


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
        f"{API}/metamodel",
        content=MULTI_MAPPING_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text

    res = client.get(f"{API}/metamodel")
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

    res = client.get(f"{API}/metamodel")
    assert res.status_code == 200
    assert {e["name"] for e in res.json()["elements"]} == {
        "NamedElement",
        "Requirement",
        "Block",
    }

    _empty_model(client)

    out = commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_block",
                "type_name": "Block",
                "properties": {"name": "Wing", "mass": 12.5},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_req",
                "type_name": "Requirement",
                "properties": {"name": "REQ-1", "status": "Draft", "priority": 3},
            },
        ],
    )
    block_id, req_id = out["id_map"]["tmp_block"], out["id_map"]["tmp_req"]
    out = commit_ops(
        client,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_rel",
                "type_name": "Satisfies",
                "source_id": block_id,
                "target_id": req_id,
            },
            {
                "kind": "update_element",
                "id": block_id,
                "properties_patch": {"mass": 13.0},
            },
        ],
    )
    rel_id = out["id_map"]["tmp_rel"]
    state = head()
    assert len(state.elements) == 2
    assert len(state.relationships) == 1
    assert state.relationships[rel_id]["type_name"] == "Satisfies"
    assert state.elements[block_id]["properties"] == {"name": "Wing", "mass": 13.0}

    commit_ops(
        client,
        [
            {"kind": "delete_relationship", "id": rel_id},
            {"kind": "delete_element", "id": block_id},
        ],
    )
    state = head()
    assert list(state.elements) == [req_id]
    assert state.relationships == {}


def test_404_when_no_metamodel_loaded(client: TestClient) -> None:
    res = client.get(f"{API}/metamodel")
    assert res.status_code == 404


def test_reupload_metamodel_on_nonempty_model_rejected(client: TestClient) -> None:
    _upload_example_metamodel(client)
    _empty_model(client)
    block_id = commit_ops(
        client,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Block",
                "properties": {"name": "X", "mass": 1.0},
            }
        ],
    )["id_map"]["tmp_x"]
    # Re-upload metamodel on non-empty model; should be rejected with 409.
    yaml_text = EXAMPLE.read_text(encoding="utf-8")
    res = client.post(
        f"{API}/metamodel",
        content=yaml_text,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 409
    # Model should be preserved.
    assert block_id in head().elements


def test_422_on_bad_metamodel(client: TestClient) -> None:
    res = client.post(
        f"{API}/metamodel",
        content="elements: [{name: A, extends: B}]",
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 422


def test_delete_metamodel_clears_the_loaded_metamodel(client: TestClient) -> None:
    _upload_example_metamodel(client)
    _empty_model(client)
    res = client.delete(f"{API}/metamodel")
    assert res.status_code == 204
    assert client.get(f"{API}/metamodel").status_code == 404
    assert default_state().metamodel is None
