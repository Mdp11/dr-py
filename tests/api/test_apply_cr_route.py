"""POST /api/v1/projects/{id}/model/apply-cr — dry-run proposal of an ordered
CR list against the session model (never applied server-side)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from data_rover.api import tenancy
from data_rover.api.db import db_session
from data_rover.api.db_models import Role
from data_rover.api.main import create_app
from data_rover.api.schemas import MAX_CRS_PER_REQUEST
from data_rover.api.session import get_session

from .conftest import AUTH_HEADERS, seed_default_project

API = "/api/v1/projects/default"

MM = """
elements:
  - name: Item
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
      - {name: note, datatype: string}
  - name: Other
    properties:
      - {name: name, datatype: string}
relationships:
  - name: Contains
    containment: true
    source: Item
    target: Item
  - name: Links
    containment: false
    source: Item
    target: Item
    properties:
      - {name: weight, datatype: integer}
"""


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    res = c.post(f"{API}/metamodel", content=MM, headers={"content-type": "application/x-yaml"})
    assert res.status_code == 200, res.text
    return c


@pytest.fixture
def seeded(client: TestClient) -> TestClient:
    """a Contains b via r-ab."""
    res = client.post(
        f"{API}/model",
        json={
            "elements": [_el("a", "A"), _el("b", "B")],
            "relationships": [_rel("r-ab", "Contains", "a", "b")],
        },
    )
    assert res.status_code == 200, res.text
    return client


@pytest.fixture
def viewer_headers(client: TestClient) -> dict[str, str]:
    with db_session() as s:
        tenancy.upsert_user(s, user_id="viewer-1", email="v@example.com")
        tenancy.add_member(s, project_id="default", user_id="viewer-1", role=Role.viewer)
    return {"x-user-id": "viewer-1", "x-user-email": "v@example.com"}


def _el(eid: str, name: str, type_name: str = "Item", **props) -> dict:
    return {"id": eid, "type_name": type_name, "properties": {"name": name, **props}, "rev": 0}


def _rel(rid: str, type_name: str, src: str, tgt: str, **props) -> dict:
    return {
        "id": rid,
        "type_name": type_name,
        "source_id": src,
        "target_id": tgt,
        "properties": dict(props),
        "rev": 0,
    }


def _cr(
    *,
    e_added=(),
    e_modified=(),
    e_deleted=(),
    r_added=(),
    r_modified=(),
    r_deleted=(),
) -> dict:
    return {
        "format": "datarover.cr/v1",
        "createdAt": "2026-01-01T00:00:00Z",
        "baseline": {"filename": None, "elementCount": 0, "relationshipCount": 0},
        "ops": {
            "elements": {
                "added": list(e_added),
                "modified": list(e_modified),
                "deleted": list(e_deleted),
            },
            "relationships": {
                "added": list(r_added),
                "modified": list(r_modified),
                "deleted": list(r_deleted),
            },
        },
    }


def _mod(id: str, before: dict, after: dict) -> dict:
    return {"id": id, "before": before, "after": after}


def _propose(client: TestClient, crs: list[dict], **kw):
    return client.post(f"{API}/model/apply-cr", json={"crs": crs}, **kw)


def test_propose_returns_ops_and_combined_cr_without_touching_session(seeded: TestClient) -> None:
    rev = get_session().model_rev
    res = _propose(seeded, [_cr(e_added=[_el("n1", "N")])])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["model_rev"] == rev
    assert body["ops"] == [
        {
            "kind": "create_element",
            "temp_id": "tmp_1",
            "id": "n1",
            "type_name": "Item",
            "properties": {"name": "N"},
        }
    ]
    assert [e["id"] for e in body["cr"]["ops"]["elements"]["added"]] == ["n1"]
    assert body["cr"]["baseline"] == {"filename": None, "elementCount": 2, "relationshipCount": 1}
    assert get_session().model_rev == rev
    model = get_session().model
    assert model is not None and "n1" not in model.elements


def test_propose_applies_crs_sequentially(seeded: TestClient) -> None:
    """CR2 modifies what CR1 added: one create op with the FINAL state."""
    cr1 = _cr(e_added=[_el("n1", "N")])
    cr2 = _cr(e_modified=[_mod("n1", _el("n1", "N"), _el("n1", "N2", note="x"))])
    res = _propose(seeded, [cr1, cr2])
    assert res.status_code == 200, res.text
    body = res.json()
    assert [op["kind"] for op in body["ops"]] == ["create_element"]
    assert body["ops"][0]["properties"] == {"name": "N2", "note": "x"}
    assert body["cr"]["ops"]["elements"]["modified"] == []


def test_propose_conflict_reports_index_of_failing_cr(seeded: TestClient) -> None:
    rev = get_session().model_rev
    cr1 = _cr(e_added=[_el("n1", "N")])
    cr2 = _cr(e_modified=[_mod("zzz", _el("zzz", "Z"), _el("zzz", "Z2"))])
    res = _propose(seeded, [cr1, cr2])
    assert res.status_code == 409, res.text
    body = res.json()
    assert body["cr_index"] == 1
    assert body["model_rev"] == rev
    assert [(c["kind"], c["id"]) for c in body["conflicts"]] == [("missing", "zzz")]


def test_propose_before_mismatch_against_session_is_409_at_index_0(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_modified=[_mod("a", _el("a", "WRONG"), _el("a", "A2"))])])
    assert res.status_code == 409
    assert res.json()["cr_index"] == 0
    assert res.json()["conflicts"][0]["kind"] == "before_mismatch"


def test_propose_gate_unknown_type_422(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_added=[_el("n1", "N", type_name="Nope")])])
    assert res.status_code == 422, res.text
    assert "Nope" in res.json()["detail"]


def test_propose_gate_dangling_delete_422(seeded: TestClient) -> None:
    """Deleting b without deleting r-ab leaves a dangling relationship."""
    res = _propose(seeded, [_cr(e_deleted=[_el("b", "B")])])
    assert res.status_code == 422, res.text
    assert "r-ab" in res.json()["detail"]


def test_propose_retype_422(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_modified=[_mod("a", _el("a", "A"), _el("a", "A", type_name="Other"))])])
    assert res.status_code == 422, res.text
    assert "'a'" in res.json()["detail"] and "type" in res.json()["detail"]


def test_propose_orders_relationship_delete_before_element_delete(seeded: TestClient) -> None:
    res = _propose(
        seeded,
        [_cr(e_deleted=[_el("b", "B")], r_deleted=[_rel("r-ab", "Contains", "a", "b")])],
    )
    assert res.status_code == 200, res.text
    assert [(op["kind"], op["id"]) for op in res.json()["ops"]] == [
        ("delete_relationship", "r-ab"),
        ("delete_element", "b"),
    ]


def test_propose_modified_becomes_patch(seeded: TestClient) -> None:
    res = _propose(seeded, [_cr(e_modified=[_mod("a", _el("a", "A"), _el("a", "A2", note="n"))])])
    assert res.status_code == 200, res.text
    assert res.json()["ops"] == [
        {"kind": "update_element", "id": "a", "properties_patch": {"name": "A2", "note": "n"}}
    ]


def test_propose_empty_list_422(seeded: TestClient) -> None:
    assert _propose(seeded, []).status_code == 422


def test_propose_over_cap_422(seeded: TestClient) -> None:
    crs = [_cr(e_added=[_el(f"n{i}", f"N{i}")]) for i in range(MAX_CRS_PER_REQUEST + 1)]
    assert _propose(seeded, crs).status_code == 422
    assert _propose(seeded, crs[:-1]).status_code == 200


def test_propose_without_model_404(client: TestClient) -> None:
    assert _propose(client, [_cr()]).status_code == 404


def test_propose_viewer_403(seeded: TestClient, viewer_headers: dict[str, str]) -> None:
    res = seeded.post(f"{API}/model/apply-cr", json={"crs": [_cr()]}, headers=viewer_headers)
    assert res.status_code == 403, res.text
