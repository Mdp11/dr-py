"""Sorting tests: property numeric sort with empties-last in BOTH directions,
navigation count sort, binding-column sort reading straight off the RowKey,
and the collapse-column sort budget guard.

Fixture: root/mid/leaf Blocks; root's `mass`=10, mid's `mass`=2, leaf's `mass`
unset (so leaf is the empty partition in the property-sort tests); root owns
both mid and leaf via `BlockHasPart` (so root has the most parts for the
navigation-count test)."""

import pytest

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.table.evaluate import (
    SortSpec,
    SortTooLargeError,
    TableLimits,
    build_rows,
    order_rows,
)
from data_rover.core.table.schema import TABLE_ADAPTER


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="mass", datatype="integer", multiplicity="0..1"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(name="BlockHasPart", source="Block", target="Block"),
        ],
    )


def _fixture(mm: Metamodel) -> tuple[Model, dict[str, str]]:
    """root: mass=10, owns mid and leaf; mid: mass=2; leaf: mass unset."""
    model = Model(mm)
    ids: dict[str, str] = {}
    for key, name in [("root", "Root"), ("mid", "Mid"), ("leaf", "Leaf")]:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        ids[key] = el.id
    model.set_property(model.elements[ids["root"]], "mass", 10)
    model.set_property(model.elements[ids["mid"]], "mass", 2)
    # leaf's mass left unset deliberately
    model.connect("BlockHasPart", ids["root"], ids["mid"])
    model.connect("BlockHasPart", ids["root"], ids["leaf"])
    return model, ids


def test_property_numeric_sort_empty_last_both_directions():
    mm = _mm()
    model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    asc = order_rows(mm, model, defn, keys, SortSpec(column=1, direction="asc"))
    desc = order_rows(mm, model, defn, keys, SortSpec(column=1, direction="desc"))
    assert asc[0][0] == ids["mid"]  # 2 before 10
    assert asc[-1][0] == ids["leaf"]  # empty last
    assert desc[0][0] == ids["root"]  # 10 first
    assert desc[-1][0] == ids["leaf"]  # still empty last


def test_navigation_count_sort():
    mm = _mm()
    model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "sort_mode": "count",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    desc = order_rows(mm, model, defn, keys, SortSpec(column=1, direction="desc"))
    assert desc[0][0] == ids["root"]  # owns the most parts


def test_binding_column_sort_uses_row_key():
    mm = _mm()
    model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, _ = build_rows(mm, model, defn)
    asc = order_rows(mm, model, defn, keys, SortSpec(column=0, direction="asc"))
    names = [model.elements[str(k[0])].properties.get("name", "") for k in asc]
    assert names == sorted(names, key=str.casefold)


def test_collapse_sort_over_budget_raises():
    mm = _mm()
    model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"},
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    with pytest.raises(SortTooLargeError):
        order_rows(mm, model, defn, keys, SortSpec(column=1, direction="asc"),
                   TableLimits(max_sort_rows=0))


def test_expand_navigation_column_sorts_per_row_own_value():
    # Regression: an `expand` nav column must sort each row by the ONE reached
    # element ITS row's slot holds, not by re-navigating from the shared root
    # (which would tie every row sharing that root on the root's WHOLE reached
    # set and silently ignore the per-row value expansion promoted into the key).
    mm = _mm()
    model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    asc = order_rows(mm, model, defn, keys, SortSpec(column=1, direction="asc"))
    root_rows = [k for k in asc if k[0] == ids["root"]]
    # "Leaf" sorts before "Mid" casefolded — the two rows sharing the root must
    # come out in THAT order, which is only possible if each row's own expanded
    # slot (not the root's shared reached set) drove the comparison.
    assert root_rows == [(ids["root"], ids["leaf"]), (ids["root"], ids["mid"])]


def test_sort_none_returns_input_order_unchanged():
    mm = _mm()
    model, ids = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    keys, _ = build_rows(mm, model, defn)
    result = order_rows(mm, model, defn, keys, None)
    assert result == keys
    assert result is not keys
