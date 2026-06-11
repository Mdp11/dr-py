"""Tests for the delta-protocol mutation endpoints (Phase C1):
POST /model/ops and POST /model/undo.
"""

from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

import data_rover.api.session as session_module
from data_rover.api.main import create_app
from data_rover.api.session import get_session, reset_session
from data_rover.core.model.model import Model
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope

# Item.name is required (multiplicity 1) and the uniqueness key; `ref` is a
# single-valued reference property, `refs` a list reference. Contains is the
# containment relationship for cascade tests.
OPS_MM = """
enums:
  Status: [Draft, Approved]
elements:
  - name: Item
    key: [name]
    properties:
      - {name: name, datatype: string, multiplicity: "1"}
      - {name: status, datatype: Status}
      - {name: note, datatype: string}
      - {name: ref, datatype: Item}
      - {name: refs, datatype: Item, multiplicity: "0..*"}
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
    reset_session()
    app = create_app()
    c = TestClient(app)
    res = c.post(
        "/api/v1/metamodel",
        content=OPS_MM,
        headers={"content-type": "application/x-yaml"},
    )
    assert res.status_code == 200, res.text
    return c


@pytest.fixture
def seeded(client: TestClient) -> TestClient:
    """Model with items a, b, c; a Contains b; a Links c (weight 2)."""
    res = client.post(
        "/api/v1/model",
        json={
            "elements": [
                {"id": "a", "type_name": "Item", "properties": {"name": "A"}},
                {"id": "b", "type_name": "Item", "properties": {"name": "B"}},
                {"id": "c", "type_name": "Item", "properties": {"name": "C"}},
            ],
            "relationships": [
                {
                    "id": "r-ab",
                    "type_name": "Contains",
                    "source_id": "a",
                    "target_id": "b",
                },
                {
                    "id": "r-ac",
                    "type_name": "Links",
                    "source_id": "a",
                    "target_id": "c",
                    "properties": {"weight": 2},
                },
            ],
        },
    )
    assert res.status_code == 200, res.text
    return client


def _rev() -> int:
    return get_session().model_rev


def _model() -> Model:
    model = get_session().model
    assert model is not None
    return model


def _post_ops(client: TestClient, ops: list[dict], base_rev: int | None = None):
    if base_rev is None:
        base_rev = _rev()
    return client.post("/api/v1/model/ops", json={"base_rev": base_rev, "ops": ops})


def _undo(client: TestClient):
    return client.post("/api/v1/model/undo")


def _snapshot(model: Model):
    """Rev-insensitive deep snapshot of the model's entity state."""
    elements = {
        e.id: (e.type_name, copy.deepcopy(e.properties))
        for e in model.elements.values()
    }
    relationships = {
        r.id: (r.type_name, r.source_id, r.target_id, copy.deepcopy(r.properties))
        for r in model.relationships.values()
    }
    return elements, relationships


def _issue_set(issues) -> list[tuple]:
    return sorted((i.severity.value, i.message, tuple(i.target_ids)) for i in issues)


def _fresh_full_issues(model: Model) -> list[tuple]:
    return _issue_set(default_pipeline().validate(model, Scope.all()))


def _assert_state_matches_full(model: Model) -> None:
    state = get_session().validation
    assert state is not None
    assert _issue_set(state.all_issues()) == _fresh_full_issues(model)


# --- per-op-kind round trips -----------------------------------------------


def test_create_element_response_contents(seeded: TestClient) -> None:
    rev = _rev()
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {"name": "X", "status": "Draft"},
            }
        ],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["model_rev"] == rev + 1
    assert _rev() == rev + 1
    new_id = body["id_map"]["tmp_x"]
    assert not new_id.startswith("tmp_")
    assert [e["id"] for e in body["changed_elements"]] == [new_id]
    el = body["changed_elements"][0]
    assert el["type_name"] == "Item"
    assert el["properties"] == {"name": "X", "status": "Draft"}
    assert body["changed_relationships"] == []
    assert body["deleted_element_ids"] == []
    assert body["deleted_relationship_ids"] == []
    assert body["issues_added"] == []
    assert body["issues_removed_owner_ids"] == []
    assert body["issue_counts"] == {}
    assert _model().elements[new_id].properties == {"name": "X", "status": "Draft"}


