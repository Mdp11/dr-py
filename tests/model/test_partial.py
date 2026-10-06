"""A partial ``Model`` answers from the rows it was loaded with and refuses
every other read (``NotLoaded``), so a check on it cannot be answered from
data it does not hold."""

from __future__ import annotations

import copy
import dataclasses
import random
from collections.abc import Mapping, Sequence
from typing import Any

import pytest
from fastapi import HTTPException

from data_rover.api.locking import required_locks
from data_rover.api.routes.commits import _structural_ids
from data_rover.api.routes.ops import _apply_batch, _BatchResult, _rollback
from data_rover.api.schemas import (
    CreateElementOp,
    CreateRelationshipOp,
    DeleteElementOp,
    DeleteRelationshipOp,
    ModelOpIn,
    UpdateElementOp,
    UpdateRelationshipOp,
)
from data_rover.api.structural import structural_blockers
from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.element import Element
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.model.partial import (
    NotLoaded,
    PartialRows,
    WholeModelRead,
    build_partial_model,
)
from data_rover.core.validation.pipeline import ValidationPipeline
from data_rover.core.validation.validators.containment import ContainmentValidator


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Item",
                key=["name"],
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="ref", datatype="Item"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Holds", containment=True, source="Item", target="Item"
            ),
            RelationshipType(
                name="Link",
                source="Item",
                target="Item",
                properties=[PropertyDef(name="label", datatype="string")],
            ),
        ],
    )


def _el(eid: str, **props: Any) -> dict[str, Any]:
    return {"id": eid, "type_name": "Item", "properties": props, "rev": 0}


def _rel(rid: str, type_name: str, source: str, target: str) -> dict[str, Any]:
    return {
        "id": rid,
        "type_name": type_name,
        "source_id": source,
        "target_id": target,
        "properties": {},
        "rev": 0,
    }


def _rows(**overrides: Any) -> PartialRows:
    """p holds c (h1); q links to c (l1). Loaded: p, c, q. ``c`` has every
    incident relationship loaded, ``q`` and ``p`` only the ones listed."""
    base: dict[str, Any] = {
        "elements": [_el("p", name="p"), _el("c", name="c"), _el("q", name="q")],
        "relationships": [
            _rel("h1", "Holds", "p", "c"),
            _rel("l1", "Link", "q", "c"),
        ],
        "absent": frozenset({"x"}),
        "edges_complete": frozenset({"c"}),
        "parents_complete": frozenset({"c"}),
        "referencers_complete": frozenset({"c"}),
    }
    base.update(overrides)
    return PartialRows(**base)


def _partial(**overrides: Any) -> Model:
    return build_partial_model(_mm(), _rows(**overrides))


# --- entity dicts -----------------------------------------------------------


def test_loaded_ids_answer_as_usual() -> None:
    m = _partial()
    assert "p" in m.elements
    assert m.get_element("c").properties == {"name": "c"}
    assert m.relationships["h1"].target_id == "c"
    assert m.elements.get("q") is not None


def test_absent_id_answers_absent() -> None:
    m = _partial()
    assert "x" not in m.elements
    assert "x" not in m.relationships
    assert m.elements.get("x") is None
    assert m.elements.get("x", 7) == 7
    with pytest.raises(KeyError):
        m.get_element("x")
    with pytest.raises(KeyError):
        m.elements["x"]
    with pytest.raises(KeyError):
        m.get_relationship("x")


def test_an_id_loaded_in_the_other_table_is_not_in_this_one() -> None:
    m = _partial()
    assert "h1" not in m.elements
    assert "p" not in m.relationships
    with pytest.raises(KeyError):
        m.get_element("h1")


def test_unknown_id_raises_not_loaded() -> None:
    m = _partial()
    with pytest.raises(NotLoaded) as info:
        assert "y" in m.elements
    assert info.value.ids == {"y"}
    with pytest.raises(NotLoaded):
        m.elements.get("y")
    with pytest.raises(NotLoaded):
        m.elements["y"]
    with pytest.raises(NotLoaded):
        m.get_element("y")
    with pytest.raises(NotLoaded) as info:
        assert "z" in m.relationships
    assert info.value.ids == {"z"}
    with pytest.raises(NotLoaded):
        m.get_relationship("z")


def test_not_loaded_is_neither_a_key_error_nor_a_value_error() -> None:
    # _apply_batch maps those two to a 422
    assert not issubclass(NotLoaded, (KeyError, ValueError))
    assert NotLoaded(["b", "a"]).ids == frozenset({"a", "b"})


# --- accessors --------------------------------------------------------------


def test_edges_need_edges_complete() -> None:
    m = _partial()
    assert set(m.indexes.incoming_ids("c")) == {"h1", "l1"}
    assert set(m.indexes.outgoing_ids("c")) == set()
    for accessor in (m.indexes.outgoing_ids, m.indexes.incoming_ids):
        with pytest.raises(NotLoaded) as info:
            accessor("q")
        assert info.value.ids == {"q"}
    with pytest.raises(NotLoaded):
        m.indexes.count_out("q", "Link")
    with pytest.raises(NotLoaded):
        m.indexes.count_in("p", "Holds")
    assert m.indexes.count_in("c", "Link") == 1


