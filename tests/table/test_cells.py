"""Cell-evaluation tests: cell kind derives from column kind x mode x source
arity (see cells.py docstring for the design table). Covers present/editable
derivation for property cells (declared-but-unset vs type-lacks-property vs
expand-mode-never-editable) and the collapse-navigation cell cap/truncation.

Fixture extends Task 4's Block/BlockHasPart metamodel with a `Widget` type
(deliberately WITHOUT `mass`, to exercise present=False) and a many-valued
`tags` property on Block (to exercise expand-mode non-editability)."""

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef, RelationshipType
from data_rover.core.model.model import Model
from data_rover.core.table.cells import ElementCell, ElementsCell, ValueCell, ValuesCell, evaluate_cells
from data_rover.core.table.evaluate import build_rows
from data_rover.core.table.schema import TABLE_ADAPTER


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="mass", datatype="integer", multiplicity="0..1"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                ],
            ),
            ElementType(
                name="Widget",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                ],
            ),
        ],
        relationships=[
            RelationshipType(name="BlockHasPart", source="Block", target="Block"),
        ],
    )


def _fixture(mm: Metamodel) -> tuple[Model, dict[str, str]]:
    """root: a Block owning 2 parts (part1, part2); widget: a standalone Widget."""
    model = Model(mm)
    ids: dict[str, str] = {}
    for key, name in [("root", "Root"), ("part1", "Part 1"), ("part2", "Part 2")]:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        ids[key] = el.id
    model.set_property(model.elements[ids["root"]], "tags", ["a", "b"])
    widget = model.create_element("Widget")
    model.set_property(widget, "name", "Gizmo")
    ids["widget"] = widget.id
    model.connect("BlockHasPart", ids["root"], ids["part1"])
    model.connect("BlockHasPart", ids["root"], ids["part2"])
    return model, ids


def _eval(mm: Metamodel, model: Model, doc: dict):
    defn = TABLE_ADAPTER.validate_python(doc)
    keys, _ = build_rows(mm, model, defn)
    return defn, keys, evaluate_cells(mm, model, defn, keys)


def test_property_present_false_when_type_lacks_property():
    mm = _mm()
    model, ids = _fixture(mm)
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block", "Widget"]},
        "columns": [{"kind": "property", "source": {"kind": "row"}, "name": "mass"}],
    })
    widget_row = next(i for i, k in enumerate(keys) if k[0] == ids["widget"])
    cell = cells[widget_row][0]
    assert isinstance(cell, ValueCell)
    assert cell.present is False
    assert cell.editable is False


def test_property_present_true_unset_is_editable():
    mm = _mm()
    model, ids = _fixture(mm)
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "property", "source": {"kind": "row"}, "name": "mass"}],
    })
    row0 = 0
    cell = cells[row0][0]
    assert isinstance(cell, ValueCell)
    assert cell.present is True
    assert cell.value is None
    assert cell.editable is True
    assert cell.element_id == keys[row0][0]


def test_collapse_navigation_cell_is_elements_cell_capped():
    mm = _mm()
    model, ids = _fixture(mm)
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
            "cell_cap": 1,
            "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                "steps": [{"kind": "relationship",
                           "relationship_type": "BlockHasPart", "direction": "out"}]}}}],
    })
    root_row = next(i for i, k in enumerate(keys) if k[0] == ids["root"])
    cell = cells[root_row][0]
    assert isinstance(cell, ElementsCell)
    assert len(cell.element_ids) == 1
    assert cell.total == 2
    assert cell.truncated is True


def test_expanded_property_cell_not_editable():
    mm = _mm()
    model, ids = _fixture(mm)
    # a Block whose 'tags' property is multiplicity many
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "property", "source": {"kind": "row"}, "name": "tags",
                     "mode": "expand"}],
    })
    cell = cells[0][0]
    assert isinstance(cell, ValueCell)
    assert cell.editable is False


def test_element_column_cell_is_element_cell():
    mm = _mm()
    model, ids = _fixture(mm)
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    })
    for row_idx, key in enumerate(keys):
        cell = cells[row_idx][0]
        assert isinstance(cell, ElementCell)
        assert cell.element_id == key[0]


def test_many_element_collapse_property_yields_values_cell():
    mm = _mm()
    model, ids = _fixture(mm)
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": [{"kind": "relationship",
                            "relationship_type": "BlockHasPart", "direction": "out"}]}}},
            {"kind": "property", "source": {"kind": "column", "index": 0}, "name": "name"},
        ],
    })
    root_row = next(i for i, k in enumerate(keys) if k[0] == ids["root"])
    cell = cells[root_row][1]
    assert isinstance(cell, ValuesCell)
    assert set(cell.values) == {"Part 1", "Part 2"}
    assert cell.total == 2
    assert cell.truncated is False