def test_update_element_roundtrip(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "hi"}}],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert [e["id"] for e in body["changed_elements"]] == ["a"]
    assert body["changed_elements"][0]["properties"] == {"name": "A", "note": "hi"}
    assert body["id_map"] == {}
    assert _model().elements["a"].properties == {"name": "A", "note": "hi"}


def test_delete_element_roundtrip(seeded: TestClient) -> None:
    res = _post_ops(seeded, [{"kind": "delete_element", "id": "c"}])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["deleted_element_ids"] == ["c"]
    assert body["deleted_relationship_ids"] == ["r-ac"]  # incident Links rel
    assert body["changed_elements"] == []
    assert "c" not in _model().elements


def test_create_relationship_roundtrip(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Links",
                "source_id": "b",
                "target_id": "c",
                "properties": {"weight": 7},
            }
        ],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    rid = body["id_map"]["tmp_r"]
    assert [r["id"] for r in body["changed_relationships"]] == [rid]
    rel = body["changed_relationships"][0]
    assert (rel["source_id"], rel["target_id"]) == ("b", "c")
    assert rel["properties"] == {"weight": 7}
    assert _model().relationships[rid].properties == {"weight": 7}


def test_update_relationship_roundtrip(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [
            {
                "kind": "update_relationship",
                "id": "r-ac",
                "properties_patch": {"weight": 9},
            }
        ],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert [r["id"] for r in body["changed_relationships"]] == ["r-ac"]
    assert body["changed_relationships"][0]["properties"] == {"weight": 9}
    assert _model().relationships["r-ac"].properties == {"weight": 9}


def test_delete_relationship_roundtrip(seeded: TestClient) -> None:
    res = _post_ops(seeded, [{"kind": "delete_relationship", "id": "r-ac"}])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["deleted_relationship_ids"] == ["r-ac"]
    assert body["deleted_element_ids"] == []
    assert "r-ac" not in _model().relationships


# --- temp-id resolution ------------------------------------------------------


def test_relationship_between_two_in_batch_creates(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_p",
                "type_name": "Item",
                "properties": {"name": "P"},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_q",
                "type_name": "Item",
                "properties": {"name": "Q"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_pq",
                "type_name": "Links",
                "source_id": "tmp_p",
                "target_id": "tmp_q",
                "properties": {},
            },
        ],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    p, q, pq = (body["id_map"][t] for t in ("tmp_p", "tmp_q", "tmp_pq"))
    rel = _model().relationships[pq]
    assert (rel.source_id, rel.target_id) == (p, q)


def test_reference_property_temp_ids_single_and_list(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_t",
                "type_name": "Item",
                "properties": {"name": "T"},
            },
            {
                "kind": "create_element",
                "temp_id": "tmp_u",
                "type_name": "Item",
                # single reference + list reference mixing temp and canonical
                "properties": {"name": "U", "ref": "tmp_t", "refs": ["tmp_t", "a"]},
            },
            # patches are remapped too
            {
                "kind": "update_element",
                "id": "a",
                "properties_patch": {"ref": "tmp_u"},
            },
        ],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    t, u = body["id_map"]["tmp_t"], body["id_map"]["tmp_u"]
    model = _model()
    assert model.elements[u].properties["ref"] == t
    assert model.elements[u].properties["refs"] == [t, "a"]
    assert model.elements["a"].properties["ref"] == u


def test_later_ops_can_target_in_batch_temp_ids(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_v",
                "type_name": "Item",
                "properties": {"name": "V"},
            },
            {
                "kind": "update_element",
                "id": "tmp_v",
                "properties_patch": {"note": "patched"},
            },
        ],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    v = body["id_map"]["tmp_v"]
    # created then updated in one batch -> appears once in changed_elements
    assert [e["id"] for e in body["changed_elements"]] == [v]
    assert _model().elements[v].properties == {"name": "V", "note": "patched"}


# --- mergePatch semantics ----------------------------------------------------


def test_merge_patch_null_deletes_and_absent_keys_unchanged(seeded: TestClient) -> None:
    res = _post_ops(
        seeded,
        [
            {
                "kind": "update_element",
                "id": "a",
                "properties_patch": {"note": "n1", "status": "Draft"},
            }
        ],
    )
    assert res.status_code == 200, res.text
    res = _post_ops(
        seeded,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": None}}],
    )
    assert res.status_code == 200, res.text
    # note deleted; name and status untouched (absent from the patch)
    assert _model().elements["a"].properties == {"name": "A", "status": "Draft"}
    # null-deleting an absent (but schema-valid) key is a no-op, not an error
    res = _post_ops(
        seeded,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": None}}],
    )
    assert res.status_code == 200, res.text
    assert _model().elements["a"].properties == {"name": "A", "status": "Draft"}


