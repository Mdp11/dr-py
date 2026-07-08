"""Set operations act on ELEMENT SETS drawn from operand chains at
step_index (0 = start, k = after step k, None = terminal); difference is a
left fold; results surface as sorted 1-tuple chains; operand truncation
propagates to the result."""

import pytest

from data_rover.core.metamodel.schema import ElementType, Metamodel, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.navigation.evaluate import EvalLimits, evaluate
from data_rover.core.navigation.schema import NAVIGATION_ADAPTER


def _model() -> tuple[Model, dict[str, str]]:
    mm = Metamodel(
        elements=[ElementType(name="B"), ElementType(name="S")],
        relationships=[
            RelationshipType(name="Owns", source="B", target="S"),
            RelationshipType(name="Watches", source="B", target="S"),
        ],
    )
    model = Model(mm)
    ids: dict[str, str] = {}
    for key, tn in [("b1", "B"), ("b2", "B"), ("s1", "S"), ("s2", "S"), ("s3", "S")]:
        ids[key] = model.create_element(tn).id
    model.connect("Owns", ids["b1"], ids["s1"])
    model.connect("Owns", ids["b1"], ids["s2"])
    model.connect("Watches", ids["b2"], ids["s2"])
    model.connect("Watches", ids["b2"], ids["s3"])
    return model, ids


def _owns():
    return {"kind": "path", "start": {"kind": "scope", "types": ["B"]},
            "steps": [{"kind": "relationship", "relationship_type": "Owns"}]}


def _watches():
    return {"kind": "path", "start": {"kind": "scope", "types": ["B"]},
            "steps": [{"kind": "relationship", "relationship_type": "Watches"}]}


def _expr(op, *operands):
    return NAVIGATION_ADAPTER.validate_python(
        {"kind": "set_op", "op": op, "operands": list(operands)}
    )


def test_union_intersection_difference_symmetric_difference() -> None:
    model, ids = _model()
    mm = model.metamodel
    owned = {ids["s1"], ids["s2"]}
    watched = {ids["s2"], ids["s3"]}
    cases = {
        "union": owned | watched,
        "intersection": owned & watched,
        "difference": owned - watched,
        "symmetric_difference": owned ^ watched,
    }
    for op, want in cases.items():
        result = evaluate(mm, model, _expr(op, {"definition": _owns()},
                                          {"definition": _watches()}))
        assert result.chains == [(i,) for i in sorted(want)], op
        assert result.step_types == []


def test_step_index_zero_only_includes_elements_with_chains() -> None:
    # b2 has no Owns edge, so no chain starts at b2 — only elements that
    # actually head a chain contribute to the step-0 set.
    model, ids = _model()
    result = evaluate(model.metamodel, model,
                      _expr("union", {"definition": _owns(), "step_index": 0}))
    assert result.chains == [(ids["b1"],)]


def test_step_index_out_of_range_raises() -> None:
    model, _ids = _model()
    with pytest.raises(ValueError, match="step_index"):
        evaluate(model.metamodel, model,
                 _expr("union", {"definition": _owns(), "step_index": 5}))


def test_path_with_set_expression_start() -> None:
    model, ids = _model()
    doc = {"kind": "path",
           "start": {"kind": "set_op", "op": "intersection",
                     "operands": [{"definition": _owns()},
                                  {"definition": _watches()}]},
           "steps": [{"kind": "relationship", "relationship_type": "Watches", "direction": "in"}]}
    result = evaluate(model.metamodel, model, NAVIGATION_ADAPTER.validate_python(doc))
    # start set = {s2}; incoming Watches -> b2
    assert result.chains == [(ids["s2"], ids["b2"])]
    assert result.step_types == ["Watches"]


def test_nested_expression_and_left_fold_difference() -> None:
    model, ids = _model()
    inner = {"kind": "set_op", "op": "union",
             "operands": [{"definition": _owns()}, {"definition": _watches()}]}
    result = evaluate(model.metamodel, model,
                      _expr("difference", {"definition": inner},
                            {"definition": _watches()}))
    assert result.chains == [(ids["s1"],)]


def test_operand_honors_its_own_exclude_visited_flag() -> None:
    # Each operand's `exclude_visited` travels with its own PathNavigation,
    # so an operand with the flag off can surface a round-trip element that
    # a sibling operand (flag on, the default) cycle-guards away.
    mm = Metamodel(
        elements=[ElementType(name="Node")],
        relationships=[RelationshipType(name="Rel", source="Node", target="Node")],
    )
    model = Model(mm)
    a = model.create_element("Node")
    b = model.create_element("Node")
    model.connect("Rel", a.id, b.id)
    round_trip = {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Node"]},
        "steps": [{"kind": "relationship", "relationship_type": "Rel", "direction": "out"},
                  {"kind": "relationship", "relationship_type": "Rel", "direction": "in"}],
    }
    expr = NAVIGATION_ADAPTER.validate_python({
        "kind": "set_op", "op": "union",
        "operands": [
            {"definition": {**round_trip, "exclude_visited": False}},
            {"definition": {**round_trip, "exclude_visited": True}},
        ],
    })
    result = evaluate(mm, model, expr)
    # terminal step_index (default None): only the exclude_visited=False
    # operand reaches a 3-element chain (a, b, a); the other yields none.
    assert result.chains == [(a.id,)]


def test_truncation_propagates_from_operand() -> None:
    model, _ids = _model()
    result = evaluate(model.metamodel, model,
                      _expr("union", {"definition": _owns()}),
                      EvalLimits(max_chains=1))
    assert result.truncated is True
