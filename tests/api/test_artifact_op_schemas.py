"""The op-union split: artifact ops parse through OPS_ADAPTER (journal
round-trip), split_ops separates families, required_locks derives art:
leases, the legacy /model/ops endpoint still rejects artifact ops
permanently, and the commit endpoints route them into the artifact flow."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api.artifact_ops import split_ops
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
    # The actual round-trip property the journal's durability rests on:
    # dump -> JSON -> re-validate reproduces the SAME ops field-for-field
    # (payload/temp_id/name/artifact_rev included), not just matching kinds.
    assert OPS_ADAPTER.validate_python(dumped) == ops


def test_split_ops_separates_families() -> None:
    ops = OPS_ADAPTER.validate_python([
        {"kind": "create_element", "temp_id": "tmp_e", "type_name": "Node", "properties": {}},
        {"kind": "update_artifact", "id": "a1", "payload": {"code": "y"}},
    ])
    model_ops, artifact_ops, view_ops, _metamodel_ops = split_ops(ops)
    assert [o.kind for o in model_ops] == ["create_element"]
    assert [o.kind for o in artifact_ops] == ["update_artifact"]
    assert view_ops == []


def test_required_locks_for_artifact_ops() -> None:
    ops = OPS_ADAPTER.validate_python([
        {"kind": "create_artifact", "temp_id": "tmp_a", "artifact_kind": "table",
         "name": "t", "payload": {}},
        {"kind": "update_artifact", "id": "a1", "payload": {}},
        {"kind": "delete_artifact", "id": "a2"},
        # Same-batch create-then-mutate-by-temp-id: "tmp_x" is created earlier
        # in THIS batch, so no lease could ever cover it yet — it must derive
        # NO RequiredLock (mirrors the model-op temp-id exemption). Regression
        # case for the create_artifact branch storing a NAMESPACED id in
        # `created` (art:tmp_x), matching what update/delete derive for the
        # same id — a bare "tmp_x" would never satisfy either `add()` guard.
        {"kind": "create_artifact", "temp_id": "tmp_x", "artifact_kind": "table",
         "name": "x", "payload": {}},
        {"kind": "update_artifact", "id": "tmp_x", "payload": {}},
        {"kind": "delete_artifact", "id": "tmp_x"},
    ])
    reqs = required_locks(_model(), {}, ops)
    by_id = {r.resource_id: r for r in reqs}
    assert set(by_id) == {artifact_resource("a1"), artifact_resource("a2")}
    assert by_id["art:a1"].mode is LockMode.EXCLUSIVE
    assert by_id["art:a1"].intent is LockIntent.EDIT
    assert by_id["art:a2"].intent is LockIntent.DELETE
    assert artifact_resource("tmp_x") not in by_id


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


def test_commit_endpoints_route_artifact_ops_to_the_artifact_flow(
    client: TestClient,
) -> None:
    # Preview and commit fail for their own domain's reasons rather than a
    # blanket rejection: preview validates the op dry (unknown artifact ->
    # 422) and commit checks the lease first (none held -> 409). Neither ever
    # reaches the model applier. Full behavior lives in
    # test_commits_artifact_ops.py.
    r = client.post(papi("/commits/preview"), json=_artifact_op_batch(client))
    assert r.status_code == 422
    assert "a1" in r.text  # rejected as an unknown artifact, not as an op kind
    r = client.post(papi("/commits"), json={**_artifact_op_batch(client), "lock_tokens": []})
    assert r.status_code == 409
    assert r.json()["missing"][0]["resource_id"] == artifact_resource("a1")
