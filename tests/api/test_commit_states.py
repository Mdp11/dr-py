"""Per-batch entity-state capture: the applier snapshots every touched
entity's pre-mutation state on first touch, and ``capture_entity_states``
pairs it with the post-apply state for the journal row."""

from __future__ import annotations

import pytest

from data_rover.api import commit_states
from data_rover.api.commit_states import (
    EntityStates,
    capture_entity_states,
    load_entity_states,
)
from data_rover.api.routes.ops import _apply_batch
from data_rover.api.schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ElementOut,
    ModelOpIn,
    UpdateElementOp,
    UpdateRelationshipOp,
)
from data_rover.core.metamodel.loader import load_metamodel_str
from data_rover.core.model.model import Model

_MM = """
elements:
  - name: Node
    properties:
      - name: label
        datatype: string
      - name: meta
        datatype: string
relationships:
  - name: Contains
    containment: true
    source: Node
    target: Node
    properties:
      - name: note
        datatype: string
"""


def _model() -> Model:
    return Model(load_metamodel_str(_MM))


def _create(temp_id: str, **props: object) -> CreateElementOp:
    return CreateElementOp(
        kind="create_element", temp_id=temp_id, type_name="Node", properties=dict(props)
    )


def test_create_records_no_before_and_full_after() -> None:
    m = _model()
    res = _apply_batch(m, [_create("tmp_a", label="a")], restore=False)
    eid = res.id_map["tmp_a"]
    assert res.before_elements == {eid: None}
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"][eid]["before"] is None
    assert states["elements"][eid]["after"] == ElementOut.from_core(
        m.elements[eid]
    ).model_dump(mode="json")
    assert states["relationships"] == {}


def test_update_snapshots_the_pre_mutation_state_once() -> None:
    m = _model()
    eid = _apply_batch(m, [_create("tmp_a", label="a")], restore=False).id_map["tmp_a"]
    ops: list[ModelOpIn] = [
        UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "b"}),
        UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "c"}),
    ]
    res = _apply_batch(m, ops, restore=False)
    before = res.before_elements[eid]
    assert before is not None and before.properties == {"label": "a"}  # first touch wins
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"][eid]["before"]["properties"] == {"label": "a"}
    assert states["elements"][eid]["after"]["properties"] == {"label": "c"}


def test_before_snapshot_does_not_alias_the_live_properties() -> None:
    m = _model()
    eid = _apply_batch(m, [_create("tmp_a", meta="x")], restore=False).id_map["tmp_a"]
    res = _apply_batch(
        m,
        [UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "b"})],
        restore=False,
    )
    m.elements[eid].properties["meta"] = "mutated-in-place"
    before = res.before_elements[eid]
    assert before is not None and before.properties["meta"] == "x"


def test_cascade_delete_captures_every_victim() -> None:
    m = _model()
    setup = _apply_batch(
        m,
        [
            _create("tmp_p", label="p"),
            _create("tmp_c", label="c"),
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Contains",
                source_id="tmp_p",
                target_id="tmp_c",
                properties={"note": "n"},
            ),
        ],
        restore=False,
    )
    p, c, r = (setup.id_map[k] for k in ("tmp_p", "tmp_c", "tmp_r"))
    res = _apply_batch(m, [DeleteElementOp(kind="delete_element", id=p)], restore=False)
    states = capture_entity_states(m, res)
    assert states is not None
    assert set(states["elements"]) == {p, c}
    assert set(states["relationships"]) == {r}
    for entry in (*states["elements"].values(), *states["relationships"].values()):
        assert entry["before"] is not None and entry["after"] is None
    assert states["elements"][c]["before"]["properties"] == {"label": "c"}
    assert states["relationships"][r]["before"]["properties"] == {"note": "n"}


def test_create_then_delete_in_one_batch_is_none_none() -> None:
    m = _model()
    res = _apply_batch(
        m,
        [_create("tmp_a", label="a"), DeleteElementOp(kind="delete_element", id="tmp_a")],
        restore=False,
    )
    eid = res.id_map["tmp_a"]
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"][eid] == {"before": None, "after": None}


def test_relationship_update_and_delete() -> None:
    m = _model()
    setup = _apply_batch(
        m,
        [
            _create("tmp_p"),
            _create("tmp_c"),
            CreateRelationshipOp(
                kind="create_relationship",
                temp_id="tmp_r",
                type_name="Contains",
                source_id="tmp_p",
                target_id="tmp_c",
                properties={"note": "n1"},
            ),
        ],
        restore=False,
    )
    r = setup.id_map["tmp_r"]
    res = _apply_batch(
        m,
        [UpdateRelationshipOp(kind="update_relationship", id=r, properties_patch={"note": "n2"})],
        restore=False,
    )
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["elements"] == {}
    assert states["relationships"][r]["before"]["properties"] == {"note": "n1"}
    assert states["relationships"][r]["after"]["properties"] == {"note": "n2"}
    res = _apply_batch(m, [DeleteRelationshipOp(kind="delete_relationship", id=r)], restore=False)
    states = capture_entity_states(m, res)
    assert states is not None
    assert states["relationships"][r]["before"]["properties"] == {"note": "n2"}
    assert states["relationships"][r]["after"] is None


def test_over_cap_batch_captures_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(commit_states, "ENTITY_STATES_MAX", 1)
    m = _model()
    res = _apply_batch(m, [_create("tmp_a"), _create("tmp_b")], restore=False)
    assert capture_entity_states(m, res) is None
    res = _apply_batch(m, [_create("tmp_c")], restore=False)
    assert capture_entity_states(m, res) is not None  # exactly at the cap is fine


def test_load_round_trips_capture() -> None:
    m = _model()
    eid = _apply_batch(m, [_create("tmp_a", label="a")], restore=False).id_map["tmp_a"]
    res = _apply_batch(
        m,
        [UpdateElementOp(kind="update_element", id=eid, properties_patch={"label": "b"})],
        restore=False,
    )
    raw = capture_entity_states(m, res)
    assert raw is not None
    loaded = load_entity_states(raw)
    assert isinstance(loaded, EntityStates)
    before, after = loaded.elements[eid]
    assert before is not None and after is not None
    assert before.properties == {"label": "a"} and after.properties == {"label": "b"}
    assert after == ElementOut.from_core(m.elements[eid])
    assert loaded.relationships == {}
