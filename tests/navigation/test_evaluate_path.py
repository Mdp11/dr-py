"""Path-evaluation semantics:

- start scope: subtype-INCLUSIVE type match (via element_descendants) +
  criteria (advanced-search matchers); empty types = every element.
- hop: relationship-type match is subtype-inclusive; direction out/in/either;
  target scope filters; parallel edges to the same endpoint yield ONE chain
  (chains are element tuples, deduped per expansion).
- a chain never revisits one of its own elements (cycle guard).
- determinism: chains come out in lexicographic element-id order.
- caps: max_chains / max_visited stop enumeration and set truncated=True.
"""

import pytest

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import ChainResult, EvalLimits, evaluate
from data_rover.core.navigation.schema import (
    NAVIGATION_ADAPTER,
    FilterStep,
    PathNavigation,
    RelationshipStep,
    Scope,
)
from data_rover.core.search.criteria import PropertyCriterion


def _mm() -> Metamodel:
    # `name` must be DECLARED: Model.set_property rejects properties absent
    # from the type's effective schema (model.py mutation boundary).
    return Metamodel(
        elements=[
            ElementType(
                name="Node",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(name="Building", extends="Node"),
            ElementType(name="Sensor", extends="Node"),
        ],
        relationships=[
            RelationshipType(name="Rel", source="Node", target="Node"),
            RelationshipType(name="Owns", extends="Rel", source="Node", target="Node"),
        ],
    )


def _fixture() -> tuple[Model, dict[str, str]]:
    """b1,b2: Buildings; s1,s2,s3: Sensors. Owns: b1->s1, b1->s2, b2->s3.
    Plus a parallel duplicate b1->s1 edge and a plain Rel b1->s3."""
    model = Model(_mm())
    ids: dict[str, str] = {}
    for key, type_name, name in [
        ("b1", "Building", "Plant 1"), ("b2", "Building", "Plant 2"),
        ("s1", "Sensor", "T-1"), ("s2", "Sensor", "T-2"), ("s3", "Sensor", "T-3"),
    ]:
        el = model.create_element(type_name)
        model.set_property(el, "name", name)
        ids[key] = el.id
    model.connect("Owns", ids["b1"], ids["s1"])
    model.connect("Owns", ids["b1"], ids["s1"])  # parallel duplicate
    model.connect("Owns", ids["b1"], ids["s2"])
    model.connect("Owns", ids["b2"], ids["s3"])
    model.connect("Rel", ids["b1"], ids["s3"])
    return model, ids


def _rel(rt: str = "Owns", **kwargs) -> dict:
    return {"kind": "relationship", "relationship_type": rt, **kwargs}


def _path(**overrides):
    doc = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Building"]},
        "steps": [_rel("Owns")],
    }
    doc.update(overrides)
    return NAVIGATION_ADAPTER.validate_python(doc)


def test_linear_hop_dedupes_parallel_edges_and_sorts() -> None:
    model, ids = _fixture()
    result = evaluate(model.metamodel, model, _path())
    expected = sorted([
        (ids["b1"], ids["s1"]), (ids["b1"], ids["s2"]), (ids["b2"], ids["s3"]),
    ])
    assert result.chains == expected
    assert result.step_types == ["Owns"]
    assert result.truncated is False


def test_rel_type_match_is_subtype_inclusive() -> None:
    model, ids = _fixture()
    result = evaluate(model.metamodel, model,
                      _path(steps=[_rel("Rel")]))
    # Owns extends Rel, so all four distinct edges match
    assert (ids["b1"], ids["s3"]) in result.chains
    assert (ids["b1"], ids["s1"]) in result.chains


def test_start_scope_is_subtype_inclusive_and_filtered() -> None:
    model, ids = _fixture()
    nav = _path(start={"kind": "scope", "types": ["Node"],
                       "criteria": [{"type": "property", "name": "name",
                                     "op": "equals", "value": "Plant 1"}]},
                steps=[])
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == [(ids["b1"],)]  # zero steps -> 1-tuples