def test_chain_index_out_of_range_raises_value_error():
    # A chains-source table whose column points at a slot beyond the chain
    # length must fail with a ValueError (API: 422), not an IndexError (500).
    import pytest

    from data_rover.core.table.evaluate import build_rows as _build

    mm = _mm()
    model, _ = _fixture(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "chains", "navigation": {"definition": {
            "kind": "path", "start": {"kind": "scope", "types": ["Block"]},
            "steps": []}}},
        "columns": [{"kind": "element", "source": {"kind": "row", "chain_index": 3}}],
    })
    keys, _ = _build(mm, model, defn)
    with pytest.raises(ValueError, match="chain_index 3 out of range"):
        evaluate_cells(mm, model, defn, keys)


def test_column_ref_step_index_collapse():
    # nav column (collapse) reaches C (last step); a property column sourced
    # from it with step_index=1 reads B's property values.
    mm = _mm()
    model = Model(mm)

    def _mk(name: str) -> str:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        return el.id

    a, b, c = _mk("A"), _mk("B"), _mk("C")
    model.connect("BlockHasPart", a, b)
    model.connect("BlockHasPart", b, c)
    nav_steps = [
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
    ]
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": nav_steps}}},
            {"kind": "property", "source": {"kind": "column", "index": 0, "step_index": 1},
             "name": "name"},
        ],
    })
    row_a = next(i for i, k in enumerate(keys) if k[0] == a)
    nav_cell = cells[row_a][0]
    assert isinstance(nav_cell, ElementsCell)
    assert nav_cell.element_ids == [c]  # default step_index=None -> last step
    prop_cell = cells[row_a][1]
    assert isinstance(prop_cell, ValueCell)
    assert prop_cell.value == "B"
    assert prop_cell.element_id == b


def test_column_ref_step_index_expand_filters_by_row_element():
    # nav column (expand) -> one row per reached C; a values column sourced
    # {"kind": "column", "index": <nav>, "step_index": 1} shows only the
    # intermediate B(s) on chains reaching THAT row's C.
    mm = _mm()
    model = Model(mm)

    def _mk(name: str) -> str:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        return el.id

    a = _mk("A")
    b1, b2, b3 = _mk("B1"), _mk("B2"), _mk("B3")
    c1, c2 = _mk("C1"), _mk("C2")
    model.connect("BlockHasPart", a, b1)
    model.connect("BlockHasPart", a, b2)
    model.connect("BlockHasPart", a, b3)
    model.connect("BlockHasPart", b1, c1)
    model.connect("BlockHasPart", b2, c2)
    model.connect("BlockHasPart", b3, c1)
    nav_steps = [
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
    ]
    _, keys, cells = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "expand",
             "keep_empty": False,
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": nav_steps}}},
            {"kind": "property", "source": {"kind": "column", "index": 0, "step_index": 1},
             "name": "name"},
        ],
    })
    rows_for_a = [i for i, k in enumerate(keys) if k[0] == a]
    assert len(rows_for_a) == 2
    by_target = {keys[i][1]: i for i in rows_for_a}
    assert set(by_target) == {c1, c2}

    cell_c1 = cells[by_target[c1]][1]
    assert isinstance(cell_c1, ValuesCell)
    assert set(cell_c1.values) == {"B1", "B3"}

    cell_c2 = cells[by_target[c2]][1]
    assert isinstance(cell_c2, ValueCell)
    assert cell_c2.value == "B2"


def test_column_ref_step_index_out_of_range_raises():
    import pytest

    mm = _mm()
    model = Model(mm)

    def _mk(name: str) -> str:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        return el.id

    a, b, c = _mk("A"), _mk("B"), _mk("C")
    model.connect("BlockHasPart", a, b)
    model.connect("BlockHasPart", b, c)
    nav_steps = [
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
        {"kind": "relationship", "relationship_type": "BlockHasPart", "direction": "out"},
    ]
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                 "steps": nav_steps}}},
            {"kind": "property", "source": {"kind": "column", "index": 0, "step_index": 9},
             "name": "name"},
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    with pytest.raises(ValueError, match="step_index"):
        evaluate_cells(mm, model, defn, keys)


def test_export_limits_ignore_per_column_cell_cap():
    # The export path must carry the COMPLETE reached set: `ignore_cell_caps`
    # bypasses the per-column display cap (previously min(cell_cap, ...) kept
    # truncating exports to 20 elements no matter the max_cell_elements
    # override).
    from data_rover.core.table.evaluate import TableLimits

    mm = _mm()
    model, ids = _fixture(mm)
    defn, keys, _ = _eval(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
            "cell_cap": 1,
            "navigation": {"definition": {"kind": "path", "start": {"kind": "row"},
                "steps": [{"kind": "relationship",
                           "relationship_type": "BlockHasPart", "direction": "out"}]}}}],
    })
    export_limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)
    cells = evaluate_cells(mm, model, defn, keys, export_limits)
    root_row = next(i for i, k in enumerate(keys) if k[0] == ids["root"])
    cell = cells[root_row][0]
    assert isinstance(cell, ElementsCell)
    assert len(cell.element_ids) == 2  # BOTH parts, despite cell_cap=1
    assert cell.truncated is False
