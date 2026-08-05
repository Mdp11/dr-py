"""The op-union split: artifact ops parse through OPS_ADAPTER (journal
round-trip), split_ops separates families, required_locks derives art:
leases, and every legacy endpoint still rejects artifact ops until the
commit route learns them (Task 5)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.artifact_ops import ARTIFACT_OP_KINDS, split_ops
from data_rover.api.locking import LockIntent, LockMode, artifact_resource, required_locks
from data_rover.api.schemas import OPS_ADAPTER, CreateArtifactOp, UpdateArtifactOp
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

from .conftest import AUTH_HEADERS, papi, seed_default_project
from data_rover.api.main import create_app

_MM = """
elements:
  - name: Node
"""


def _model() -> Model:
    return Model(load_metamodel_str(_MM))


def test_ops_adapter_roundtrips_artifact_ops() -> None:
    raw = [
        {"kind": "create_artifact", "temp_id": "tmp_a", "artifact_kind": "code_snippet",
         "name": "s", "payload": {"code": "x = 1"}},
        {"kind": "update_artifact", "id": "a1", "payload": {"code": "y = 2"}},
        {"kind": "delete_artifact", "id": "a2"},
    ]
    ops = OPS_ADAPTER.validate_python(raw)
    assert isinstance(ops[0], CreateArtifactOp)
    dumped = OPS_ADAPTER.dump_python(ops, mode="json")
    assert [d["kind"] for d in dumped] == [r["kind"] for r in raw]
    assert set(d["kind"] for d in dumped) <= ARTIFACT_OP_KINDS | {"create_element"}


def test_split_ops_separates_families() -> None:
    ops = OPS_ADAPTER.validate_python([
        {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node", "properties": {}},
        {"kind": "update_artifact", "id": "a1", "payload": {"code": "y"}},
    ])
    model_ops, artifact_ops = split_ops(ops)
    assert [o.kind for o in model_ops] == ["create_element"]
    assert [o.kind for o in artifact_ops] == ["update_artifact"]


def test_required_locks_for_artifact_ops() -> None:
    ops = OPS_ADAPTER.validate_python([
        {"kind": "create_artifact", "temp_id": "tmp_a", "artifact_kind": "table",
         "name": "t", "payload": {}},
        {"kind": "update_artifact", "id": "a1", "payload": {}},
        {"kind": "delete_artifact", "id": "a2"},
    ])
    reqs = required_locks(_model(), ops)
    by_id = {r.resource_id: r for r in reqs}
    assert set(by_id) == {artifact_resource("a1"), artifact_resource("a2")}
    assert by_id["art:a1"].mode is LockMode.EXCLUSIVE
    assert by_id["art:a1"].intent is LockIntent.EDIT
    assert by_id["art:a2"].intent is LockIntent.DELETE


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(papi("/metamodel"), content=_MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200, res.text
    res = c.post(papi("/model"), json={"elements": [], "relationships": []})
    assert res.status_code == 200, res.text
    return c


def _artifact_op_batch(c: TestClient) -> dict:
    rev = c.get(papi("/model/summary")).json()["model_rev"]
    return {
        "base_rev": rev,
        "ops": [{"kind": "update_artifact", "id": "a1", "payload": {"code": "y"}}],
    }


def test_legacy_model_ops_endpoint_rejects_artifact_ops(client: TestClient) -> None:
    r = client.post(papi("/model/ops"), json=_artifact_op_batch(client))
    assert r.status_code == 422
    assert "artifact ops" in r.text


def test_commit_endpoints_reject_artifact_ops_until_wired(client: TestClient) -> None:
    # These two flip to real behavior in Task 5; the guard proves artifact ops
    # can never reach the model applier meanwhile.
    r = client.post(papi("/commits/preview"), json=_artifact_op_batch(client))
    assert r.status_code == 422
    r = client.post(papi("/commits"), json={**_artifact_op_batch(client), "lock_tokens": []})
    assert r.status_code == 422