def test_parents_need_parents_complete_or_edges_complete() -> None:
    m = _partial(edges_complete=frozenset({"p"}), parents_complete=frozenset({"c"}))
    assert m.indexes.first_parent("c") == "p"
    assert list(m.indexes.parents_of("c")) == ["p"]
    assert m.indexes.first_parent("p") is None  # p is edges_complete
    with pytest.raises(NotLoaded):
        m.indexes.first_parent("q")
    with pytest.raises(NotLoaded):
        m.indexes.parents_of("q")
    # parents_complete does not stand for the edges
    with pytest.raises(NotLoaded):
        m.indexes.incoming_ids("c")


def test_container_of_goes_through_the_guard() -> None:
    m = _partial()
    assert m.container_of("c") == "p"
    with pytest.raises(NotLoaded):
        m.container_of("q")


def test_referencers_need_referencers_complete() -> None:
    m = _partial(
        elements=[_el("p"), _el("c"), _el("q", ref="c")],
        referencers_complete=frozenset({"c"}),
    )
    assert set(m.indexes.referencers_of("c")) == {"q"}
    with pytest.raises(NotLoaded):
        m.indexes.referencers_of("p")


def test_absent_id_has_no_edges_or_parents_but_unknown_referencers() -> None:
    m = _partial()
    assert set(m.indexes.outgoing_ids("x")) == set()
    assert set(m.indexes.incoming_ids("x")) == set()
    assert m.indexes.first_parent("x") is None
    with pytest.raises(NotLoaded):
        m.indexes.referencers_of("x")


def test_a_relationship_id_has_no_edges_or_parents_but_unknown_referencers() -> None:
    m = _partial()
    assert set(m.indexes.outgoing_ids("h1")) == set()
    assert set(m.indexes.incoming_ids("h1")) == set()
    assert m.indexes.first_parent("h1") is None
    with pytest.raises(NotLoaded):
        m.indexes.referencers_of("h1")


def test_unknown_id_is_not_loaded_for_every_accessor() -> None:
    m = _partial()
    for accessor in (
        m.indexes.outgoing_ids,
        m.indexes.incoming_ids,
        m.indexes.parents_of,
        m.indexes.first_parent,
        m.indexes.referencers_of,
    ):
        with pytest.raises(NotLoaded) as info:
            accessor("y")
        assert info.value.ids == {"y"}


def test_model_helpers_read_through_the_guard() -> None:
    m = _partial()
    assert {r.id for r in m.relationships_to("c")} == {"h1", "l1"}
    with pytest.raises(NotLoaded):
        m.relationships_from("q")
    with pytest.raises(NotLoaded):
        m.relationships_to("q")
    with pytest.raises(NotLoaded):
        m._containment_children("q")


# --- the model's own life ---------------------------------------------------


def test_created_element_answers_every_accessor() -> None:
    m = _partial(referencers_complete=frozenset({"c", "x"}))
    inserted = m.insert_element("x", "Item", {"name": "n"}, 0)  # a known-absent id
    created = m.create_element("Item")
    for eid in (inserted.id, created.id):
        assert eid in m.elements
        assert set(m.indexes.outgoing_ids(eid)) == set()
        assert set(m.indexes.incoming_ids(eid)) == set()
        assert m.indexes.first_parent(eid) is None
        assert list(m.indexes.parents_of(eid)) == []
        assert set(m.indexes.referencers_of(eid)) == set()
        assert m.indexes.count_out(eid, "Link") == 0
    # an id the loader never queried cannot be inserted: its absence is unknown
    with pytest.raises(NotLoaded) as info:
        m.insert_element("n1", "Item", {}, 0)
    assert info.value.ids == {"n1"}
    # the new elements' relationships show up in their edges
    rel = m.connect("Link", "x", created.id)
    assert set(m.indexes.outgoing_ids("x")) == {rel.id}
    assert set(m.indexes.incoming_ids(created.id)) == {rel.id}
    # while an element that was loaded without its edges stays unanswered
    with pytest.raises(NotLoaded):
        m.indexes.outgoing_ids("q")


def test_an_element_created_under_an_absent_id_still_needs_its_referencers() -> None:
    # the loader found no "x", but the database may hold a dangling reference
    # to it; creating it (edges and parents are then complete) does not tell
    m = _partial()
    m.insert_element("x", "Item", {}, 0)
    assert set(m.indexes.outgoing_ids("x")) == set()
    assert m.indexes.first_parent("x") is None
    with pytest.raises(NotLoaded) as info:
        m.indexes.referencers_of("x")
    assert info.value.ids == {"x"}
    # a fresh id has no referencer anywhere
    assert set(m.indexes.referencers_of(m.create_element("Item").id)) == set()


