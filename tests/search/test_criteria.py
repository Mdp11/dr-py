"""AnyOfCriterion (OR group) matcher + wire-format tests.

The group is the one addition to the shared condition vocabulary: it matches
iff ANY member matches; an EMPTY group is a deliberate no-op (matches
everything); members are leaves only — nesting is structurally
unrepresentable, so a nested group fails validation.
"""

from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.search.criteria import (
    AnyOfCriterion,
    Criterion,
    EntityTypeCriterion,
    NameIdCriterion,
    PropertyCriterion,
    match_element,
    match_relationship,
)

CRITERION_ADAPTER: TypeAdapter[Criterion] = TypeAdapter(Criterion)


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Thing",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="status", datatype="string"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(name="Link", source="Thing", target="Thing"),
        ],
    )


def _model() -> tuple[Model, dict[str, str]]:
    """t1 Alpha/active, t2 Beta/pending, t3 legacy-x/closed; one Link t1->t2."""
    model = Model(_mm())
    ids: dict[str, str] = {}
    for key, name, status in [
        ("t1", "Alpha", "active"),
        ("t2", "Beta", "pending"),
        ("t3", "legacy-x", "closed"),
    ]:
        el = model.create_element("Thing")
        model.set_property(el, "name", name)
        model.set_property(el, "status", status)
        ids[key] = el.id
    model.connect("Link", ids["t1"], ids["t2"])
    return model, ids


def _status(value: str) -> PropertyCriterion:
    return PropertyCriterion(type="property", name="status", op="equals", value=value)


def test_any_of_matches_when_any_member_matches() -> None:
    model, ids = _model()
    group = AnyOfCriterion(
        type="any_of", criteria=[_status("active"), _status("pending")]
    )
    matched = [
        k for k, i in ids.items() if match_element(model, model.elements[i], group)
    ]
    assert matched == ["t1", "t2"]


def test_any_of_mixes_member_kinds() -> None:
    model, ids = _model()
    group = AnyOfCriterion(
        type="any_of",
        criteria=[
            _status("pending"),
            NameIdCriterion(
                type="name_id", field="name", op="contains", value="legacy"
            ),
        ],
    )
    matched = [
        k for k, i in ids.items() if match_element(model, model.elements[i], group)
    ]
    assert matched == ["t2", "t3"]


def test_empty_any_of_is_a_no_op_matching_everything() -> None:
    model, ids = _model()
    group = AnyOfCriterion(type="any_of", criteria=[])
    assert all(match_element(model, model.elements[i], group) for i in ids.values())


def test_any_of_with_no_matching_member_matches_nothing() -> None:
    model, ids = _model()
    group = AnyOfCriterion(type="any_of", criteria=[_status("nope")])
    assert not any(match_element(model, model.elements[i], group) for i in ids.values())


def test_any_of_on_relationships() -> None:
    model, _ids = _model()
    rel = next(iter(model.relationships.values()))
    yes = AnyOfCriterion(
        type="any_of",
        criteria=[EntityTypeCriterion(type="entity_type", names=["Link"])],
    )
    no = AnyOfCriterion(
        type="any_of",
        criteria=[EntityTypeCriterion(type="entity_type", names=["Other"])],
    )
    assert match_relationship(model, rel, yes)
    assert not match_relationship(model, rel, no)


def test_wire_parse_roundtrip() -> None:
    parsed = CRITERION_ADAPTER.validate_python(
        {
            "type": "any_of",
            "criteria": [
                {
                    "type": "property",
                    "name": "status",
                    "op": "equals",
                    "value": "active",
                }
            ],
        }
    )
    assert isinstance(parsed, AnyOfCriterion)
    assert isinstance(parsed.criteria[0], PropertyCriterion)


def test_nested_any_of_is_rejected() -> None:
    with pytest.raises(ValidationError):
        CRITERION_ADAPTER.validate_python(
            {"type": "any_of", "criteria": [{"type": "any_of", "criteria": []}]}
        )
