"""Unit tests for the metamodel-family applier (api/metamodel_ops.py)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from data_rover.api.main import create_app
from data_rover.api import content, db
from data_rover.api.metamodel_ops import (
    MetamodelBatchResult,
    apply_metamodel_ops,
    split_rebind,
)
from data_rover.api.schemas import MetamodelNodePos, MoveMetamodelNodeOp, RebindMetamodelOp
from data_rover.api.session import DEFAULT_PROJECT_ID, get_session

from .conftest import AUTH_HEADERS, papi, seed_default_project

MM_V1 = "elements:\n  - name: Node\n    properties:\n      - name: label\n        datatype: string\n"
MM_V2 = "elements:\n  - name: Node\n"


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
    # ``set_metamodel`` clears ``session.model`` to None (session.py), so an
    # empty-model POST is needed too — matches the working fixture in
    # test_commits_metamodel_ops.py (Task 2), not the brief's incomplete one:
    # without it ``require_model`` 404s "No model loaded" before any op-family
    # check ever runs.
    r = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert r.status_code == 200, r.text
    return c


def _db():
    gen = db.get_db()
    s = next(gen)
    return s, gen


def test_split_rebind_rejects_two_rebinds() -> None:
    ops = [
        RebindMetamodelOp(kind="metamodel.rebind", blob="a: 1\n"),
        RebindMetamodelOp(kind="metamodel.rebind", blob="b: 2\n"),
    ]
    with pytest.raises(HTTPException) as e:
        split_rebind(ops)
    assert e.value.status_code == 422


def test_apply_rebind_swaps_memory_and_stages_rows(client: TestClient) -> None:
    session = get_session()
    s, gen = _db()
    try:
        res = apply_metamodel_ops(
            s,
            DEFAULT_PROJECT_ID,
            session,
            [RebindMetamodelOp(kind="metamodel.rebind", blob=MM_V2)],
        )
        assert res.rebound and res.prior_metamodel is not None
        # in-memory swap happened; 'label' is gone from the effective schema
        assert session.metamodel is not None
        assert not session.metamodel.effective_element_properties("Node")
        # inverse carries the PRIOR stored blob byte-identically
        inv = res.inverse_ops()
        assert len(inv) == 1 and inv[0].blob == MM_V1
        # staged rows: new MetamodelRow version, ModelRow repointed
        row = content.get_model_row(s, DEFAULT_PROJECT_ID)
        assert row is not None and row.metamodel_id == res.to_metamodel_id
        mm_row = content.get_metamodel_row(s, res.to_metamodel_id)
        assert mm_row is not None and mm_row.blob == MM_V2 and mm_row.version == 2
    finally:
        s.rollback()
        gen.close()


def test_apply_moves_updates_layout_blob_with_inverses(client: TestClient) -> None:
    session = get_session()
    s, gen = _db()
    try:
        content.stage_metamodel_layout(
            s, DEFAULT_PROJECT_ID, {"positions": {"el:Node": {"x": 1.0, "y": 2.0}}}
        )
        res = apply_metamodel_ops(
            s,
            DEFAULT_PROJECT_ID,
            session,
            [
                MoveMetamodelNodeOp(
                    kind="metamodel.move_node",
                    node="el:Node",
                    pos=MetamodelNodePos(x=9.0, y=9.0),
                ),
                MoveMetamodelNodeOp(
                    kind="metamodel.move_node",
                    node="el:Fresh",
                    pos=MetamodelNodePos(x=3.0, y=4.0),
                ),
            ],
        )
        assert res.layout_touched and not res.rebound
        blob = content.get_metamodel_layout(s, DEFAULT_PROJECT_ID)
        assert blob == {
            "positions": {
                "el:Node": {"x": 9.0, "y": 9.0},
                "el:Fresh": {"x": 3.0, "y": 4.0},
            }
        }
        inv = res.inverse_ops()
        # reversed units: Fresh's inverse removes it (no prior), Node's restores
        assert inv[0].node == "el:Fresh" and inv[0].pos is None
        assert inv[1].node == "el:Node" and inv[1].pos is not None
        assert inv[1].pos.x == 1.0 and inv[1].pos.y == 2.0
    finally:
        s.rollback()
        gen.close()