def test_created_element_has_the_referencers_it_gained() -> None:
    m = _partial(referencers_complete=frozenset({"c", "x"}))
    inserted = m.insert_element("x", "Item", {}, 0)
    holder = m.create_element("Item")
    m.set_property(holder, "ref", inserted.id)
    assert set(m.indexes.referencers_of("x")) == {holder.id}


def test_a_relationship_to_an_incomplete_element_leaves_it_incomplete() -> None:
    m = _partial()
    m.connect("Link", "c", "q")
    assert len(m.indexes.incoming_ids("c")) == 2
    with pytest.raises(NotLoaded):
        m.indexes.incoming_ids("q")


def test_deleted_element_answers_absent_afterwards() -> None:
    m = _partial(edges_complete=frozenset({"c", "q"}))
    m.delete_element("q")
    assert "q" not in m.elements
    assert m.elements.get("q") is None
    with pytest.raises(KeyError):
        m.get_element("q")
    assert "l1" not in m.relationships  # its relationship went with it
    assert set(m.indexes.outgoing_ids("q")) == set()


def test_deleted_relationship_answers_absent_afterwards() -> None:
    m = _partial()
    m.disconnect("l1")
    assert "l1" not in m.relationships
    with pytest.raises(KeyError):
        m.get_relationship("l1")
    assert set(m.indexes.incoming_ids("c")) == {"h1"}


def test_the_loaded_properties_are_copied() -> None:
    props = {"name": "p"}
    p_row = {"id": "p", "type_name": "Item", "properties": props, "rev": 0}
    m = build_partial_model(_mm(), _rows(elements=[p_row, _el("c"), _el("q")]))
    m.set_property(m.get_element("p"), "name", "other")
    assert props == {"name": "p"}


# --- uniqueness is the engine's ---------------------------------------------


def test_uniqueness_groups_are_not_kept() -> None:
    m = build_partial_model(
        _mm(),
        _rows(elements=[_el("p", name="same"), _el("c", name="same"), _el("q")]),
    )
    idx = m.indexes
    assert not idx.uniq_groups and not idx.uniq_key_of and not idx.duplicate_keys
    n = m.create_element("Item")
    m.set_property(n, "name", "same")
    rel = m.connect("Holds", "p", n.id)
    m.disconnect(rel.id)
    assert not idx.uniq_groups and not idx.uniq_key_of and not idx.duplicate_keys


# --- whole-model reads ------------------------------------------------------


def test_enumerating_the_entity_dicts_is_refused() -> None:
    m = _partial()
    for read in (
        lambda: list(m.elements),
        lambda: list(m.elements.values()),
        lambda: list(m.relationships.items()),
        lambda: list(m.relationships.keys()),
        lambda: len(m.elements),
        lambda: len(m.relationships),
        lambda: bool(m.elements),
    ):
        with pytest.raises(WholeModelRead):
            read()
    assert not issubclass(WholeModelRead, (KeyError, ValueError))
    with pytest.raises(WholeModelRead):
        m.indexes.roots_count()
    with pytest.raises(WholeModelRead):
        list(m.indexes.iter_roots())
    with pytest.raises(WholeModelRead):
        ValidationPipeline([ContainmentValidator()]).validate(m)


def test_the_entity_dicts_take_writes_from_the_model_only() -> None:
    m = _partial()
    with pytest.raises(TypeError):
        m.elements.setdefault("y", Element(id="y", type_name="Item"))
    with pytest.raises(TypeError):
        m.relationships.popitem()
    with pytest.raises(NotLoaded):
        assert "y" in m.elements


def _dangling_ref_batch() -> list[ModelOpIn]:
    return [
        CreateElementOp(
            kind="create_element", temp_id="tmp_1", type_name="Item", id="X"
        ),
        DeleteElementOp(kind="delete_element", id="tmp_1"),
    ]


def test_deleting_an_element_created_under_an_absent_id_sees_its_referencers() -> None:
    # p holds a reference to "X", which does not exist. Creating X and deleting
    # it again leaves p dangling as before, but the check must reach p to say so.
    rows = _rows(
        elements=[_el("p", name="p", ref="X"), _el("c"), _el("q")],
        absent=frozenset({"X"}),
        edges_complete=frozenset({"c", "p"}),
    )
    full = _full_model(rows.elements, rows.relationships)
    res = _apply_batch(full, _dangling_ref_batch(), restore=False)
    want = structural_blockers(full, _structural_ids(full, res))
    assert [i.target_ids for i in want] == [["p"]]

    # the loader has not loaded p, nor X's referencers: the answer is withheld
    unloaded = _rows(absent=frozenset({"X"}))
    m = build_partial_model(_mm(), unloaded)
    with pytest.raises(NotLoaded) as info:
        _apply_batch(m, _dangling_ref_batch(), restore=False)
    assert info.value.ids == {"X"}

    # once it has, the partial model gives the full model's blockers
    loaded = dataclasses.replace(
        rows, referencers_complete=rows.referencers_complete | {"X"}
    )
    m = build_partial_model(_mm(), loaded)
    res = _apply_batch(m, _dangling_ref_batch(), restore=False)
    assert structural_blockers(m, _structural_ids(m, res)) == want


