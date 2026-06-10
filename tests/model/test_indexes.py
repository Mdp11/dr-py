"""Tests for the IndexSet maintained incrementally at the Model mutation boundary."""

import random

import pytest

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.change_request import ChangeRequest, apply_change_request
from data_rover.core.model.element import Element
from data_rover.core.model.indexes import IndexSet
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Folder",
                key=["name"],
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(
                name="Doc",
                key=["name"],
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="author", datatype="Person"),
                    PropertyDef(
                        name="reviewers", datatype="Person", multiplicity="0..*"
                    ),
                ],
            ),
            # no key declared -> uniqueness signature is all properties
            ElementType(
                name="Person",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
        ],
        relationships=[
            RelationshipType(
                name="Contains",
                containment=True,
                mappings=[
                    Mapping(source="Folder", target="Doc"),
                    Mapping(source="Folder", target="Folder"),
                ],
            ),
            RelationshipType(name="Links", source="Doc", target="Doc"),
            RelationshipType(
                name="Authored",
                source="Person",
                target="Doc",
                properties=[PropertyDef(name="approver", datatype="Person")],
            ),
        ],
    )


def _fresh(model: Model) -> IndexSet:
    idx = IndexSet(model)
    idx.rebuild()
    return idx


def _assert_matches_rebuild(model: Model) -> None:
    from collections import Counter

    fresh = _fresh(model)
    for name in (
        "out_rels",
        "in_rels",
        "out_count",
        "in_count",
        "elements_by_type",
        "containment_parents",
        "_containment_rel_ids",
        "ref_targets",
        "uniq_groups",
        "uniq_key_of",
        "duplicate_keys",
    ):
        live = getattr(model.indexes, name)
        expected = getattr(fresh, name)
        # Counter.__eq__ ignores zero-count entries; compare as plain dicts so
        # spurious zeros in the live index are caught.
        if isinstance(live, Counter):
            live = dict(live)
            expected = dict(expected)
        assert live == expected, name
    model.indexes.verify_consistent()


# ---------------------------------------------------------------------------
# per-mutation correctness
# ---------------------------------------------------------------------------


def test_create_element_indexes_type_and_uniqueness():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Folder")

    assert model.indexes.elements_by_type["Doc"] == {a.id}
    assert model.indexes.elements_by_type["Folder"] == {b.id}
    assert a.id in model.indexes.uniq_key_of
    # both have key=["name"] with no value yet, but type differs -> no duplicates
    assert model.indexes.duplicate_keys == set()
    _assert_matches_rebuild(model)


def test_same_key_same_context_marks_duplicates():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    model.set_property(a, "name", "spec")
    model.set_property(b, "name", "spec")

    key = model.indexes.uniq_key_of[a.id]
    assert model.indexes.uniq_key_of[b.id] == key
    assert model.indexes.uniq_groups[key] == {a.id, b.id}
    assert model.indexes.duplicate_keys == {key}

    model.set_property(b, "name", "other")
    assert model.indexes.duplicate_keys == set()
    assert model.indexes.uniq_key_of[a.id] != model.indexes.uniq_key_of[b.id]
    _assert_matches_rebuild(model)


def test_no_key_type_groups_by_all_properties():
    model = Model(_mm())
    p1 = model.create_element("Person")
    p2 = model.create_element("Person")
    # both have empty properties -> duplicates
    assert len(model.indexes.duplicate_keys) == 1
    model.set_property(p1, "name", "Ada")
    assert model.indexes.duplicate_keys == set()
    model.set_property(p2, "name", "Ada")
    assert len(model.indexes.duplicate_keys) == 1
    _assert_matches_rebuild(model)


def test_connect_updates_adjacency_and_counts():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    r = model.connect("Links", a.id, b.id)

    assert model.indexes.out_rels[a.id] == {r.id}
    assert model.indexes.in_rels[b.id] == {r.id}
    assert model.indexes.out_count[(a.id, "Links")] == 1
    assert model.indexes.in_count[(b.id, "Links")] == 1
    assert model.relationships_from(a.id) == [r]
    assert model.relationships_to(b.id) == [r]
    _assert_matches_rebuild(model)


