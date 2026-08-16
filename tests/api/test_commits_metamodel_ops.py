"""Metamodel ops through the commit flow (spec 2026-08-16). This file grows
across Tasks 2-7; each task appends its section."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, papi, seed_default_project

MM_V1 = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
"""

MM_V2 = """
elements:
  - name: Node
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    r = c.post(
        papi("/metamodel"),
        content=MM_V1,
        headers={"Content-Type": "application/x-yaml"},
    )
    assert r.status_code == 200, r.text
    # The brief's fixture stops after the metamodel upload, but
    # ``set_metamodel`` clears ``session.model`` to None (session.py), and
    # every sibling commit-flow test fixture (test_commits_artifact_ops.py,
    # test_commits_view_ops.py, ...) follows the metamodel upload with an
    # empty-model POST for exactly that reason — without it, ``require_model``
    # 404s "No model loaded" before any op-family check ever runs. Added here
    # to match that established pattern (same category as the
    # MetamodelNodePos dict-literal ruling: verbatim brief text needing a
    # small, obviously-required fix to actually run).
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _rev(client: TestClient) -> int:
    return get_session().model_rev


def test_split_ops_separates_metamodel_family() -> None:
    from data_rover.api.artifact_ops import split_ops
    from data_rover.api.schemas import (
        DeleteElementOp,
        MoveMetamodelNodeOp,
        RebindMetamodelOp,
    )

    model, art, view, mm = split_ops(
        [
            RebindMetamodelOp(kind="metamodel.rebind", blob="x: 1\n"),
            DeleteElementOp(kind="delete_element", id="e1"),
            MoveMetamodelNodeOp(kind="metamodel.move_node", node="el:A", pos=None),
        ]
    )
    assert [type(o).__name__ for o in mm] == [
        "RebindMetamodelOp",
        "MoveMetamodelNodeOp",
    ]
    assert len(model) == 1 and not art and not view


def test_model_ops_route_rejects_metamodel_ops(client: TestClient) -> None:
    r = client.post(
        papi("/model/ops"),
        json={
            "base_rev": _rev(client),
            "ops": [{"kind": "metamodel.move_node", "node": "el:Node", "pos": None}],
        },
    )
    assert r.status_code == 422
    assert "commits" in r.json()["detail"]


def test_validate_route_rejects_metamodel_ops(client: TestClient) -> None:
    # Not in the brief's file list (found by grepping split_ops( call sites):
    # routes/validation.py destructures split_ops too, and mirrors the
    # existing PERMANENT artifact/view rejection there (test_view_op_schemas.py
    # ::test_validate_route_rejects_view_ops is the sibling for that pattern).
    r = client.post(
        papi("/model/validate"),
        json={"ops": [{"kind": "metamodel.move_node", "node": "el:Node", "pos": None}]},
    )
    assert r.status_code == 422
    assert "commits" in r.json()["detail"]
