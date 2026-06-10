"""Exact dirty-set contents per mutation kind (core/validation/dirty.py).

Each test pins the EXACT set of ids a mutation may have re-verdicted:
under-approximation would let stale issues survive in a ValidationState, so
these are equality (not superset) assertions.
"""

from __future__ import annotations

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.change_request import (
    ChangeRequest,
    ModifiedElement,
    ModifiedRelationship,
    apply_change_request,
)
from data_rover.core.model.element import Element
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.model.relationship import Relationship
from data_rover.core.validation.dirty import (
    DirtyCollector,
    change_request_dirty_ids,
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
    collector.after_disconnect(model, "HasPart", e.id)

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


# ---------------------------------------------------------------------------
# change_request_dirty_ids (CR-apply path)
# ---------------------------------------------------------------------------


def _dirty_for(base: Model, cr: ChangeRequest) -> tuple[Model, set[str]]:
    result = apply_change_request(base, cr)
    return result, set(change_request_dirty_ids(base, result, cr))


def test_cr_element_added_dirties_result_group_and_dangling_referencers():
    base = _model()
    existing = _named(base, "Part", "Dup")  # n-1
    holder = _named(base, "Block", "H")  # n-2: dangling ref to the new id
    base.set_property(holder, "ref", "new-1")
    unrelated = _named(base, "Part", "U")  # n-3

    cr = ChangeRequest(
        elements_added=[
            Element(id="new-1", type_name="Part", properties={"name": "Dup"})
        ]
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {"new-1", existing.id, holder.id}
    assert unrelated.id not in dirty


def test_cr_element_modified_dirties_old_and_new_groups():
    base = _model()
    a = _named(base, "Part", "X")
    b = _named(base, "Part", "X")
    c = _named(base, "Part", "Y")

    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(
                id=c.id,
                before=Element(id=c.id, type_name="Part", properties={"name": "Y"}),
                after=Element(id=c.id, type_name="Part", properties={"name": "X"}),
            )
        ]
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {a.id, b.id, c.id}


def test_cr_element_type_change_dirties_incident_rels_and_referencers():
    base = _model()
    blk = _named(base, "Block", "B")
    part = _named(base, "Part", "P")
    rel = base.connect("Link", blk.id, part.id)
    referencer = _named(base, "Block", "R")
    base.set_property(referencer, "ref", part.id)

    cr = ChangeRequest(
        elements_modified=[
            ModifiedElement(
                id=part.id,
                before=Element(id=part.id, type_name="Part", properties={"name": "P"}),
                after=Element(id=part.id, type_name="Block", properties={"name": "P"}),
            )
        ]
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {part.id, rel.id, referencer.id}


def test_cr_element_deleted_dirties_endpoints_referencers_and_group():
    base = _model()
    victim = _named(base, "Part", "Dup")
    twin = _named(base, "Part", "Dup")
    blk = _named(base, "Block", "B")
    rel = base.connect("Link", blk.id, victim.id)
    referencer = _named(base, "Block", "R")
    base.set_property(referencer, "ref", victim.id)
    unrelated = _named(base, "Part", "U")

    cr = ChangeRequest(
        elements_deleted=[
            Element(id=victim.id, type_name="Part", properties={"name": "Dup"})
        ],
        relationships_deleted=[
            Relationship(
                id=rel.id, type_name="Link", source_id=blk.id, target_id=victim.id
            )
        ],
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {victim.id, twin.id, blk.id, rel.id, referencer.id}
    assert unrelated.id not in dirty


def test_cr_relationship_added_containment_dirties_old_and_new_target_groups():
    base = _model()
    p = _named(base, "Block", "Parent")
    e3 = _named(base, "Part", "Dup")
    base.connect("HasPart", p.id, e3.id)  # existing child of p
    e = _named(base, "Part", "Dup")  # unowned, about to be re-parented
    e2 = _named(base, "Part", "Dup")  # unowned duplicate of e

    cr = ChangeRequest(
        relationships_added=[
            Relationship(
                id="rel-new", type_name="HasPart", source_id=p.id, target_id=e.id
            )
        ]
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {"rel-new", p.id, e.id, e2.id, e3.id}


def test_cr_relationship_modified_retarget_dirties_all_endpoints_and_groups():
    base = _model()
    p = _named(base, "Block", "Parent")
    p2 = _named(base, "Block", "Parent2")
    c_old = _named(base, "Part", "Dup")
    c_old_twin = _named(base, "Part", "Dup")  # unowned: c_old's NEW group
    c_new = _named(base, "Part", "N")
    rel = base.connect("HasPart", p.id, c_old.id)

    cr = ChangeRequest(
        relationships_modified=[
            ModifiedRelationship(
                id=rel.id,
                before=Relationship(
                    id=rel.id, type_name="HasPart", source_id=p.id, target_id=c_old.id
                ),
                after=Relationship(
                    id=rel.id, type_name="HasPart", source_id=p2.id, target_id=c_new.id
                ),
            )
        ]
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {rel.id, p.id, p2.id, c_old.id, c_old_twin.id, c_new.id}


def test_cr_relationship_modified_plain_dirties_rel_and_endpoints():
    base = _model()
    b = _named(base, "Block", "B")
    part = _named(base, "Part", "P")
    rel = base.connect("Link", b.id, part.id)
    rel_snapshot = Relationship(
        id=rel.id, type_name="Link", source_id=b.id, target_id=part.id
    )
    after = Relationship(
        id=rel.id,
        type_name="Link",
        source_id=b.id,
        target_id=part.id,
        properties={"label": "x"},
    )
    cr = ChangeRequest(
        relationships_modified=[
            ModifiedRelationship(id=rel.id, before=rel_snapshot, after=after)
        ]
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {rel.id, b.id, part.id}


def test_cr_relationship_deleted_containment_dirties_target_groups():
    base = _model()
    p = _named(base, "Block", "Parent")
    e = _named(base, "Part", "Dup")
    e3 = _named(base, "Part", "Dup")  # stays child of p
    e2 = _named(base, "Part", "Dup")  # unowned: e re-keys into its group
    rel = base.connect("HasPart", p.id, e.id)
    base.connect("HasPart", p.id, e3.id)

    cr = ChangeRequest(
        relationships_deleted=[
            Relationship(
                id=rel.id, type_name="HasPart", source_id=p.id, target_id=e.id
            )
        ]
    )
    _, dirty = _dirty_for(base, cr)
    assert dirty == {rel.id, p.id, e.id, e2.id, e3.id}
