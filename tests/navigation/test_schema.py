"""NavigationDefinition schema-shape tests (schema v3): each step is a
relationship hop (`kind="relationship"`), a property hop (`kind="property"`),
or a filter (`kind="filter"`). Relationship steps carry a reserved-empty
`children` slot (branch-ready; non-empty rejected); a definition is capped at
MAX_STEPS total items."""

import pytest
from pydantic import ValidationError

from data_rover.core.navigation.schema import (
    MAX_STEPS,
    NAVIGATION_ADAPTER,
    FilterStep,
    Operand,
    PathNavigation,
    RelationshipStep,
    Scope,
    SetExpression,
)
from data_rover.core.search.criteria import PropertyCriterion


def _rel(rt: str = "Owns") -> dict:
    return {"kind": "relationship", "relationship_type": rt}


def _path(n_steps: int = 1) -> dict:
    return {
        "kind": "path",
        "start": {"kind": "scope", "types": ["Block"]},
        "steps": [_rel() for _ in range(n_steps)],
    }


def test_relationship_step_parses_with_defaults() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(_path())
    assert isinstance(nav, PathNavigation)
    assert nav.schema_version == 3
    step = nav.steps[0]
    assert isinstance(step, RelationshipStep)
    assert step.direction == "out"
    assert step.target_types == []
    assert step.children == []


def test_path_name_and_step_comments_round_trip() -> None:
    # UI-only annotations (a user-chosen path name, per-step notes) must
    # survive validate -> dump -> validate so saved artifacts keep them.
    doc = {
        "kind": "path",
        "name": "Buildings sweep",
        "start": {"kind": "scope", "types": ["Block"]},
        "steps": [
            {**_rel(), "comment": "hop to owned parts"},
            {"kind": "filter", "criteria": [], "comment": "keep the active ones"},
        ],
    }
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(nav, PathNavigation)
    assert nav.name == "Buildings sweep"
    assert isinstance(nav.steps[0], RelationshipStep)
    assert nav.steps[0].comment == "hop to owned parts"
    assert isinstance(nav.steps[1], FilterStep)
    assert nav.steps[1].comment == "keep the active ones"
    again = NAVIGATION_ADAPTER.validate_json(NAVIGATION_ADAPTER.dump_json(nav))
    assert again == nav
    # old payloads (no name/comment) still parse, defaulting to None
    bare = NAVIGATION_ADAPTER.validate_python(_path())
    assert isinstance(bare, PathNavigation)
    assert bare.name is None
    assert bare.steps[0].comment is None


def test_relationship_step_carries_target_types() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "scope"},
         "steps": [{"kind": "relationship", "relationship_type": "Owns",
                    "target_types": ["Service", "Database"]}]}
    )
    assert isinstance(nav, PathNavigation)
    step = nav.steps[0]
    assert isinstance(step, RelationshipStep)
    assert step.target_types == ["Service", "Database"]


def test_filter_step_holds_criteria() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "scope"},
         "steps": [{"kind": "filter",
                    "criteria": [{"type": "property", "name": "cost",
                                  "op": "gt", "value": "100"}]}]}
    )
    assert isinstance(nav, PathNavigation)
    step = nav.steps[0]
    assert isinstance(step, FilterStep)
    assert isinstance(step.criteria[0], PropertyCriterion)


def test_interleaved_steps_preserve_order() -> None:
    nav = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "scope"},
         "steps": [_rel("Owns"), {"kind": "filter", "criteria": []}, _rel("Uses")]}
    )
    assert isinstance(nav, PathNavigation)
    kinds = [s.kind for s in nav.steps]
    assert kinds == ["relationship", "filter", "relationship"]


def test_relationship_children_rejected() -> None:
    with pytest.raises(ValidationError):
        RelationshipStep(relationship_type="Owns",
                         children=[RelationshipStep(relationship_type="Uses")])


def test_step_cap_counts_all_items() -> None:
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(_path(MAX_STEPS + 1))