# --- protocol errors ----------------------------------------------------------


def test_409_on_base_rev_mismatch(seeded: TestClient) -> None:
    rev = _rev()
    res = _post_ops(seeded, [], base_rev=rev + 5)
    assert res.status_code == 409
    body = res.json()
    assert body["model_rev"] == rev
    assert "detail" in body
    assert _rev() == rev  # rejected batches do not bump


def test_409_on_empty_undo(seeded: TestClient) -> None:
    rev = _rev()
    res = _undo(seeded)
    assert res.status_code == 409
    assert res.json()["model_rev"] == rev


def test_404_without_model(client: TestClient) -> None:
    # metamodel loaded, but no model
    assert _post_ops(client, [], base_rev=0).status_code == 404
    assert _undo(client).status_code == 404


def test_422_examples(seeded: TestClient) -> None:
    cases = [
        # unknown element type
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Nope",
                "properties": {},
            }
        ],
        # unknown property
        [{"kind": "update_element", "id": "a", "properties_patch": {"ghost": 1}}],
        # unknown entity id
        [{"kind": "delete_element", "id": "missing"}],
        # unknown (unregistered) temp id
        [
            {
                "kind": "update_element",
                "id": "tmp_never",
                "properties_patch": {"note": "x"},
            }
        ],
        # temp_id without the tmp_ prefix is rejected on the public endpoint
        [
            {
                "kind": "create_element",
                "temp_id": "x1",
                "type_name": "Item",
                "properties": {},
            }
        ],
    ]
    for ops in cases:
        res = _post_ops(seeded, ops)
        assert res.status_code == 422, (ops, res.text)


def test_empty_ops_batch_is_a_no_op(seeded: TestClient) -> None:
    # accepted (matching base_rev) but applies nothing: no rev bump, no
    # op_log entry, empty delta fields
    rev = _rev()
    res = _post_ops(seeded, [])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["model_rev"] == rev
    assert _rev() == rev
    assert get_session().op_log == []
    assert body["id_map"] == {}
    assert body["changed_elements"] == []
    assert body["changed_relationships"] == []
    assert body["deleted_element_ids"] == []
    assert body["deleted_relationship_ids"] == []
    assert body["issues_added"] == []
    assert body["issues_removed_owner_ids"] == []
    # no history was created, so there is nothing to undo
    assert _undo(seeded).status_code == 409


# --- legacy (non-ops) mutation routes -------------------------------------------


def test_legacy_mutation_invalidates_ops_protocol_state(seeded: TestClient) -> None:
    # build undo history through the ops protocol first
    res = _post_ops(
        seeded,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "x"}}],
    )
    assert res.status_code == 200, res.text
    rev = _rev()
    assert len(get_session().op_log) == 1
    # legacy element create mutates outside the ops protocol
    res = seeded.post(
        "/api/v1/model/elements",
        json={"type": "Item", "properties": {"name": "L"}},
    )
    assert res.status_code == 201, res.text
    assert _rev() == rev + 1  # model_rev bumped
    # a batch computed against the pre-legacy rev is now stale -> 409
    res = _post_ops(
        seeded, [{"kind": "delete_element", "id": "a"}], base_rev=rev
    )
    assert res.status_code == 409
    # op_log was emptied: the recorded inverses no longer apply -> undo 409
    assert get_session().op_log == []
    assert _undo(seeded).status_code == 409
    # validation baseline dropped too (re-seeded lazily by the next batch)
    assert get_session().validation is None


