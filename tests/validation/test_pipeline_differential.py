"""Differential snapshot of the full validation pipeline output.

Pins the exact issue SET (severity, message, target_ids) produced by
``default_pipeline().validate`` on a model exercising every violation kind:
property multiplicity (element + relationship), relationship-end multiplicity
(both directions), type conformance (datatype + references), facets,
endpoint typing, containment (single-parent + cycle), and uniqueness
(keyed + keyless).

The expected data was snapshotted from the pre-A3 per-validator pipeline.
If this test fails, treat it as a tripwire: an unintended behaviour change
should be fixed in the validators, while a legitimate message/issue change
means deliberately updating EXPECTED — review the diff issue by issue and
call the change out in review. Issue ORDER is not pinned (the pipeline
interleaves validators per entity), so comparisons sort by
(message, target_ids, severity).
"""

from __future__ import annotations

from data_rover.core.metamodel.schema import (
    ElementType,
    Mapping,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.ids import SequentialIdGenerator
from data_rover.core.model.model import Model
from data_rover.core.validation.pipeline import default_pipeline
from data_rover.core.validation.scope import Scope


def _metamodel() -> Metamodel:
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
                    PropertyDef(
                        name="count",
                        datatype="integer",
                        multiplicity="0..1",
                        min=0,
                        max=10,
                    ),
                    PropertyDef(
                        name="code",
                        datatype="string",
                        multiplicity="0..1",
                        pattern="[A-Z]+",
                        max_length=4,
                    ),
                    PropertyDef(name="ref", datatype="Part", multiplicity="0..1"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..2"),
                ],
            ),
            ElementType(name="Part", extends="NamedElement"),
            ElementType(
                name="Doc",
                properties=[
                    PropertyDef(name="title", datatype="string", multiplicity="0..1")
                ],
            ),
            ElementType(name="Hub", extends="NamedElement"),
            ElementType(name="Node", extends="NamedElement"),
            ElementType(name="A", extends="NamedElement"),
            ElementType(name="B", extends="NamedElement"),
            ElementType(name="C", extends="NamedElement"),
            ElementType(name="D", extends="NamedElement"),
        ],
        relationships=[
            RelationshipType(
                name="HasPart",
                containment=True,
                source="NamedElement",
                target="NamedElement",
            ),
            RelationshipType(
                name="Owns",
                source="Hub",
                target="Node",
                target_multiplicity="1..2",
                source_multiplicity="0..1",
            ),
            RelationshipType(
                name="Link",
                source="Block",
                target="Part",
                properties=[
                    PropertyDef(name="label", datatype="string", multiplicity="1")
                ],
            ),
            RelationshipType(
                name="R2",
                mappings=[
                    Mapping(source="A", target="B"),
                    Mapping(source="C", target="D"),
                ],
            ),
        ],
    )


def _named(model: Model, type_name: str, name: str):
    el = model.create_element(type_name)
    model.set_property(el, "name", name)
    return el


def _build_model() -> Model:
    model = Model(_metamodel(), id_generator=SequentialIdGenerator("n"))

    # n-1: element property multiplicity (required name missing)
    model.create_element("Block")
    # n-2..n-9: facets + type conformance + references
    blk_main = _named(model, "Block", "Main")  # n-2
    model.set_property(blk_main, "count", -5)  # facet: below min
    blk_big = _named(model, "Block", "Big")  # n-3
    model.set_property(blk_big, "count", 99)  # facet: above max
    blk_code1 = _named(model, "Block", "Code1")  # n-4
    model.set_property(blk_code1, "code", "abc")  # facet: pattern
    blk_code2 = _named(model, "Block", "Code2")  # n-5
    model.set_property(blk_code2, "code", "TOOLONG")  # facet: max_length
    blk_badtype = _named(model, "Block", "BadType")  # n-6
    model.set_property(blk_badtype, "count", "abc")  # type conformance
    blk_badref1 = _named(model, "Block", "BadRef1")  # n-7
    model.set_property(blk_badref1, "ref", "missing-id")  # dangling reference
    blk_badref2 = _named(model, "Block", "BadRef2")  # n-8
    model.set_property(blk_badref2, "ref", blk_main.id)  # wrong referenced type
    blk_badref3 = _named(model, "Block", "BadRef3")  # n-9
    model.set_property(blk_badref3, "ref", 42)  # non-string reference
    blk_tags = _named(model, "Block", "Tags")  # n-10
    model.set_property(blk_tags, "tags", ["a", "b", "c"])  # 3 violates 0..2

    # relationship property multiplicity: Link without required label
    part1 = _named(model, "Part", "P1")  # n-11
    model.connect("Link", blk_main.id, part1.id)  # n-12 (label missing)

    # endpoint typing
    part2 = _named(model, "Part", "P2")  # n-13
    bad_src = model.connect("Link", part2.id, part1.id)  # n-14: source not Block
    model.set_property(bad_src, "label", "ok")
    bad_tgt = model.connect("Link", blk_main.id, blk_code1.id)  # n-15: target
    model.set_property(bad_tgt, "label", "ok")
    a1 = _named(model, "A", "A1")  # n-16
    d1 = _named(model, "D", "D1")  # n-17
    model.connect("R2", a1.id, d1.id)  # n-18: (A, D) matches no mapping

    # relationship-end multiplicity
    _named(model, "Hub", "H0")  # n-19: 0 outgoing Owns violates 1..2
    hub3 = _named(model, "Hub", "H3")  # n-20: 3 outgoing Owns violates 1..2
    node1 = _named(model, "Node", "N1")  # n-21
    node2 = _named(model, "Node", "N2")  # n-22
    node3 = _named(model, "Node", "N3")  # n-23
    model.connect("Owns", hub3.id, node1.id)  # n-24
    model.connect("Owns", hub3.id, node2.id)  # n-25
    model.connect("Owns", hub3.id, node3.id)  # n-26
    hub_ok = _named(model, "Hub", "HOK")  # n-27
    node_multi = _named(model, "Node", "NM")  # n-28: 2 incoming violates 0..1
    model.connect("Owns", hub_ok.id, node_multi.id)  # n-29
    model.connect("Owns", hub_ok.id, node_multi.id)  # n-30

    # containment: two parents + cycle
    p1 = _named(model, "Block", "Par1")  # n-31
    p2 = _named(model, "Block", "Par2")  # n-32
    child = _named(model, "Block", "Child")  # n-33
    model.connect("HasPart", p1.id, child.id)  # n-34
    model.connect("HasPart", p2.id, child.id)  # n-35
    cyc_a = _named(model, "Block", "CycA")  # n-36
    cyc_b = _named(model, "Block", "CycB")  # n-37
    model.connect("HasPart", cyc_a.id, cyc_b.id)  # n-38
    model.connect("HasPart", cyc_b.id, cyc_a.id)  # n-39

    # uniqueness: keyed duplicates (Block key is ['name'])
    _named(model, "Block", "Dup")  # n-40
    _named(model, "Block", "Dup")  # n-41
    # uniqueness: keyless duplicates (Doc has no key)
    doc1 = model.create_element("Doc")  # n-42
    model.set_property(doc1, "title", "T")
    doc2 = model.create_element("Doc")  # n-43
    model.set_property(doc2, "title", "T")
    doc3 = model.create_element("Doc")  # n-44
    model.set_property(doc3, "title", "X")

    return model