def _rel_id_batch(restore: bool) -> list[ModelOpIn]:
    """A relationship goes, an element takes its id and goes in turn."""
    made = "R" if restore else "tmp_1"
    return [
        DeleteRelationshipOp(kind="delete_relationship", id="R"),
        CreateElementOp(
            kind="create_element",
            temp_id=made,
            type_name="Item",
            id=None if restore else "R",
        ),
        DeleteElementOp(kind="delete_element", id=made),
    ]


@pytest.mark.parametrize("restore", [False, True])
def test_an_element_created_under_a_relationship_id_sees_its_referencers(
    restore: bool,
) -> None:
    # p holds a reference to "R", which is a relationship, so it points to no
    # element. The database can hold such references to any id it has held.
    elements = [_el("P", name="p", ref="R"), _el("A"), _el("B")]
    rels = [_rel("R", "Link", "A", "B")]
    full = _full_model(elements, rels)
    res = _apply_batch(full, _rel_id_batch(restore), restore=restore)
    want = structural_blockers(full, _structural_ids(full, res))
    assert [i.target_ids for i in want] == [["P"]]

    rows = PartialRows(
        elements=elements[1:],
        relationships=rels,
        absent=frozenset(),
        edges_complete=frozenset({"A", "B"}),
        parents_complete=frozenset(),
        referencers_complete=frozenset(),
    )
    m = build_partial_model(_mm(), rows)
    before = _state(m)
    with pytest.raises(NotLoaded) as info:
        _apply_batch(m, _rel_id_batch(restore), restore=restore)
    assert info.value.ids == {"R"}
    assert _state(m) == before  # rolled back, the relationship included

    rows = dataclasses.replace(
        rows,
        elements=elements,
        edges_complete=frozenset({"A", "B", "P"}),
        referencers_complete=frozenset({"R"}),
    )
    m = build_partial_model(_mm(), rows)
    res = _apply_batch(m, _rel_id_batch(restore), restore=restore)
    assert structural_blockers(m, _structural_ids(m, res)) == want


def test_a_generated_id_has_no_referencer_outside_the_model() -> None:
    m = _partial()
    made = m.create_element("Item")
    assert set(m.indexes.referencers_of(made.id)) == set()
    # an id the model's generator made is the only one; a loaded element's id
    # or a restored one is not
    with pytest.raises(NotLoaded):
        m.indexes.referencers_of("p")


def test_entity_dicts_refuse_comparison() -> None:
    m = _partial()
    with pytest.raises(WholeModelRead):
        assert m.elements == {}
    with pytest.raises(WholeModelRead):
        assert m.relationships != {}


def test_build_refuses_rows_that_break_the_contract() -> None:
    with pytest.raises(ValueError, match="endpoint"):
        _partial(relationships=[_rel("l9", "Link", "q", "nowhere")])
    with pytest.raises(ValueError, match="absent"):
        _partial(absent=frozenset({"p"}))
    with pytest.raises(ValueError, match="edges_complete"):
        _partial(edges_complete=frozenset({"nowhere"}))
    with pytest.raises(ValueError, match="parents_complete"):
        _partial(parents_complete=frozenset({"nowhere"}))
    with pytest.raises(ValueError, match="duplicate"):
        _partial(elements=[_el("p"), _el("p"), _el("c"), _el("q")])


def test_a_full_model_is_unguarded() -> None:
    m = Model(_mm())
    assert type(m.elements) is dict and type(m.relationships) is dict
    assert "anything" not in m.elements
    assert set(m.indexes.outgoing_ids("anything")) == set()
    assert m.indexes.first_parent("anything") is None
    assert set(m.indexes.referencers_of("anything")) == set()


# --- the batch applier ------------------------------------------------------


def test_apply_batch_on_an_unloaded_id_raises_not_loaded_and_rolls_back() -> None:
    m = _partial()
    before = _state(m)
    q = m.get_element("q")
    ops: list[ModelOpIn] = [
        UpdateElementOp(kind="update_element", id="q", properties_patch={"name": "Q"}),
        UpdateElementOp(kind="update_element", id="y", properties_patch={"name": "Y"}),
    ]
    with pytest.raises(NotLoaded) as info:
        _apply_batch(m, ops, restore=False)
    assert info.value.ids == {"y"}
    assert q.properties == {"name": "q"} and q.rev == 0  # rolled back
    assert _state(m) == before


def test_apply_batch_still_maps_a_missing_known_absent_id_to_422() -> None:
    m = _partial()
    ops: list[ModelOpIn] = [
        UpdateElementOp(kind="update_element", id="x", properties_patch={"name": "Y"})
    ]
    with pytest.raises(HTTPException) as info:
        _apply_batch(m, ops, restore=False)
    assert info.value.status_code == 422