def test_every_legacy_mutating_handler_bumps_model_rev(seeded: TestClient) -> None:
    rev = _rev()
    res = seeded.post(
        "/api/v1/model/elements",
        json={"type": "Item", "properties": {"name": "L"}},
    )
    assert res.status_code == 201, res.text
    eid = res.json()["id"]
    assert _rev() == rev + 1
    res = seeded.patch(
        f"/api/v1/model/elements/{eid}", json={"properties": {"note": "n"}}
    )
    assert res.status_code == 200, res.text
    assert _rev() == rev + 2
    res = seeded.post(
        "/api/v1/model/relationships",
        json={"type": "Links", "source_id": eid, "target_id": "c"},
    )
    assert res.status_code == 201, res.text
    rid = res.json()["id"]
    assert _rev() == rev + 3
    assert seeded.delete(f"/api/v1/model/relationships/{rid}").status_code == 204
    assert _rev() == rev + 4
    assert seeded.delete(f"/api/v1/model/elements/{eid}").status_code == 204
    assert _rev() == rev + 5


# --- reserved temp-id prefix at load time ----------------------------------------


def test_model_payload_rejects_reserved_tmp_element_id(client: TestClient) -> None:
    res = client.post(
        "/api/v1/model",
        json={
            "elements": [
                {"id": "tmp_weird", "type_name": "Item", "properties": {"name": "W"}}
            ],
            "relationships": [],
        },
    )
    assert res.status_code == 422, res.text
    assert "tmp_" in res.json()["detail"]
    assert "reserved" in res.json()["detail"]


def test_model_payload_rejects_reserved_tmp_relationship_id(client: TestClient) -> None:
    res = client.post(
        "/api/v1/model",
        json={
            "elements": [
                {"id": "a", "type_name": "Item", "properties": {"name": "A"}},
                {"id": "b", "type_name": "Item", "properties": {"name": "B"}},
            ],
            "relationships": [
                {
                    "id": "tmp_rel",
                    "type_name": "Links",
                    "source_id": "a",
                    "target_id": "b",
                }
            ],
        },
    )
    assert res.status_code == 422, res.text
    assert "tmp_" in res.json()["detail"]


# --- atomicity ----------------------------------------------------------------


def test_failed_batch_rolls_back_completely(seeded: TestClient) -> None:
    model = _model()
    rev = _rev()
    before = _snapshot(model)
    issues_before = _fresh_full_issues(model)
    # valid create + valid update, then an op that fails (unknown property)
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {"name": "X"},
            },
            {"kind": "update_element", "id": "a", "properties_patch": {"note": "boo"}},
            {"kind": "update_element", "id": "b", "properties_patch": {"ghost": 1}},
        ],
    )
    assert res.status_code == 422, res.text
    assert _rev() == rev
    assert _snapshot(model) == before  # entity counts, ids, properties
    assert _fresh_full_issues(model) == issues_before
    _assert_state_matches_full(model)  # issue store untouched by the rollback
    model.indexes.verify_consistent()
    assert get_session().op_log == []  # failed batches are not recorded


def test_failed_batch_rolls_back_mid_op_create(seeded: TestClient) -> None:
    # the FAILING op itself has partial effects: element created, then an
    # unknown property key aborts it — the half-initialized element must go
    model = _model()
    before = _snapshot(model)
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {"name": "X", "ghost": 1},
            }
        ],
    )
    assert res.status_code == 422, res.text
    assert _snapshot(model) == before
    model.indexes.verify_consistent()


def test_failed_batch_rolls_back_cascade_delete(seeded: TestClient) -> None:
    model = _model()
    before = _snapshot(model)
    res = _post_ops(
        seeded,
        [
            {"kind": "delete_element", "id": "a"},  # cascades to b, r-ab, r-ac
            {"kind": "delete_element", "id": "missing"},
        ],
    )
    assert res.status_code == 422, res.text
    assert _snapshot(model) == before
    model.indexes.verify_consistent()