# Snapshot of default_pipeline().validate(model, Scope.all()) taken on the
# pre-A3 pipeline; (severity value, message, target_ids), sorted.
EXPECTED = sorted(
    [
        ("error", "Block.name: 0 value(s) violates multiplicity '1'", ("n-1",)),
        ("error", "Block.tags: 3 value(s) violates multiplicity '0..2'", ("n-10",)),
        ("error", "Link.label: 0 value(s) violates multiplicity '1'", ("n-12",)),
        ("error", "Owns: element n-19 has 0 target(s), violates target multiplicity '1..2'", ("n-19",)),
        ("error", "Owns: element n-20 has 3 target(s), violates target multiplicity '1..2'", ("n-20",)),
        ("error", "Owns: element n-28 has 2 source(s), violates source multiplicity '0..1'", ("n-28",)),
        ("error", "Block.count: value 'abc' is not a valid integer", ("n-6",)),
        ("error", "Block.ref: reference 'missing-id' points to no element", ("n-7",)),
        ("error", "Block.ref: reference 'n-2' is Block, expected Part or subtype", ("n-8",)),
        ("error", "Block.ref: value 42 is not a valid Part reference", ("n-9",)),
        ("error", "count: -5 below min 0.0", ("n-2",)),
        ("error", "count: 99 above max 10.0", ("n-3",)),
        ("error", "code: 'abc' does not match pattern '[A-Z]+'", ("n-4",)),
        ("error", "code: length 7 exceeds max_length 4", ("n-5",)),
        ("error", "Link: source Part is not one of [Block]", ("n-14",)),
        ("error", "Link: target Block is not one of [Part]", ("n-15",)),
        ("error", "R2: (A, D) matches no declared (source, target) mapping", ("n-18",)),
        ("error", "Element n-33 has 2 containment parents (must have at most one)", ("n-33",)),
        ("error", "Containment cycle detected involving element n-37", ("n-37",)),
        ("error", "Duplicate Block element n-41: matches n-40 (name='Dup')", ("n-41", "n-40")),
        ("error", "Duplicate Doc element n-43: matches n-42 (no key — all properties match)", ("n-43", "n-42")),
    ],
    key=lambda t: (t[1], t[2], t[0]),
)


def _normalized(issues):
    return sorted(
        ((i.severity.value, i.message, tuple(i.target_ids)) for i in issues),
        key=lambda t: (t[1], t[2], t[0]),
    )


def test_full_run_issue_set_matches_snapshot():
    model = _build_model()
    issues = default_pipeline().validate(model, Scope.all())
    assert _normalized(issues) == EXPECTED


def test_scoped_run_matches_full_run_filtered_to_scope():
    model = _build_model()
    # every violating primary target except the cycle partner n-36: the cycle
    # is reported once with a single representative, so scope exactly one of
    # its members to keep old/new pipelines aligned.
    scoped_ids = {t[2][0] for t in EXPECTED}
    # the duplicate primaries must be visible too so the keyed/keyless pairs
    # report the same (dup, primary) target pairs as the full run
    scoped_ids |= {"n-40", "n-42"}
    issues = default_pipeline().validate(model, Scope(scoped_ids))
    expected = [t for t in EXPECTED if t[2][0] in scoped_ids]
    assert _normalized(issues) == sorted(expected, key=lambda t: (t[1], t[2], t[0]))


def test_scoped_run_on_clean_subset_reports_nothing():
    model = _build_model()
    # n-11 (Part P1) and n-21 (Node N1) violate nothing
    issues = default_pipeline().validate(model, Scope({"n-11", "n-21"}))
    assert issues == []
