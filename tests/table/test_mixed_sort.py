"""Sorting a property column whose name is element-typed on one type and scalar
on another: the shapes never compare with each other. Ascending puts every
scalar row before every element row, descending the reverse, empties last
both ways; inside each shape the order is the single-shape order."""

from typing import Any, cast

import pytest
from sqlalchemy.orm import Session as DbSession

from data_rover.api.routes.tables import evaluate_table
from data_rover.api.schemas import EvaluateTableIn
from data_rover.api.session import Session
from data_rover.api.settings import Settings
from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.table.schema import TABLE_ADAPTER


def _model() -> tuple[Model, dict[str, str]]:
    mm = Metamodel(
        elements=[
            ElementType(
                name="Person", properties=[PropertyDef(name="name", datatype="string")]
            ),
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="owner", datatype="Person", multiplicity="0..1"),
                ],
            ),
            ElementType(
                name="Gadget",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="owner", datatype="string", multiplicity="0..1"),
                ],
            ),
        ],
        relationships=[],
    )
    model = Model(mm)
    ids: dict[str, str] = {}

    def make(type_name: str, name: str, owner: str | None) -> None:
        el = model.create_element(type_name)
        model.set_property(el, "name", name)
        if owner is not None:
            model.set_property(el, "owner", owner)
        ids[name] = el.id

    make("Person", "Zoe", None)
    make("Person", "al", None)
    make("Block", "b-zoe", ids["Zoe"])
    make("Block", "b-al", ids["al"])
    make("Block", "b-none", None)
    make("Gadget", "g-mike", "mike")
    make("Gadget", "g-bob", "Bob")
    make("Gadget", "g-none", None)
    return model, ids


def _order(model: Model, types: list[str], mode: str, direction: str) -> list[str]:
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": types},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}},
                {"kind": "property", "name": "owner", "mode": mode},
            ],
            "sort": [{"column": 1, "direction": direction}],
        }
    )
    page = evaluate_table(
        EvaluateTableIn(definition=defn, offset=0, limit=500),
        "p",
        session=Session(metamodel=model.metamodel, model=model),
        db=cast(DbSession, None),
        runner=None,
        settings=Settings(),
    )
    body: dict[str, Any] = page.model_dump(mode="json")
    return [row["key"][0] for row in body["rows"]]


@pytest.mark.parametrize("mode", ["collapse", "expand"])
def test_mixed_shapes_sort_scalars_first_ascending(mode: str):
    model, ids = _model()
    names = {v: k for k, v in ids.items()}
    asc = [names[i] for i in _order(model, ["Block", "Gadget"], mode, "asc")]
    assert asc[:4] == ["g-bob", "g-mike", "b-al", "b-zoe"]
    assert sorted(asc[4:]) == ["b-none", "g-none"]
    desc = [names[i] for i in _order(model, ["Block", "Gadget"], mode, "desc")]
    assert desc[:4] == ["b-zoe", "b-al", "g-mike", "g-bob"]
    assert desc[4:] == asc[4:]


@pytest.mark.parametrize("mode", ["collapse", "expand"])
@pytest.mark.parametrize("direction", ["asc", "desc"])
def test_each_shape_keeps_its_single_shape_order(mode: str, direction: str):
    model, ids = _model()
    mixed = _order(model, ["Block", "Gadget"], mode, direction)
    for type_name in ("Block", "Gadget"):
        alone = _order(model, [type_name], mode, direction)
        of_type = {i for i in ids.values() if model.elements[i].type_name == type_name}
        assert [i for i in mixed if i in of_type] == alone
