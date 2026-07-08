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

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import ChainResult, EvalLimits, evaluate
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER


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


def _path(**overrides):
    doc = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Building"]},
        "steps": [{"relationship_type": "Owns"}],
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
                      _path(steps=[{"relationship_type": "Rel"}]))
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
                steps=[{"relationship_type": "Owns", "direction": "in"}])
    result = evaluate(model.metamodel, model, nav)
    assert (ids["s1"], ids["b1"]) in result.chains
    nav = _path(start={"kind": "scope", "types": ["Sensor"]},
                steps=[{"relationship_type": "Owns", "direction": "either"}])
    assert (ids["s1"], ids["b1"]) in evaluate(model.metamodel, model, nav).chains


def test_target_scope_filters_hop() -> None:
    model, ids = _fixture()
    nav = _path(steps=[{"relationship_type": "Owns",
                        "target": {"kind": "scope",
                                   "criteria": [{"type": "property", "name": "name",
                                                 "op": "equals", "value": "T-2"}]}}])
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
                steps=[{"relationship_type": "Rel", "direction": "either"},
                       {"relationship_type": "Rel", "direction": "either"}])
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
        steps=[{"relationship_type": "Owns", "direction": "out"},
               {"relationship_type": "Owns", "direction": "in"}],
        exclude_visited=False,
    )
    result = evaluate(model.metamodel, model, nav)
    assert result.chains == [(a.id, b.id, a.id)]


def test_exclude_visited_true_or_default_forbids_round_trip() -> None:
    model = Model(_mm())
    a = model.create_element("Building")
    b = model.create_element("Sensor")
    model.connect("Owns", a.id, b.id)
    steps = [{"relationship_type": "Owns", "direction": "out"},
             {"relationship_type": "Owns", "direction": "in"}]
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
        steps=[{"relationship_type": "Owns", "direction": "out"},
               {"relationship_type": "Owns", "direction": "in"}],
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