def test_unexpected_exception_rolls_back_then_propagates(
    seeded: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # not a KeyError/ValueError (the validated 422 path): an arbitrary bug
    # mid-batch must still roll the model back before propagating as a 500
    model = _model()
    rev = _rev()
    before = _snapshot(model)
    orig = Model.set_property

    def boom(self: Model, target, prop, value) -> None:  # type: ignore[no-untyped-def]
        if prop == "note":
            raise RuntimeError("boom")
        orig(self, target, prop, value)

    monkeypatch.setattr(Model, "set_property", boom)
    with pytest.raises(RuntimeError, match="boom"):
        _post_ops(
            seeded,
            [
                # completes (records its inverse) ...
                {
                    "kind": "update_element",
                    "id": "a",
                    "properties_patch": {"name": "A2"},
                },
                # ... then the unexpected failure, before this op mutates
                {
                    "kind": "update_element",
                    "id": "b",
                    "properties_patch": {"note": "x"},
                },
            ],
        )
    assert _snapshot(model) == before  # first op rolled back
    assert _rev() == rev  # no bump
    assert get_session().op_log == []  # nothing recorded
    model.indexes.verify_consistent()


# --- cascade delete delta -------------------------------------------------------


def test_cascade_delete_delta_contents(seeded: TestClient) -> None:
    res = _post_ops(seeded, [{"kind": "delete_element", "id": "a"}])
    assert res.status_code == 200, res.text
    body = res.json()
    # a contains b -> both deleted; both incident relationships deleted
    assert body["deleted_element_ids"] == ["a", "b"]
    assert sorted(body["deleted_relationship_ids"]) == ["r-ab", "r-ac"]
    assert body["changed_elements"] == []
    assert body["changed_relationships"] == []
    model = _model()
    assert set(model.elements) == {"c"}
    assert model.relationships == {}


# --- undo ------------------------------------------------------------------------


def _assert_undo_roundtrip(client: TestClient, ops: list[dict]) -> None:
    model = _model()
    before = _snapshot(model)
    issues_before = _fresh_full_issues(model)
    rev = _rev()
    res = _post_ops(client, ops)
    assert res.status_code == 200, res.text
    res = _undo(client)
    assert res.status_code == 200, res.text
    assert res.json()["model_rev"] == rev + 2  # undo bumps the rev too
    assert _snapshot(model) == before  # ids restored exactly
    assert _fresh_full_issues(model) == issues_before
    _assert_state_matches_full(model)
    model.indexes.verify_consistent()


def test_undo_create_element(seeded: TestClient) -> None:
    _assert_undo_roundtrip(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {"name": "X"},
            }
        ],
    )


def test_undo_update_element(seeded: TestClient) -> None:
    # patch that replaces an existing key, adds a new one, and null-deletes:
    # inverse must restore prior values and re-delete added keys
    _assert_undo_roundtrip(
        seeded,
        [
            {
                "kind": "update_element",
                "id": "a",
                "properties_patch": {"name": "A2", "note": "added", "status": None},
            }
        ],
    )


def test_undo_delete_element_cascade(seeded: TestClient) -> None:
    # cascade: a, b, r-ab, r-ac all vanish and must come back with the SAME ids
    _assert_undo_roundtrip(seeded, [{"kind": "delete_element", "id": "a"}])


def test_undo_create_relationship(seeded: TestClient) -> None:
    _assert_undo_roundtrip(
        seeded,
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Links",
                "source_id": "b",
                "target_id": "c",
                "properties": {"weight": 4},
            }
        ],
    )


def test_undo_update_relationship(seeded: TestClient) -> None:
    _assert_undo_roundtrip(
        seeded,
        [
            {
                "kind": "update_relationship",
                "id": "r-ac",
                "properties_patch": {"weight": None},
            }
        ],
    )


def test_undo_delete_relationship(seeded: TestClient) -> None:
    _assert_undo_roundtrip(seeded, [{"kind": "delete_relationship", "id": "r-ac"}])


def test_undo_mixed_batch(seeded: TestClient) -> None:
    _assert_undo_roundtrip(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {"name": "X"},
            },
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Links",
                "source_id": "tmp_x",
                "target_id": "c",
                "properties": {},
            },
            {"kind": "update_element", "id": "c", "properties_patch": {"note": "n"}},
            {"kind": "delete_element", "id": "a"},
        ],
    )


def test_undo_delete_reports_restored_entities_as_changed(seeded: TestClient) -> None:
    res = _post_ops(seeded, [{"kind": "delete_element", "id": "a"}])
    assert res.status_code == 200, res.text
    res = _undo(seeded)
    assert res.status_code == 200, res.text
    body = res.json()
    assert sorted(e["id"] for e in body["changed_elements"]) == ["a", "b"]
    assert sorted(r["id"] for r in body["changed_relationships"]) == ["r-ab", "r-ac"]
    assert body["deleted_element_ids"] == []
    assert body["id_map"] == {}  # restores reuse original ids, no remapping