def test_containment_connect_rekeys_target_group():
    model = Model(_mm())
    f1 = model.create_element("Folder")
    f2 = model.create_element("Folder")
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    model.set_property(f1, "name", "one")
    model.set_property(f2, "name", "two")
    model.set_property(a, "name", "spec")
    model.set_property(b, "name", "spec")
    assert len(model.indexes.duplicate_keys) == 1  # both unowned, same name

    # move a into f1: contexts now differ -> no duplicates
    r1 = model.connect("Contains", f1.id, a.id)
    assert model.indexes.containment_parents[a.id] == [f1.id]
    assert model.container_of(a.id) == f1.id
    assert model.indexes.duplicate_keys == set()
    assert model.indexes.uniq_key_of[a.id][1] == f1.id

    # move b into f1 too: same owner, same name -> duplicates again
    model.connect("Contains", f1.id, b.id)
    assert len(model.indexes.duplicate_keys) == 1
    _assert_matches_rebuild(model)

    # disconnect re-keys back to unowned
    model.disconnect(r1.id)
    assert a.id not in model.indexes.containment_parents
    assert model.container_of(a.id) is None
    assert model.indexes.uniq_key_of[a.id][1] is None
    assert model.indexes.duplicate_keys == set()
    _assert_matches_rebuild(model)


def test_multiple_containment_parents_keep_insertion_order():
    model = Model(_mm())
    f1 = model.create_element("Folder")
    f2 = model.create_element("Folder")
    d = model.create_element("Doc")
    r1 = model.connect("Contains", f1.id, d.id)
    model.connect("Contains", f2.id, d.id)
    assert model.indexes.containment_parents[d.id] == [f1.id, f2.id]
    assert model.container_of(d.id) == f1.id

    model.disconnect(r1.id)
    assert model.indexes.containment_parents[d.id] == [f2.id]
    assert model.container_of(d.id) == f2.id
    # owner context changed -> group re-keyed to the new first parent
    assert model.indexes.uniq_key_of[d.id][1] == f2.id
    _assert_matches_rebuild(model)


def test_duplicate_parallel_containment_edges_remove_by_relationship():
    # two parallel f1 -> d edges around an f2 -> d edge: removal must drop the
    # entry contributed by the disconnected relationship, not the first parent
    # entry matching by value, or the order diverges from rebuild()
    model = Model(_mm())
    f1 = model.create_element("Folder")
    f2 = model.create_element("Folder")
    d = model.create_element("Doc")
    model.connect("Contains", f1.id, d.id)  # r1
    model.connect("Contains", f2.id, d.id)  # r2
    r3 = model.connect("Contains", f1.id, d.id)
    assert model.indexes.containment_parents[d.id] == [f1.id, f2.id, f1.id]

    # disconnecting the LATER f1 edge must keep the earlier one first
    model.disconnect(r3.id)
    assert model.indexes.containment_parents[d.id] == [f1.id, f2.id]
    assert model.container_of(d.id) == f1.id
    assert model.indexes.uniq_key_of[d.id][1] == f1.id
    model.indexes.verify_consistent()
    _assert_matches_rebuild(model)


def test_duplicate_parallel_containment_edges_remove_earlier_edge():
    # disconnecting the EARLIER f1 edge leaves r2, r3 in relationship
    # insertion order, i.e. [f2, f1] — matching rebuild() semantics
    model = Model(_mm())
    f1 = model.create_element("Folder")
    f2 = model.create_element("Folder")
    d = model.create_element("Doc")
    r1 = model.connect("Contains", f1.id, d.id)
    model.connect("Contains", f2.id, d.id)  # r2
    model.connect("Contains", f1.id, d.id)  # r3

    model.disconnect(r1.id)
    assert model.indexes.containment_parents[d.id] == [f2.id, f1.id]
    assert model.container_of(d.id) == f2.id
    # owner context changed -> uniqueness group re-keyed to the new first parent
    assert model.indexes.uniq_key_of[d.id][1] == f2.id
    model.indexes.verify_consistent()
    _assert_matches_rebuild(model)


def test_disconnect_clears_adjacency_and_counts():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    r = model.connect("Links", a.id, b.id)
    model.disconnect(r.id)

    assert a.id not in model.indexes.out_rels
    assert b.id not in model.indexes.in_rels
    assert (a.id, "Links") not in model.indexes.out_count
    assert (b.id, "Links") not in model.indexes.in_count
    _assert_matches_rebuild(model)


def test_ref_targets_track_property_values():
    model = Model(_mm())
    p1 = model.create_element("Person")
    p2 = model.create_element("Person")
    doc = model.create_element("Doc")

    model.set_property(doc, "author", p1.id)
    assert model.indexes.ref_targets[p1.id] == {doc.id}

    # change single ref: moves to the new target
    model.set_property(doc, "author", p2.id)
    assert p1.id not in model.indexes.ref_targets
    assert model.indexes.ref_targets[p2.id] == {doc.id}

    # list-valued refs
    model.set_property(doc, "reviewers", [p1.id, p2.id])
    assert model.indexes.ref_targets[p1.id] == {doc.id}
    assert model.indexes.ref_targets[p2.id] == {doc.id}

    # clearing a ref property removes entries
    model.set_property(doc, "reviewers", [])
    model.set_property(doc, "author", None)
    assert p1.id not in model.indexes.ref_targets
    assert p2.id not in model.indexes.ref_targets
    _assert_matches_rebuild(model)