def test_delete_whose_cascade_reaches_unloaded_edges_changes_nothing() -> None:
    # p's edges are loaded, c (its child) has them only as far as parents
    m = _partial(edges_complete=frozenset({"p"}), parents_complete=frozenset({"c"}))
    ops: list[ModelOpIn] = [
        UpdateElementOp(kind="update_element", id="q", properties_patch={"name": "Q"}),
        DeleteElementOp(kind="delete_element", id="p"),
    ]
    snapshot = _state(m)
    with pytest.raises(NotLoaded) as info:
        _apply_batch(m, ops, restore=False)
    assert info.value.ids == {"c"}
    assert _state(m) == snapshot


def test_a_connect_to_an_unloaded_endpoint_is_not_loaded_not_422() -> None:
    m = _partial()
    ops: list[ModelOpIn] = [
        CreateRelationshipOp(
            kind="create_relationship",
            temp_id="tmp_r",
            type_name="Link",
            source_id="c",
            target_id="y",
        )
    ]
    with pytest.raises(NotLoaded):
        _apply_batch(m, ops, restore=False)
    ops[0] = ops[0].model_copy(update={"target_id": "x"})  # known absent
    with pytest.raises(HTTPException) as info:
        _apply_batch(m, ops, restore=False)
    assert info.value.status_code == 422


def test_settle_order_keeps_the_guards() -> None:
    everything = frozenset({"p", "c", "q"})
    m = _partial(edges_complete=everything, referencers_complete=everything)
    elements, relationships = m.elements, m.relationships
    order = list(dict.keys(m.elements))
    rel_order = list(dict.keys(m.relationships))
    ops: list[ModelOpIn] = [
        DeleteElementOp(kind="delete_element", id="p"),  # not the last one
        UpdateElementOp(kind="update_element", id="y", properties_patch={}),
    ]
    with pytest.raises(NotLoaded):
        _apply_batch(m, ops, restore=False)  # rollback puts p and h1 back
    assert list(dict.keys(m.elements)) == order
    assert list(dict.keys(m.relationships)) == rel_order
    assert m.elements is elements and m.relationships is relationships
    with pytest.raises(NotLoaded):
        assert "y" in m.elements
    assert "x" not in m.elements
    assert "p" in m.elements


def test_settle_order_still_replaces_the_dicts_of_a_full_model() -> None:
    m = Model(_mm())
    ids = [m.create_element("Item").id for _ in range(3)]
    elements = m.elements
    ops: list[ModelOpIn] = [DeleteElementOp(kind="delete_element", id=ids[0])]
    res = _apply_batch(m, ops, restore=False)
    _rollback(m, res)
    assert list(m.elements) == ids
    assert m.elements is not elements  # readers holding the old dict see it whole


# --- the checks that ride on the model --------------------------------------


def test_structural_check_distinguishes_absent_from_not_loaded() -> None:
    m = _partial(
        elements=[
            _el("p", name="p", ref="x"),  # x is known absent: dangling
            _el("c", name="c"),
            _el("q", name="q", ref="y"),  # y is unknown
        ],
        edges_complete=frozenset({"p", "c"}),
    )
    issues = structural_blockers(m, ["p"])
    assert [i.message for i in issues] == [
        "Item.ref: reference 'x' points to no element"
    ]
    with pytest.raises(NotLoaded) as info:
        structural_blockers(m, ["q"])
    assert info.value.ids == {"y"}


def test_structural_check_sees_a_second_parent_only_when_parents_are_loaded() -> None:
    rows = _rows(
        elements=[_el("p"), _el("q"), _el("c")],
        relationships=[_rel("h1", "Holds", "p", "c"), _rel("h2", "Holds", "q", "c")],
        edges_complete=frozenset({"p", "q"}),
        parents_complete=frozenset({"c"}),
    )
    issues = structural_blockers(build_partial_model(_mm(), rows), ["c"])
    assert len(issues) == 1 and "2 containment parents" in issues[0].message
    # with c's parents not loaded the check cannot answer
    rows = dataclasses.replace(rows, parents_complete=frozenset())
    with pytest.raises(NotLoaded) as info:
        structural_blockers(build_partial_model(_mm(), rows), ["c"])
    assert info.value.ids == {"c"}


def test_structural_check_walks_the_ancestor_chain_through_the_guard() -> None:
    # a -> b -> c (Holds); a new edge c -> a closes a cycle
    elements = [_el("a"), _el("b"), _el("c")]
    rels = [_rel("h1", "Holds", "a", "b"), _rel("h2", "Holds", "b", "c")]
    full = frozenset({"a", "b", "c"})
    m = build_partial_model(
        _mm(),
        PartialRows(elements, rels, frozenset(), full, full, full),
    )
    m.connect("Holds", "c", "a")
    issues = structural_blockers(m, ["c"])
    assert any("cycle" in i.message for i in issues)
    # the chain's top is not known to be the top: the answer is withheld
    m = build_partial_model(
        _mm(),
        PartialRows(
            elements,
            rels,
            frozenset(),
            frozenset({"b", "c"}),
            frozenset({"b", "c"}),
            full,
        ),
    )
    with pytest.raises(NotLoaded) as info:
        structural_blockers(m, ["c"])
    assert info.value.ids == {"a"}