def test_multi_batch_undo_walks_history(seeded: TestClient) -> None:
    model = _model()
    snap0 = _snapshot(model)
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {"name": "X"},
            }
        ],
    )
    assert res.status_code == 200
    snap1 = _snapshot(model)
    res = _post_ops(
        seeded,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "z"}}],
    )
    assert res.status_code == 200
    assert _undo(seeded).status_code == 200  # back to after batch 1
    assert _snapshot(model) == snap1
    assert _undo(seeded).status_code == 200  # back to the start
    assert _snapshot(model) == snap0
    assert _undo(seeded).status_code == 409  # history exhausted
    model.indexes.verify_consistent()
    _assert_state_matches_full(model)


# --- issues delta -----------------------------------------------------------------


def test_issue_delta_violation_then_fix(seeded: TestClient) -> None:
    # Item.name has multiplicity 1: creating without it adds an issue
    res = _post_ops(
        seeded,
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {},
            }
        ],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    new_id = body["id_map"]["tmp_x"]
    assert any(new_id in i["target_ids"] for i in body["issues_added"])
    assert body["issue_counts"].get("error", 0) >= 1
    # fixing op: the owner's issues are dropped and nothing re-added
    res = _post_ops(
        seeded,
        [{"kind": "update_element", "id": new_id, "properties_patch": {"name": "X"}}],
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert new_id in body["issues_removed_owner_ids"]
    assert all(new_id not in i["target_ids"] for i in body["issues_added"])
    assert body["issue_counts"] == {}
    _assert_state_matches_full(_model())


def test_differential_validation_matches_full_after_many_batches(
    seeded: TestClient,
) -> None:
    batches = [
        [
            {
                "kind": "create_element",
                "temp_id": "tmp_x",
                "type_name": "Item",
                "properties": {},  # missing required name
            }
        ],
        [{"kind": "update_element", "id": "c", "properties_patch": {"name": "A"}}],
        # ^ duplicate key with a (both named "A", both top-level) -> uniqueness
        [{"kind": "delete_element", "id": "c"}],  # duplicate gone again
        [{"kind": "update_element", "id": "a", "properties_patch": {"name": "A2"}}],
        # NOTE: no containment cycles here — scoped cycle detection reports
        # dirty-entity representatives, a documented divergence from full runs
        [
            {
                "kind": "create_relationship",
                "temp_id": "tmp_r",
                "type_name": "Links",
                "source_id": "b",
                "target_id": "a",
                "properties": {},
            }
        ],
    ]
    for ops in batches:
        res = _post_ops(seeded, ops)
        assert res.status_code == 200, res.text
    _assert_state_matches_full(_model())
    _model().indexes.verify_consistent()


def test_op_log_trims_oldest_and_undo_walks_remainder(
    seeded: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_module, "OP_LOG_MAX", 2)
    model = _model()
    snaps = [_snapshot(model)]
    for i in range(4):
        res = _post_ops(
            seeded,
            [
                {
                    "kind": "update_element",
                    "id": "a",
                    "properties_patch": {"note": f"n{i}"},
                }
            ],
        )
        assert res.status_code == 200, res.text
        snaps.append(_snapshot(model))
    # only the newest OP_LOG_MAX batches are retained (oldest dropped first)
    log = get_session().op_log
    assert len(log) == 2
    assert log[0].ops[0].properties_patch == {"note": "n2"}  # type: ignore[union-attr]
    assert log[1].ops[0].properties_patch == {"note": "n3"}  # type: ignore[union-attr]
    # undo walks back exactly through the retained remainder...
    assert _undo(seeded).status_code == 200
    assert _snapshot(model) == snaps[3]
    assert _undo(seeded).status_code == 200
    assert _snapshot(model) == snaps[2]
    # ...and stops where history was trimmed
    assert _undo(seeded).status_code == 409
    assert _snapshot(model) == snaps[2]
    model.indexes.verify_consistent()


def test_op_log_records_batches_and_failed_undo_is_impossible(
    seeded: TestClient,
) -> None:
    res = _post_ops(
        seeded,
        [{"kind": "update_element", "id": "a", "properties_patch": {"note": "x"}}],
    )
    assert res.status_code == 200
    log = get_session().op_log
    assert len(log) == 1
    batch = log[0]
    assert [op.kind for op in batch.ops] == ["update_element"]
    assert [op.kind for op in batch.inverse_ops] == ["update_element"]
    assert batch.inverse_ops[0].properties_patch == {"note": None}  # type: ignore[union-attr]