def test_incoming_and_either_directions() -> None:
    model, ids = _fixture()
    nav = _path(start={"kind": "scope", "types": ["Sensor"]},
                steps=[_rel("Owns", direction="in")])
    result = evaluate(model.metamodel, model, nav)
    assert (ids["s1"], ids["b1"]) in result.chains
    nav = _path(start={"kind": "scope", "types": ["Sensor"]},
                steps=[_rel("Owns", direction="either")])
    assert (ids["s1"], ids["b1"]) in evaluate(model.metamodel, model, nav).chains


def test_target_scope_filters_hop() -> None:
    model, ids = _fixture()
    nav = _path(steps=[
        _rel("Owns"),
        {"kind": "filter", "criteria": [{"type": "property", "name": "name",
                                          "op": "equals", "value": "T-2"}]},
    ])
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == [(ids["b1"], ids["s2"])]


def test_chain_cycle_guard() -> None:
    mm = _mm()
    model = Model(mm)
    a = model.create_element("Node")
    b = model.create_element("Node")
    model.connect("Rel", a.id, b.id)
    model.connect("Rel", b.id, a.id)
    nav = _path(start={"kind": "scope", "types": ["Node"]},
                steps=[_rel("Rel", direction="either"),
                       _rel("Rel", direction="either")])
    result = evaluate(mm, model, nav)
    # a->b->a and b->a->b are forbidden; with only two nodes there is no
    # 3-element chain at all.
    assert result.chains == []


def test_exclude_visited_false_allows_round_trip() -> None:
    model = Model(_mm())
    a = model.create_element("Building")
    b = model.create_element("Sensor")
    model.connect("Owns", a.id, b.id)
    nav = _path(
        start={"kind": "scope", "types": ["Building"]},
        steps=[_rel("Owns", direction="out"), _rel("Owns", direction="in")],
        exclude_visited=False,
    )
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == [(a.id, b.id, a.id)]


def test_exclude_visited_true_or_default_forbids_round_trip() -> None:
    model = Model(_mm())
    a = model.create_element("Building")
    b = model.create_element("Sensor")
    model.connect("Owns", a.id, b.id)
    steps = [_rel("Owns", direction="out"), _rel("Owns", direction="in")]
    nav_default = _path(start={"kind": "scope", "types": ["Building"]}, steps=steps)
    nav_explicit_true = _path(
        start={"kind": "scope", "types": ["Building"]}, steps=steps,
        exclude_visited=True,
    )
    assert evaluate(model.metamodel, model, nav_default).chains == []
    assert evaluate(model.metamodel, model, nav_explicit_true).chains == []


def _two_source_nav(exclude_visited: bool):
    return _path(
        start={"kind": "scope", "types": ["Building"],
               "criteria": [{"type": "property", "name": "name",
                             "op": "equals", "value": "A1"}]},
        steps=[_rel("Owns", direction="out"), _rel("Owns", direction="in")],
        exclude_visited=exclude_visited,
    )


def test_exclude_visited_false_keeps_revisit_and_sibling_chains() -> None:
    model = Model(_mm())
    a1 = model.create_element("Building")
    model.set_property(a1, "name", "A1")
    a2 = model.create_element("Building")
    model.set_property(a2, "name", "A2")
    b = model.create_element("Sensor")
    model.connect("Owns", a1.id, b.id)
    model.connect("Owns", a2.id, b.id)
    result = evaluate(model.metamodel, model, _two_source_nav(False))
    assert result.chains == sorted([(a1.id, b.id, a1.id), (a1.id, b.id, a2.id)])


def test_exclude_visited_true_keeps_only_sibling_chain() -> None:
    model = Model(_mm())
    a1 = model.create_element("Building")
    model.set_property(a1, "name", "A1")
    a2 = model.create_element("Building")
    model.set_property(a2, "name", "A2")
    b = model.create_element("Sensor")
    model.connect("Owns", a1.id, b.id)
    model.connect("Owns", a2.id, b.id)
    result = evaluate(model.metamodel, model, _two_source_nav(True))
    assert result.chains == [(a1.id, b.id, a2.id)]


def test_max_chains_truncates() -> None:
    model, _ids = _fixture()
    limits = EvalLimits(max_chains=2)
    result = evaluate(model.metamodel, model, _path(), limits)
    assert len(result.chains) == 2
    assert result.truncated is True