def test_required_locks_read_through_the_guard() -> None:
    m = _partial()
    ops: list[Any] = [
        UpdateRelationshipOp(
            kind="update_relationship", id="l1", properties_patch={"label": "x"}
        )
    ]
    assert [r.resource_id for r in required_locks(m, {}, ops)] == ["q"]
    ops = [
        UpdateRelationshipOp(
            kind="update_relationship", id="l9", properties_patch={"label": "x"}
        )
    ]
    with pytest.raises(NotLoaded):
        required_locks(m, {}, ops)
    ops = [DeleteElementOp(kind="delete_element", id="q")]
    with pytest.raises(NotLoaded):
        required_locks(m, {}, ops)


# --- parity with a full model -----------------------------------------------

_GHOSTS = [f"g{i}" for i in range(4)]
_HINTS = [f"h{i}" for i in range(10)]


def _seed_rows(rng: random.Random) -> tuple[list[dict], list[dict]]:
    seed = Model(_mm(), SequentialIdGenerator("s"))
    items = []
    for i in range(12):
        e = seed.create_element("Item")
        seed.set_property(e, "name", f"n{i % 5}")
        items.append(e.id)
    for _ in range(4):
        a, b = rng.sample(items, 2)
        if seed.indexes.first_parent(b) is None and a != b:
            seed.connect("Holds", a, b)
    for _ in range(5):
        r = seed.connect("Link", rng.choice(items), rng.choice(items))
        seed.set_property(r, "label", "l")
    elements = [
        {
            "id": e.id,
            "type_name": e.type_name,
            "properties": dict(e.properties),
            "rev": e.rev,
        }
        for e in seed.elements.values()
    ]
    rels = [
        {
            "id": r.id,
            "type_name": r.type_name,
            "source_id": r.source_id,
            "target_id": r.target_id,
            "properties": dict(r.properties),
            "rev": r.rev,
        }
        for r in seed.relationships.values()
    ]
    return elements, rels


def _full_model(
    elements: Sequence[Mapping[str, Any]], rels: Sequence[Mapping[str, Any]]
) -> Model:
    m = Model(_mm(), SequentialIdGenerator("n"))
    for e in elements:
        m.elements[e["id"]] = Element(
            id=e["id"],
            type_name=e["type_name"],
            properties=dict(e["properties"]),
            rev=e["rev"],
        )
    for r in rels:
        m.relationships[r["id"]] = Relationship(
            id=r["id"],
            type_name=r["type_name"],
            source_id=r["source_id"],
            target_id=r["target_id"],
            properties=dict(r["properties"]),
            rev=r["rev"],
        )
    m.indexes.rebuild()
    return m


def _random_batch(rng: random.Random, model: Model) -> list[ModelOpIn]:
    elements = list(model.elements)
    rels = list(model.relationships)
    temps: list[str] = []
    counter = 0

    def element_id() -> str:
        if rng.random() < 0.06:
            return rng.choice(_GHOSTS)
        return rng.choice(elements + temps or _GHOSTS)

    def rel_id() -> str:
        if rng.random() < 0.1 or not rels:
            return rng.choice(_GHOSTS)
        return rng.choice(rels)

    def ref_target() -> str:
        # now and then a relationship's id: a reference to it points to no element
        if rels and rng.random() < 0.2:
            return rng.choice(rels)
        return element_id()

    ops: list[ModelOpIn] = []
    for _ in range(rng.randint(1, 6)):
        kind = rng.choice(
            [
                "ce",
                "ce",
                "ue",
                "ue",
                "de",
                "cr",
                "cr",
                "cr",
                "ur",
                "dr",
                "dr",
                "re",
                "rr",
                "rce",
            ]
        )
        counter += 1
        temp = f"tmp_{counter}"
        if kind == "ce":
            props: dict[str, Any] = {"name": f"n{rng.randrange(5)}"}
            if rng.random() < 0.4:
                props["ref"] = ref_target()
            if rng.random() < 0.03:
                props["bogus"] = 1
            hint = (
                rng.choice(_HINTS + elements[:1] + rels[:3])
                if rng.random() < 0.3
                else None
            )
            ops.append(
                CreateElementOp(
                    kind="create_element",
                    temp_id=temp,
                    type_name="Item",
                    properties=props,
                    id=hint,
                )
            )
            temps.append(temp)
        elif kind == "ue":
            patch: dict[str, Any] = {}
            if rng.random() < 0.7:
                patch["name"] = f"n{rng.randrange(5)}"
            if rng.random() < 0.5:
                patch["ref"] = ref_target() if rng.random() < 0.8 else None
            ops.append(
                UpdateElementOp(
                    kind="update_element", id=element_id(), properties_patch=patch
                )
            )
        elif kind == "de":
            ops.append(DeleteElementOp(kind="delete_element", id=element_id()))
        elif kind == "cr":
            hint = rng.choice(_HINTS) if rng.random() < 0.3 else None
            ops.append(
                CreateRelationshipOp(
                    kind="create_relationship",
                    temp_id=temp,
                    type_name=rng.choice(["Holds", "Link", "Link"]),
                    source_id=element_id(),
                    target_id=element_id(),
                    properties={"label": "x"} if rng.random() < 0.3 else {},
                    id=hint,
                )
            )
        elif kind == "re":
            # delete an element and create it again under its id
            eid = element_id()
            ops.append(DeleteElementOp(kind="delete_element", id=eid))
            ops.append(
                CreateElementOp(
                    kind="create_element",
                    temp_id=temp,
                    type_name="Item",
                    properties={"name": "again"},
                    id=eid,
                )
            )
            temps.append(temp)
        elif kind == "rce":
            # a relationship goes and an element takes its id (and may go again)
            rid = rel_id()
            ops.append(DeleteRelationshipOp(kind="delete_relationship", id=rid))
            ops.append(
                CreateElementOp(
                    kind="create_element",
                    temp_id=temp,
                    type_name="Item",
                    properties={"name": "took"},
                    id=rid,
                )
            )
            temps.append(temp)
            if rng.random() < 0.6:
                ops.append(DeleteElementOp(kind="delete_element", id=temp))
        elif kind == "rr":
            rid = rel_id()
            ops.append(DeleteRelationshipOp(kind="delete_relationship", id=rid))
            ops.append(
                CreateRelationshipOp(
                    kind="create_relationship",
                    temp_id=temp,
                    type_name="Link",
                    source_id=element_id(),
                    target_id=element_id(),
                    id=rid,
                )
            )
        elif kind == "ur":
            ops.append(
                UpdateRelationshipOp(
                    kind="update_relationship",
                    id=rel_id(),
                    properties_patch={"label": f"u{rng.randrange(3)}"},
                )
            )
        else:
            ops.append(DeleteRelationshipOp(kind="delete_relationship", id=rel_id()))
    return ops