def test_exclude_visited_may_be_set_false() -> None:
    doc = _path()
    doc["exclude_visited"] = False
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(nav, PathNavigation)
    assert nav.exclude_visited is False


def test_set_expression_parses_and_nests() -> None:
    doc = {
        "kind": "set_op",
        "op": "intersection",
        "operands": [
            {"ref": "abc123"},
            {"definition": _path(), "step_index": 0},
            {"definition": {"kind": "set_op", "op": "union",
                            "operands": [{"ref": "def456"}]}},
        ],
    }
    expr = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(expr, SetExpression)
    assert expr.operands[0].ref == "abc123"
    assert isinstance(expr.operands[1].definition, PathNavigation)
    assert expr.operands[1].step_index == 0
    assert isinstance(expr.operands[2].definition, SetExpression)


def test_operand_needs_exactly_one_source() -> None:
    with pytest.raises(ValidationError, match="exactly one"):
        Operand()
    with pytest.raises(ValidationError, match="exactly one"):
        Operand(ref="a", definition=NAVIGATION_ADAPTER.validate_python(_path()))


def test_set_expression_requires_operands() -> None:
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(
            {"kind": "set_op", "op": "union", "operands": []}
        )


def test_path_start_may_be_set_expression() -> None:
    doc = _path()
    doc["start"] = {"kind": "set_op", "op": "union", "operands": [{"ref": "a"}]}
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(nav, PathNavigation)
    assert isinstance(nav.start, SetExpression)


def test_criteria_reuse_search_vocabulary() -> None:
    doc = _path()
    doc["start"]["criteria"] = [
        {"type": "property", "name": "status", "op": "equals", "value": "active"}
    ]
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(nav, PathNavigation)
    assert isinstance(nav.start, Scope)
    criterion = nav.start.criteria[0]
    assert isinstance(criterion, PropertyCriterion)
    assert criterion.op == "equals"


def test_round_trip_preserves_document() -> None:
    doc = _path(2)
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    dumped = NAVIGATION_ADAPTER.dump_python(nav, mode="json")
    assert NAVIGATION_ADAPTER.validate_python(dumped) == nav


def test_row_start_parses_and_is_discriminated():
    from data_rover.core.navigation.schema import NAVIGATION_ADAPTER, RowStart
    defn = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "start": {"kind": "row"}, "steps": []}
    )
    assert isinstance(defn, PathNavigation)
    assert defn.start == RowStart()


def test_schema_version_is_3():
    from data_rover.core.navigation.schema import SCHEMA_VERSION
    assert SCHEMA_VERSION == 3


def test_old_v2_payload_still_valid():
    from data_rover.core.navigation.schema import NAVIGATION_ADAPTER
    defn = NAVIGATION_ADAPTER.validate_python(
        {"kind": "path", "schema_version": 2,
         "start": {"kind": "scope", "types": ["Block"]}, "steps": []}
    )
    assert defn.kind == "path"


def test_property_step_parses_and_roundtrips() -> None:
    doc = {
        "kind": "path",
        "start": {"kind": "scope"},
        "steps": [{"kind": "property", "property_name": "owner", "comment": "why"}],
    }
    nav = NAVIGATION_ADAPTER.validate_python(doc)
    assert isinstance(nav, PathNavigation)
    step = nav.steps[0]
    assert step.kind == "property"
    assert step.property_name == "owner"
    assert step.comment == "why"
    dumped = NAVIGATION_ADAPTER.dump_python(nav)
    assert dumped["steps"][0]["kind"] == "property"


def test_property_step_requires_property_name() -> None:
    doc = {"kind": "path", "start": {"kind": "scope"}, "steps": [{"kind": "property"}]}
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(doc)


def test_max_steps_counts_property_steps() -> None:
    steps = [{"kind": "property", "property_name": "p"}] * (MAX_STEPS + 1)
    with pytest.raises(ValidationError):
        NAVIGATION_ADAPTER.validate_python(
            {"kind": "path", "start": {"kind": "scope"}, "steps": steps}
        )