def test_max_visited_truncates() -> None:
    model, _ids = _fixture()
    limits = EvalLimits(max_visited=1)
    result = evaluate(model.metamodel, model, _path(), limits)
    assert result.truncated is True


def test_empty_types_means_all_elements() -> None:
    model, _ids = _fixture()
    nav = _path(start={"kind": "scope"}, steps=[])
    result = evaluate(model.metamodel, model, nav)
    assert len(result.chains) == 5


def test_determinism() -> None:
    model, _ids = _fixture()
    r1 = evaluate(model.metamodel, model, _path())
    r2 = evaluate(model.metamodel, model, _path())
    assert r1 == r2 == ChainResult(r1.step_types, r1.chains, r1.truncated)


def _cost_mm() -> Metamodel:
    # `cost` is DECLARED on Component (inherited by its subtypes) but only
    # SET on some elements — the fixture for existence-gating tests.
    return Metamodel(
        elements=[
            ElementType(
                name="Component",
                properties=[PropertyDef(name="cost", datatype="string")],
            ),
            ElementType(name="Service", extends="Component"),
            ElementType(name="Database", extends="Component"),
        ],
        relationships=[
            RelationshipType(name="Uses", source="Component", target="Component"),
        ],
    )


def test_filter_step_prunes_without_adding_column() -> None:
    # A relationship step lands on mixed types; a filter step keeps only those
    # with cost > 100. The chain width stays start + 1 (the filter adds no col).
    mm = _cost_mm()
    model = Model(mm)
    root = model.create_element("Component")
    cheap = model.create_element("Service")
    model.set_property(cheap, "cost", "50")
    pricey = model.create_element("Database")
    model.set_property(pricey, "cost", "150")
    model.connect("Uses", root.id, cheap.id)
    model.connect("Uses", root.id, pricey.id)
    defn = PathNavigation(
        kind="path",
        start=Scope(types=["Component"]),
        steps=[
            RelationshipStep(relationship_type="Uses"),
            FilterStep(criteria=[PropertyCriterion(
                type="property", name="cost", op="gt", value="100")]),
        ],
    )
    result = evaluate(mm, model, defn)
    assert result.step_types == ["Uses"]          # filter contributes no header
    assert all(len(chain) == 2 for chain in result.chains)
    assert result.chains == [(root.id, pricey.id)]


def test_property_criterion_is_existence_gated() -> None:
    # An element lacking `cost` must be dropped, not coerced to "".
    mm = _cost_mm()
    model = Model(mm)
    priced = model.create_element("Service")
    model.set_property(priced, "cost", "50")
    unpriced = model.create_element("Database")  # never sets `cost`
    defn = PathNavigation(
        kind="path",
        start=Scope(criteria=[PropertyCriterion(
            type="property", name="cost", op="gte", value="0")]),
        steps=[],
    )
    ids = {c[0] for c in evaluate(mm, model, defn).chains}
    assert all("cost" in model.elements[i].properties for i in ids)
    assert priced.id in ids
    assert unpriced.id not in ids


def test_row_start_binds_to_given_elements() -> None:
    model, ids = _fixture()
    d = _path(start={"kind": "row"}, steps=[])
    res = evaluate(model.metamodel, model, d, row_elements=[ids["b1"]])
    assert res.chains == [(ids["b1"],)]


def test_row_start_without_binding_raises() -> None:
    model, _ids = _fixture()
    d = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "row"}, "steps": []}
    )
    with pytest.raises(ValueError):
        evaluate(model.metamodel, model, d)


def test_target_types_filter_landing() -> None:
    mm = _cost_mm()
    model = Model(mm)
    root = model.create_element("Component")
    svc = model.create_element("Service")
    db = model.create_element("Database")
    model.connect("Uses", root.id, svc.id)
    model.connect("Uses", root.id, db.id)
    defn = PathNavigation(
        kind="path",
        start=Scope(types=["Component"]),
        steps=[RelationshipStep(relationship_type="Uses",
                                target_types=["Database"])],
    )
    result = evaluate(mm, model, defn)
    assert result.chains == [(root.id, db.id)]
    for chain in result.chains:
        assert mm.is_element_subtype(model.elements[chain[1]].type_name, "Database")