def _state(m: Model) -> Any:
    els = [
        (e.id, e.type_name, e.rev, repr(e.properties)) for e in dict.values(m.elements)
    ]
    rels = [
        (r.id, r.type_name, r.source_id, r.target_id, r.rev, repr(r.properties))
        for r in dict.values(m.relationships)
    ]
    ix = m.indexes
    return (
        els,
        rels,
        ix.out_rels,
        ix.in_rels,
        dict(ix.out_count),
        dict(ix.in_count),
        ix.containment_parents,
        ix._containment_rel_ids,
        ix.ref_targets,
        ix.element_order,
        ix.relationship_order,
        ix.elements_by_type,
    )


def _result_view(res: _BatchResult) -> dict[str, Any]:
    return {
        f.name: getattr(res, f.name)
        for f in dataclasses.fields(res)
        if f.name != "dirty"  # the uniqueness groups are the engine's
    }


def _random_restore_batch(rng: random.Random, model: Model) -> list[ModelOpIn]:
    """A batch shaped like a revert's: creates carry their final ids."""
    elements = list(model.elements)
    rels = list(model.relationships)
    made: list[str] = []
    ops: list[ModelOpIn] = []

    def element_id() -> str:
        if rng.random() < 0.06:
            return rng.choice(_GHOSTS)
        return rng.choice([*elements, *made] or _GHOSTS)

    for _ in range(rng.randint(1, 5)):
        kind = rng.choice(["ce", "ce", "cr", "de", "dr", "ue"])
        if kind == "ce":
            eid = rng.choice(_HINTS + rels[:3])
            if eid in rels and rng.random() < 0.8:
                ops.append(DeleteRelationshipOp(kind="delete_relationship", id=eid))
            ops.append(
                CreateElementOp(
                    kind="create_element",
                    temp_id=eid,
                    type_name="Item",
                    properties={"name": f"n{rng.randrange(5)}"},
                )
            )
            made.append(eid)
        elif kind == "cr":
            rid = rng.choice(_HINTS)
            ops.append(
                CreateRelationshipOp(
                    kind="create_relationship",
                    temp_id=rid,
                    type_name=rng.choice(["Holds", "Link"]),
                    source_id=element_id(),
                    target_id=element_id(),
                )
            )
        elif kind == "de":
            ops.append(DeleteElementOp(kind="delete_element", id=element_id()))
        elif kind == "dr":
            rid = rng.choice(rels or _GHOSTS)
            ops.append(DeleteRelationshipOp(kind="delete_relationship", id=rid))
        else:
            ops.append(
                UpdateElementOp(
                    kind="update_element",
                    id=element_id(),
                    properties_patch={"ref": element_id()},
                )
            )
    return ops


def _attempt(model: Model, ops: list[ModelOpIn], restore: bool) -> Any:
    """What a commit check would see of a batch: the result, the ids whose
    structure it can have changed and the blockers there."""
    before = _state(model)
    try:
        res = _apply_batch(model, ops, restore=restore)
    except HTTPException as exc:
        return ("refused", exc.status_code, exc.detail)
    except NotLoaded:
        assert _state(model) == before, "NotLoaded left the model changed"
        raise
    ids = _structural_ids(model, res)
    return ("ok", _result_view(res), ids, structural_blockers(model, ids))