def test_ref_targets_include_relationship_properties():
    model = Model(_mm())
    p = model.create_element("Person")
    approver = model.create_element("Person")
    model.set_property(approver, "name", "appr")
    doc = model.create_element("Doc")
    r = model.connect("Authored", p.id, doc.id)
    model.set_property(r, "approver", approver.id)

    assert model.indexes.ref_targets[approver.id] == {r.id}
    model.disconnect(r.id)
    assert approver.id not in model.indexes.ref_targets
    _assert_matches_rebuild(model)


def test_delete_element_removes_refs_it_held():
    model = Model(_mm())
    p = model.create_element("Person")
    doc = model.create_element("Doc")
    model.set_property(doc, "author", p.id)
    model.delete_element(doc.id)
    assert p.id not in model.indexes.ref_targets
    _assert_matches_rebuild(model)


def test_ref_targets_keep_dangling_entries_when_target_deleted():
    model = Model(_mm())
    p = model.create_element("Person")
    doc = model.create_element("Doc")
    model.set_property(doc, "author", p.id)
    model.delete_element(p.id)
    # doc still holds the dangling id; rebuild derives the same entry
    assert model.indexes.ref_targets[p.id] == {doc.id}
    _assert_matches_rebuild(model)


def test_delete_cascade_updates_every_index():
    model = Model(_mm())
    root = model.create_element("Folder")
    sub = model.create_element("Folder")
    d1 = model.create_element("Doc")
    d2 = model.create_element("Doc")
    other = model.create_element("Doc")
    p = model.create_element("Person")
    model.set_property(root, "name", "root")
    model.set_property(sub, "name", "sub")
    model.connect("Contains", root.id, sub.id)
    model.connect("Contains", root.id, d1.id)
    model.connect("Contains", sub.id, d2.id)
    model.connect("Links", d2.id, other.id)
    model.set_property(d2, "author", p.id)

    model.delete_element(root.id)

    for gone in (root.id, sub.id, d1.id, d2.id):
        assert gone not in model.elements
        assert gone not in model.indexes.uniq_key_of
        assert gone not in model.indexes.out_rels
        assert gone not in model.indexes.in_rels
        assert gone not in model.indexes.containment_parents
    assert other.id in model.elements
    assert p.id not in model.indexes.ref_targets
    assert model.relationships == {}
    _assert_matches_rebuild(model)


def test_delete_element_rekeys_orphaned_children_via_cascade_disconnects():
    model = Model(_mm())
    f = model.create_element("Folder")
    d = model.create_element("Doc")
    model.connect("Contains", f.id, d.id)
    assert model.indexes.uniq_key_of[d.id][1] == f.id
    model.delete_element(f.id)
    # the contained child is cascade-deleted, not orphaned
    assert d.id not in model.elements
    _assert_matches_rebuild(model)


def test_query_helpers_match_previous_semantics():
    model = Model(_mm())
    f = model.create_element("Folder")
    d1 = model.create_element("Doc")
    d2 = model.create_element("Doc")
    c1 = model.connect("Contains", f.id, d1.id)
    c2 = model.connect("Contains", f.id, d2.id)
    link = model.connect("Links", d1.id, d2.id)

    assert set(r.id for r in model.relationships_from(f.id)) == {c1.id, c2.id}
    assert model.relationships_from(d1.id) == [link]
    assert isinstance(model.relationships_to(d2.id), list)  # list type preserved
    assert {r.id for r in model.relationships_to(d2.id)} == {c2.id, link.id}
    assert {r.id for r in model._containment_children(f.id)} == {c1.id, c2.id}
    assert model.container_of(d1.id) == f.id
    assert model.container_of(f.id) is None
    assert model.relationships_from("missing") == []
    assert model.relationships_to("missing") == []


# ---------------------------------------------------------------------------
# bulk loads
# ---------------------------------------------------------------------------


def test_rebuild_after_direct_population():
    model = Model(_mm())
    model.elements["f"] = Element(id="f", type_name="Folder", properties={})
    model.elements["d"] = Element(
        id="d", type_name="Doc", properties={"author": "p", "name": "x"}
    )
    model.elements["p"] = Element(id="p", type_name="Person", properties={})
    model.relationships["c"] = Relationship(
        id="c", type_name="Contains", source_id="f", target_id="d"
    )
    model.indexes.rebuild()

    assert model.indexes.containment_parents["d"] == ["f"]
    assert model.indexes.ref_targets["p"] == {"d"}
    assert model.indexes.uniq_key_of["d"][1] == "f"
    assert model.container_of("d") == "f"
    model.indexes.verify_consistent()