def _ref_mm() -> Metamodel:
    # `building`/`peers` are ELEMENT-REFERENCE properties (datatype names an
    # element type; values are element ids). `tags` is a plain string.
    return Metamodel(
        elements=[
            ElementType(
                name="Building",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
            ElementType(
                name="Sensor",
                properties=[
                    PropertyDef(name="building", datatype="Building"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                    PropertyDef(name="peers", datatype="Sensor", multiplicity="0..*"),
                ],
            ),
            ElementType(name="SmartSensor", extends="Sensor"),
        ],
        relationships=[
            RelationshipType(name="Measures", source="Sensor", target="Building"),
        ],
    )


def _prop(name: str) -> dict:
    return {"kind": "property", "property_name": name}


def _ref_fixture() -> tuple[Model, dict[str, str]]:
    model = Model(_ref_mm())
    ids: dict[str, str] = {}
    for key, type_name in [
        ("b1", "Building"), ("b2", "Building"),
        ("s1", "Sensor"), ("s2", "Sensor"), ("smart", "SmartSensor"),
    ]:
        ids[key] = model.create_element(type_name).id
    model.set_property(model.elements[ids["s1"]], "building", ids["b1"])
    model.set_property(model.elements[ids["s1"]], "peers", [ids["s2"], ids["smart"]])
    model.set_property(model.elements[ids["s1"]], "tags", ["hot"])
    model.set_property(model.elements[ids["smart"]], "building", ids["b2"])
    # s2 carries no properties at all.
    return model, ids


def _prop_path(**overrides):
    doc = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Sensor"]},
        "steps": [_prop("building")],
    }
    doc.update(overrides)
    return NAVIGATION_ADAPTER.validate_python(doc)


def test_property_hop_follows_single_reference() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path())
    assert (ids["s1"], ids["b1"]) in result.chains
    assert result.step_types == ["building"]


def test_property_hop_follows_list_reference() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path(steps=[_prop("peers")]))
    assert (ids["s1"], ids["s2"]) in result.chains
    assert (ids["s1"], ids["smart"]) in result.chains


def test_property_hop_resolves_inherited_property() -> None:
    # SmartSensor inherits `building` from Sensor (effective-property lookup).
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path())
    assert (ids["smart"], ids["b2"]) in result.chains


def test_property_hop_prunes_absent_property() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path())
    assert not any(chain[0] == ids["s2"] for chain in result.chains)


def test_property_hop_prunes_non_element_datatype() -> None:
    model, ids = _ref_fixture()
    result = evaluate(model.metamodel, model, _prop_path(steps=[_prop("tags")]))
    assert result.chains == []
    assert result.step_types == ["tags"]


def test_property_hop_skips_dangling_reference() -> None:
    model, ids = _ref_fixture()
    model.set_property(model.elements[ids["s2"]], "building", "no-such-id")
    result = evaluate(model.metamodel, model, _prop_path())
    assert not any(chain[0] == ids["s2"] for chain in result.chains)


def test_property_hop_honors_exclude_visited() -> None:
    model, ids = _ref_fixture()
    model.set_property(model.elements[ids["s2"]], "peers", [ids["s2"]])
    nav = _prop_path(steps=[_prop("peers")])
    assert (ids["s2"], ids["s2"]) not in evaluate(model.metamodel, model, nav).chains
    nav = _prop_path(steps=[_prop("peers")], exclude_visited=False)
    assert (ids["s2"], ids["s2"]) in evaluate(model.metamodel, model, nav).chains


def test_mixed_relationship_and_property_chain() -> None:
    model, ids = _ref_fixture()
    model.connect("Measures", ids["s2"], ids["b1"])
    nav = _prop_path(
        start={"kind": "scope", "types": ["Sensor"]},
        steps=[_prop("peers"), {"kind": "relationship", "relationship_type": "Measures"}],
    )
    result = evaluate(model.metamodel, model, nav)
    assert (ids["s1"], ids["s2"], ids["b1"]) in result.chains
    assert result.step_types == ["peers", "Measures"]