def _rows_of(model: Model) -> tuple[list[dict], list[dict]]:
    return (
        [
            {
                "id": e.id,
                "type_name": e.type_name,
                "properties": dict(e.properties),
                "rev": e.rev,
            }
            for e in model.elements.values()
        ],
        [
            {
                "id": r.id,
                "type_name": r.type_name,
                "source_id": r.source_id,
                "target_id": r.target_id,
                "properties": dict(r.properties),
                "rev": r.rev,
            }
            for r in model.relationships.values()
        ],
    )


def _clone(model: Model) -> Model:
    twin = _full_model(*_rows_of(model))
    twin._ids = copy.copy(model._ids)
    twin.indexes.element_order = dict(model.indexes.element_order)
    twin.indexes.relationship_order = dict(model.indexes.relationship_order)
    twin.indexes._next_order = model.indexes._next_order
    twin.indexes._next_relationship_order = model.indexes._next_relationship_order
    return twin


def _partial_of(full: Model, loaded_refs: set[str], rel_ids: frozenset[str]) -> Model:
    """The partial model a loader would build for ``full``'s current state:
    every row, every set complete, except the referencers of the ids that are
    no element (hint ids nothing holds yet, relationship ids), which only
    ``loaded_refs`` have."""
    elements, rels = _rows_of(full)
    present = {row["id"] for row in [*elements, *rels]}
    hints = frozenset(_HINTS) - present
    ids = frozenset(row["id"] for row in elements)
    # a loader looks up what the loaded properties point at: dangling targets
    dangling = frozenset(
        value
        for row in elements
        if isinstance(value := row["properties"].get("ref"), str)
        and value not in present
    )
    partial = build_partial_model(
        _mm(),
        PartialRows(
            elements=elements,
            relationships=rels,
            absent=hints | frozenset(_GHOSTS) | dangling,
            edges_complete=ids,
            parents_complete=ids,
            referencers_complete=ids
            | frozenset(_GHOSTS)
            | (dangling - hints - rel_ids)
            | loaded_refs,
        ),
        id_generator=copy.copy(full._ids),
    )
    # the full model's sequence numbers are sparse after churn; only their
    # order carries, and the comparison is on the numbers
    partial.indexes.element_order = dict(full.indexes.element_order)
    partial.indexes.relationship_order = dict(full.indexes.relationship_order)
    partial.indexes._next_order = full.indexes._next_order
    partial.indexes._next_relationship_order = full.indexes._next_relationship_order
    return partial


@pytest.mark.parametrize(
    ("seed", "referencers_of_hints_loaded"),
    [(14, True), (15, False), (16, False), (17, False)],
)
def test_parity_with_a_full_model_over_random_batches(
    seed: int, referencers_of_hints_loaded: bool
) -> None:
    rng = random.Random(seed)
    full = _full_model(*_seed_rows(rng))
    rel_ids = set(full.relationships)  # every relationship id the run has seen
    loaded_refs = set(_HINTS) | rel_ids if referencers_of_hints_loaded else set()
    partial = _partial_of(full, loaded_refs, frozenset(rel_ids))
    assert _state(partial) == _state(full)
    seen = dict.fromkeys(
        (
            "ok",
            "refused",
            "deleted_element_ids",
            "recreated_element_ids",
            "recreated_relationship_ids",
            "deleted_relationship_ids",
            "restore",
            "reloaded",
        ),
        0,
    )
    blocked = 0
    for step in range(100):
        restore = rng.random() < 0.3
        ops = (_random_restore_batch if restore else _random_batch)(rng, full)
        rel_ids |= full.relationships.keys()
        before = _clone(full)
        want = _attempt(full, ops, restore)
        for _ in range(8):
            try:
                got = _attempt(partial, ops, restore)
                break
            except NotLoaded as exc:
                # the loader would look again: it learns these referencers
                assert exc.ids <= set(_HINTS) | rel_ids, f"batch {step}: {exc}"
                loaded_refs |= exc.ids
                seen["reloaded"] += 1
                partial = _partial_of(before, loaded_refs, frozenset(rel_ids))
        else:
            pytest.fail(f"batch {step}: still not loaded")
        assert got == want, f"batch {step}"
        seen[want[0]] += 1
        seen["restore"] += restore
        if want[0] == "ok":
            for name in seen.keys() & want[1].keys():
                seen[name] += bool(want[1][name])
        assert _state(partial) == _state(full), f"batch {step}"
        ids = [*full.elements, *full.relationships, *_GHOSTS]
        expected = structural_blockers(full, ids)
        blocked += bool(expected)
        assert structural_blockers(partial, ids) == expected, f"batch {step}"
    # the run must reach every path the guard sits on: accepted and refused
    # batches (a refusal rolls back, which settles the order), cascading
    # deletes, entities deleted and created again, revert-shaped batches,
    # and issues to find
    assert all(
        count > 0
        for name, count in seen.items()
        if name != "reloaded" or not referencers_of_hints_loaded
    ), seen
    assert blocked > 0
