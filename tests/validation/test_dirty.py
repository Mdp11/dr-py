"""Exact dirty-set contents per mutation kind (core/validation/dirty.py).

Each test pins the EXACT set of ids a mutation may have re-verdicted:
under-approximation would let stale issues survive an incremental splice, so
these are equality (not superset) assertions.
"""

from __future__ import annotations

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.validation.dirty import (
    DirtyCollector,
    containment_closure,
)


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="NamedElement",
                abstract=True,
                properties=[
                    PropertyDef(name="name", datatype="string", multiplicity="1")
                ],
                key=["name"],
            ),
            ElementType(
                name="Block",
                extends="NamedElement",
                properties=[
                    PropertyDef(name="ref", datatype="Part", multiplicity="0..1")
                ],
            ),
            ElementType(name="Part", extends="NamedElement"),
        ],
        relationships=[
            RelationshipType(
                name="HasPart",
                containment=True,
                source="NamedElement",
                target="NamedElement",
            ),
            RelationshipType(
                name="Link",
                source="Block",
                target="Part",
                properties=[
                    PropertyDef(name="label", datatype="string", multiplicity="0..1")
                ],
            ),
        ],
    )


def _model() -> Model:
    return Model(_mm(), id_generator=SequentialIdGenerator("n"))


def _named(model: Model, type_name: str, name: str):
    el = model.create_element(type_name)
    model.set_property(el, "name", name)
    return el


# ---------------------------------------------------------------------------
# DirtyCollector hooks
# ---------------------------------------------------------------------------


def test_create_element_dirties_group_and_dangling_referencers():
    model = _model()
    # n-1: a Part with no name — same uniqueness group as a freshly created
    # (still nameless) Part
    other = model.create_element("Part")
    # n-2: holds a dangling reference to the id the next element will get
    blk = _named(model, "Block", "B")
    model.set_property(blk, "ref", "n-3")

    collector = DirtyCollector()
    created = model.create_element("Part")  # n-3
    collector.after_element_create(model, created.id)

    assert set(collector.ids) == {created.id, other.id, blk.id}


def test_update_element_props_dirties_old_and_new_groups():
    model = _model()
    a = _named(model, "Part", "X")
    b = _named(model, "Part", "X")
    c = _named(model, "Part", "Y")
    unrelated = _named(model, "Part", "Z")

    # c joins {a, b}: old group is just {c}, new group is {a, b, c}
    collector = DirtyCollector()
    collector.before_element_props_change(model, c.id)
    model.set_property(c, "name", "X")
    collector.after_element_props_change(model, c.id)
    assert set(collector.ids) == {a.id, b.id, c.id}
    assert unrelated.id not in collector.ids

    # a leaves {a, b, c}: old group {a, b, c}, new group just {a}
    collector = DirtyCollector()
    collector.before_element_props_change(model, a.id)
    model.set_property(a, "name", "W")
    collector.after_element_props_change(model, a.id)
    assert set(collector.ids) == {a.id, b.id, c.id}


def test_delete_element_dirties_cascade_endpoints_referencers_and_groups():
    model = _model()
    p = _named(model, "Block", "P")  # n-1: deletion root
    p2 = _named(model, "Block", "P")  # n-2: duplicate of p (same group)
    c1 = _named(model, "Block", "C1")  # n-3: child of p
    c2 = _named(model, "Part", "C2")  # n-4: child of c1
    d = _named(model, "Part", "C2")  # n-5: child of c1, duplicate of c2
    x = _named(model, "Block", "X")  # n-6: outside, linked into the cascade
    r = _named(model, "Block", "R")  # n-7: outside, references c2
    model.set_property(r, "ref", c2.id)
    unrelated = _named(model, "Part", "U")  # n-8: untouched

    r1 = model.connect("HasPart", p.id, c1.id)
    r2 = model.connect("HasPart", c1.id, c2.id)
    r3 = model.connect("HasPart", c1.id, d.id)
    r4 = model.connect("Link", x.id, c2.id)

    assert containment_closure(model, p.id) == [p.id, c1.id, c2.id, d.id]

    collector = DirtyCollector()
    collector.before_element_delete(model, p.id)
    model.delete_element(p.id)

    assert set(collector.ids) == {
        # the cascade itself
        p.id, c1.id, c2.id, d.id,
        # incident relationships and their other endpoints
        r1.id, r2.id, r3.id, r4.id, x.id,
        # referencers of cascade-deleted elements
        r.id,
        # uniqueness-group members of cascade-deleted elements
        p2.id,
    }
    assert unrelated.id not in collector.ids


def test_containment_closure_handles_cycles_and_diamonds():
    model = _model()
    a = _named(model, "Block", "A")
    b = _named(model, "Block", "B")
    c = _named(model, "Block", "C")
    model.connect("HasPart", a.id, b.id)
    model.connect("HasPart", b.id, c.id)
    model.connect("HasPart", a.id, c.id)  # diamond: c reachable twice
    model.connect("HasPart", c.id, a.id)  # cycle back to the root
    closure = containment_closure(model, a.id)
    assert sorted(closure) == sorted([a.id, b.id, c.id])
    assert len(closure) == 3  # each element exactly once


def test_connect_containment_dirties_endpoints_rel_and_both_groups():
    model = _model()
    p = _named(model, "Block", "Parent")
    e3 = _named(model, "Part", "Dup")  # child of p (same group as e after move)
    model.connect("HasPart", p.id, e3.id)
    e = _named(model, "Part", "Dup")  # unowned
    e2 = _named(model, "Part", "Dup")  # unowned duplicate of e
    unrelated = _named(model, "Part", "U")

    collector = DirtyCollector()
    collector.before_connect(model, "HasPart", p.id, e.id)
    rel = model.connect("HasPart", p.id, e.id)
    collector.after_connect(model, rel.id)

    assert set(collector.ids) == {p.id, e.id, e2.id, e3.id, rel.id}
    assert unrelated.id not in collector.ids


def test_connect_non_containment_dirties_endpoints_and_rel_only():
    model = _model()
    b = _named(model, "Block", "B")
    b2 = _named(model, "Block", "B")  # duplicate of b — must NOT be dirtied
    part = _named(model, "Part", "P")

    collector = DirtyCollector()
    collector.before_connect(model, "Link", b.id, part.id)
    rel = model.connect("Link", b.id, part.id)
    collector.after_connect(model, rel.id)

    assert set(collector.ids) == {b.id, part.id, rel.id}
    assert b2.id not in collector.ids


def test_disconnect_containment_dirties_endpoints_rel_and_both_groups():
    model = _model()
    p = _named(model, "Block", "Parent")
    e = _named(model, "Part", "Dup")
    e3 = _named(model, "Part", "Dup")  # stays child of p (old group of e)
    e2 = _named(model, "Part", "Dup")  # unowned (new group of e)
    rel = model.connect("HasPart", p.id, e.id)
    model.connect("HasPart", p.id, e3.id)

    collector = DirtyCollector()
    collector.before_disconnect(model, rel.id)
    model.disconnect(rel.id)
    collector.after_disconnect(model, "HasPart", p.id, e.id)

    assert set(collector.ids) == {rel.id, p.id, e.id, e3.id, e2.id}


def test_relationship_props_change_dirties_only_the_relationship():
    model = _model()
    b = _named(model, "Block", "B")
    part = _named(model, "Part", "P")
    rel = model.connect("Link", b.id, part.id)

    collector = DirtyCollector()
    collector.after_relationship_props_change(rel.id)
    model.set_property(rel, "label", "x")

    assert set(collector.ids) == {rel.id}
