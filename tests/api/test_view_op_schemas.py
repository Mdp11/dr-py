"""Wire-contract tests for the view.* op family: discriminated-union
round-trip through OPS_ADAPTER (the durable journal format), the 3-way
split, and the legacy-path rejections. These pin the field names the
frontend plan will mirror into ops.ts — renames here are contract breaks."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.artifact_ops import split_ops
from data_rover.api.main import create_app
from data_rover.api.schemas import (
    OPS_ADAPTER,
    VIEW_OP_KINDS,
    CreateElementOp,
    CreateArtifactOp,
)

from .conftest import AUTH_HEADERS, papi, seed_default_project

_MM = """
elements:
  - name: Node
"""

RAW_VIEW_OPS = [
    {"kind": "create_folder", "temp_id": "tmp_f1", "parent_id": "root", "name": "A"},
    {"kind": "rename_folder", "id": "f1", "name": "B"},
    {"kind": "move_folder", "id": "f1", "to_parent_id": "f2", "index": 0},
    {"kind": "delete_folder", "id": "f1"},
    {"kind": "place_element", "element_id": "e1", "folder_id": "f1", "index": 2},
    {"kind": "remove_element", "element_id": "e1", "folder_id": "f1"},
    {
        "kind": "move_element",
        "element_id": "e1",
        "from_folder_id": "f1",
        "to_folder_id": "f2",
        "index": None,
    },
    {
        "kind": "place_artifact",
        "artifact_id": "a1",
        "artifact_kind": "table",
        "folder_id": "root",
        "index": 0,
    },
    {"kind": "remove_artifact", "artifact_id": "a1", "folder_id": "root"},
    {
        "kind": "move_artifact",
        "artifact_id": "a1",
        "from_folder_id": "root",
        "to_folder_id": "f1",
        "index": None,
    },
]


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"}
    )
    assert r.status_code == 200, r.text
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def test_union_round_trips_and_kinds_set_matches() -> None:
    ops = OPS_ADAPTER.validate_python(RAW_VIEW_OPS)
    assert [o.kind for o in ops] == [r["kind"] for r in RAW_VIEW_OPS]
    dumped = OPS_ADAPTER.dump_python(ops, mode="json")
    assert OPS_ADAPTER.validate_python(dumped) == ops
    assert VIEW_OP_KINDS == {r["kind"] for r in RAW_VIEW_OPS}


def test_split_ops_three_ways() -> None:
    ops = OPS_ADAPTER.validate_python(
        [
            {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node"},
            {
                "kind": "create_artifact",
                "temp_id": "tmp_a",
                "artifact_kind": "table",
                "name": "t",
                "payload": {},
            },
            *RAW_VIEW_OPS[:1],
        ]
    )
    model_ops, artifact_ops, view_ops, _metamodel_ops = split_ops(ops)
    assert isinstance(model_ops[0], CreateElementOp)
    assert isinstance(artifact_ops[0], CreateArtifactOp)
    assert len(view_ops) == 1 and view_ops[0].kind == "create_folder"


def test_model_ops_route_rejects_view_ops(client: TestClient) -> None:
    # base_rev must match the session's current model_rev (the fixture's
    # metamodel + model uploads each bump it via session.set_model), or the
    # staleness check would 409 before the view-op guard ever runs.
    rev = client.get(papi("/model/summary")).json()["model_rev"]
    r = client.post(
        papi("/model/ops"),
        json={"base_rev": rev, "ops": [RAW_VIEW_OPS[0]]},
    )
    assert r.status_code == 422
    assert "view ops" in r.json()["detail"]


def test_validate_route_rejects_view_ops(client: TestClient) -> None:
    r = client.post(
        papi("/model/validate"),
        json={"ops": [RAW_VIEW_OPS[0]]},
    )
    assert r.status_code == 422