def test_apply_change_request_result_has_consistent_indexes():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    model.set_property(a, "name", "a")
    model.set_property(b, "name", "b")
    rel = model.connect("Links", a.id, b.id)

    cr = ChangeRequest(
        elements_added=[Element(id="new", type_name="Folder", properties={})],
        relationships_deleted=[
            Relationship(
                id=rel.id, type_name="Links", source_id=a.id, target_id=b.id
            )
        ],
    )
    result = apply_change_request(model, cr)
    result.indexes.verify_consistent()
    assert result.relationships_from(a.id) == []
    assert "new" in result.indexes.elements_by_type["Folder"]


def test_verify_consistent_detects_corruption():
    model = Model(_mm())
    a = model.create_element("Doc")
    b = model.create_element("Doc")
    model.connect("Links", a.id, b.id)
    model.indexes.out_count[(a.id, "Links")] += 1  # corrupt
    with pytest.raises(AssertionError):
        model.indexes.verify_consistent()


# ---------------------------------------------------------------------------
# mutation-boundary guard: detached entities
# ---------------------------------------------------------------------------


def test_set_property_on_detached_element_raises_and_leaves_indexes_intact():
    """set_property must reject an Element not registered in the model and must
    not mutate any index state in the process."""
    model = Model(_mm())
    owned = model.create_element("Doc")
    model.set_property(owned, "name", "real")

    # A detached Element that was never added to this model.
    detached = Element(id="detached-id", type_name="Doc", properties={})

    with pytest.raises(KeyError, match="not part of this model"):
        model.set_property(detached, "name", "should-not-land")

    # The detached element must not appear in any index.
    assert "detached-id" not in model.indexes.uniq_key_of
    assert "detached-id" not in model.indexes.elements_by_type.get("Doc", set())
    # The owned element's indexes must be undisturbed.
    _assert_matches_rebuild(model)


def test_set_property_on_deleted_element_raises():
    """An element removed from the model is detached; set_property must reject it."""
    model = Model(_mm())
    el = model.create_element("Person")
    model.delete_element(el.id)

    with pytest.raises(KeyError, match="not part of this model"):
        model.set_property(el, "name", "ghost")


# ---------------------------------------------------------------------------
# randomized differential test
# ---------------------------------------------------------------------------


def test_randomized_ops_match_rebuild():
    rng = random.Random(20260610)
    model = Model(_mm())
    person_ids: list[str] = []

    def random_element_id() -> str | None:
        ids = list(model.elements)
        return rng.choice(ids) if ids else None

    def op_create() -> None:
        type_name = rng.choice(["Folder", "Doc", "Person", "Person"])
        el = model.create_element(type_name)
        if type_name == "Person":
            person_ids.append(el.id)

    def op_connect() -> None:
        src = random_element_id()
        tgt = random_element_id()
        if src is None or tgt is None:
            return
        rel_type = rng.choice(["Contains", "Links", "Authored"])
        model.connect(rel_type, src, tgt)

    def op_disconnect() -> None:
        ids = list(model.relationships)
        if ids:
            model.disconnect(rng.choice(ids))

    def op_set_property() -> None:
        eid = random_element_id()
        if eid is None:
            return
        el = model.elements[eid]
        if el.type_name in ("Folder", "Person"):
            model.set_property(el, "name", rng.choice(["a", "b", "c", None]))
        else:
            prop = rng.choice(["name", "author", "reviewers"])
            if prop == "name":
                model.set_property(el, "name", rng.choice(["a", "b", "c"]))
            elif prop == "author":
                value = rng.choice(person_ids) if person_ids else "dangling"
                model.set_property(el, "author", rng.choice([value, None]))
            else:
                pool = person_ids or ["dangling"]
                value = [rng.choice(pool) for _ in range(rng.randint(0, 3))]
                model.set_property(el, "reviewers", value)

    def op_set_rel_property() -> None:
        rel_ids = [
            rid
            for rid, r in model.relationships.items()
            if r.type_name == "Authored"
        ]
        if not rel_ids:
            return
        rel = model.relationships[rng.choice(rel_ids)]
        value = rng.choice(person_ids) if person_ids else "dangling"
        model.set_property(rel, "approver", rng.choice([value, None]))

    def op_delete() -> None:
        eid = random_element_id()
        if eid is not None:
            model.delete_element(eid)

    ops = [
        (op_create, 5),
        (op_connect, 4),
        (op_disconnect, 2),
        (op_set_property, 5),
        (op_set_rel_property, 2),
        (op_delete, 2),
    ]
    weighted = [fn for fn, w in ops for _ in range(w)]

    for step in range(200):
        rng.choice(weighted)()
        person_ids[:] = [p for p in person_ids if p in model.elements]
        if step % 25 == 0:
            _assert_matches_rebuild(model)
    _assert_matches_rebuild(model)
    assert len(model.elements) > 0  # the run actually built something
