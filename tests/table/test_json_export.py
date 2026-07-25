"""JSON export: schema, key derivation, cell rendering, and grouping.

Grouping is slot arithmetic over the evaluator's RowKey tuples, so these tests
build real rows through `build_rows`/`evaluate_cells` rather than hand-rolling
cells — a hand-rolled cell cannot catch a slot-index mistake."""

import copy

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.table.cells import (
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)
from data_rover.core.table.evaluate import base_slot_count
from data_rover.core.table.json_export import build_group_plan, render_cell, resolve_json_keys
from data_rover.core.table.schema import TABLE_ADAPTER


def _defn(**over):
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}, "header": "Block"}],
    }
    doc.update(over)
    return TABLE_ADAPTER.validate_python(doc)


def test_json_export_defaults_to_none():
    defn = _defn()
    assert defn.columns[0].json_export is None


def test_json_export_parses_all_fields():
    defn = _defn(
        columns=[
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "json_export": {"key": "block", "value": "object", "group": True},
            }
        ]
    )
    opts = defn.columns[0].json_export
    assert opts is not None
    assert (opts.key, opts.value, opts.group) == ("block", "object", True)


def test_json_export_partial_payload_fills_defaults():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "json_export": {"key": "b"}}
        ]
    )
    opts = defn.columns[0].json_export
    assert opts is not None
    assert (opts.key, opts.value, opts.group) == ("b", "name", False)


def test_json_export_available_on_every_column_kind():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "json_export": {"key": "a"}},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "json_export": {"key": "b"},
            },
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "json_export": {"key": "c"},
            },
            {"kind": "script", "source": {"kind": "row"}, "json_export": {"key": "d"}},
        ]
    )
    keys = []
    for c in defn.columns:
        assert c.json_export is not None
        keys.append(c.json_export.key)
    assert keys == ["a", "b", "c", "d"]


def _cols(*specs):
    """One `_defn` per test with N element columns described by dicts."""
    return _defn(columns=[{"kind": "element", "source": {"kind": "row"}, **s} for s in specs])


def test_keys_default_to_the_header():
    keys = resolve_json_keys(_cols({"header": "Name"}, {"header": "Component Mass"}))
    assert keys == ["Name", "Component Mass"]


def test_explicit_key_wins_over_the_header():
    keys = resolve_json_keys(_cols({"header": "Name", "json_export": {"key": "name"}}))
    assert keys == ["name"]


def test_blank_header_falls_back_to_kind_and_index():
    keys = resolve_json_keys(_cols({"header": "A"}, {"header": ""}))
    assert keys == ["A", "element_1"]


def test_duplicate_keys_are_suffixed_first_one_wins():
    keys = resolve_json_keys(_cols({"header": "Mass"}, {"header": "Mass"}, {"header": "Mass"}))
    assert keys == ["Mass", "Mass_2", "Mass_3"]


def test_a_suffix_that_would_itself_collide_keeps_counting():
    keys = resolve_json_keys(_cols({"header": "Mass"}, {"header": "Mass_2"}, {"header": "Mass"}))
    assert keys == ["Mass", "Mass_2", "Mass_3"]


def test_hidden_columns_get_no_key_and_do_not_consume_a_name():
    keys = resolve_json_keys(
        _cols({"header": "Mass", "hidden": True}, {"header": "Mass"})
    )
    assert keys == [None, "Mass"]


def _one_element_model() -> tuple[Model, str]:
    mm = Metamodel(
        elements=[
            ElementType(name="Block", properties=[PropertyDef(name="name", datatype="string")])
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "Root")
    return model, el.id


def test_value_cell_absent_property_is_null():
    model, _ = _one_element_model()
    assert render_cell(model, ValueCell(present=False, value=None, element_id=None, editable=False), "name") is None


def test_value_cell_passes_native_types_through():
    model, _ = _one_element_model()
    cell = ValueCell(present=True, value=12, element_id=None, editable=False)
    assert render_cell(model, cell, "name") == 12


def test_value_cell_declared_but_unset_is_null():
    model, _ = _one_element_model()
    cell = ValueCell(present=True, value=None, element_id=None, editable=False)
    assert render_cell(model, cell, "name") is None


def test_values_cell_is_always_a_list_even_with_one_value():
    model, _ = _one_element_model()
    cell = ValuesCell(present=True, values=["a"], total=1, truncated=False)
    assert render_cell(model, cell, "name") == ["a"]


def test_element_cell_renders_by_mode():
    model, eid = _one_element_model()
    cell = ElementCell(element_id=eid)
    assert render_cell(model, cell, "name") == "Root"
    assert render_cell(model, cell, "id") == eid
    assert render_cell(model, cell, "object") == {
        "id": eid,
        "name": "Root",
        "type": "Block",
    }


def test_empty_element_cell_is_null():
    model, _ = _one_element_model()
    assert render_cell(model, ElementCell(element_id=None), "name") is None


def test_elements_cell_is_a_list_and_empty_is_a_list():
    model, eid = _one_element_model()
    assert render_cell(model, ElementsCell(element_ids=[eid], total=1, truncated=False), "name") == ["Root"]
    assert render_cell(model, ElementsCell(element_ids=[], total=0, truncated=False), "name") == []


def test_error_cell_becomes_an_error_marker():
    model, _ = _one_element_model()
    assert render_cell(model, ErrorCell(message="NameError: foo"), "name") == {
        "$error": "NameError: foo"
    }


def test_pending_cell_reuses_the_not_computed_wording():
    from data_rover.core.table.cells import NOT_COMPUTED_MESSAGE

    model, _ = _one_element_model()
    assert render_cell(model, PendingCell(), "name") == {"$error": NOT_COMPUTED_MESSAGE}


def test_dangling_element_id_becomes_an_error_marker_not_a_crash():
    model, _ = _one_element_model()
    assert render_cell(model, ElementCell(element_id="gone"), "name") == {
        "$error": "unknown element gone"
    }


def _nav_doc() -> dict:
    """Block rows; an expand navigation column; a property sourced from it.

    Returns a DOC, not a definition: every variant below tweaks the doc and
    re-validates through `TABLE_ADAPTER`. Do not reach for
    `model_copy(update=...)` — it skips validation, so `json_export` would stay
    a raw dict and `.group` would blow up with an AttributeError.
    """
    return {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "Component",
            },
            {
                "kind": "property",
                "source": {"kind": "column", "index": 1},
                "name": "mass",
                "header": "Component Mass",
            },
        ],
    }


def _validated(doc: dict, **column_patches: dict):
    """Validate `doc` after merging `{index: patch}` into its columns."""
    doc = copy.deepcopy(doc)
    for index, patch in column_patches.items():
        doc["columns"][int(index)].update(patch)
    return TABLE_ADAPTER.validate_python(doc)


def test_base_slot_count_is_one_for_a_scope_source():
    assert base_slot_count(_validated(_nav_doc()), [("a", "b")]) == 1


def test_no_grouping_means_every_column_is_top_level():
    plan = build_group_plan(_validated(_nav_doc()), base_slots=1)
    assert plan.grouped == ()
    assert plan.top_columns == (0, 1, 2)
    assert plan.top_groups == ()


def test_grouping_pulls_dependents_into_the_group():
    defn = _validated(_nav_doc(), **{"1": {"json_export": {"group": True}}})
    plan = build_group_plan(defn, base_slots=1)
    assert plan.grouped == (1,)
    assert plan.top_columns == (0,)
    assert plan.top_groups == (1,)
    assert plan.members[1] == (1, 2)   # the grouped column itself, then its dependent
    assert plan.children[1] == ()
    assert plan.slot_of[1] == 1        # base slot 0, then the first expand column


def test_group_flag_is_ignored_on_a_collapse_column():
    defn = _validated(
        _nav_doc(), **{"1": {"json_export": {"group": True}, "mode": "collapse"}}
    )
    assert build_group_plan(defn, base_slots=1).grouped == ()


def test_group_flag_is_ignored_on_a_hidden_column():
    defn = _validated(
        _nav_doc(), **{"1": {"json_export": {"group": True}, "hidden": True}}
    )
    assert build_group_plan(defn, base_slots=1).grouped == ()


def test_nested_groups_nest_by_dependency():
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "Part",
                "json_export": {"group": True},
            },
            {
                "kind": "navigation",
                "source": {"kind": "column", "index": 1},
                "navigation": {},
                "mode": "expand",
                "header": "Subpart",
                "json_export": {"group": True},
            },
        ],
    }
    plan = build_group_plan(TABLE_ADAPTER.validate_python(doc), base_slots=1)
    assert plan.grouped == (1, 2)
    assert plan.top_columns == (0,)
    assert plan.top_groups == (1,)
    assert plan.children[1] == (2,)
    assert plan.members[1] == (1,)
    assert plan.members[2] == (2,)
    assert plan.slot_of == {1: 1, 2: 2}


def test_two_independent_groups_are_both_top_level():
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "A",
                "json_export": {"group": True},
            },
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "B",
                "json_export": {"group": True},
            },
        ],
    }
    plan = build_group_plan(TABLE_ADAPTER.validate_python(doc), base_slots=1)
    assert plan.top_groups == (0, 1)
    assert plan.children == {0: (), 1: ()}
    assert plan.slot_of == {0: 1, 1: 2}


def test_innermost_grouped_ancestor_owns_a_dependent():
    """A column depending on BOTH grouped columns belongs to the inner one."""
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "Part",
                "json_export": {"group": True},
            },
            {
                "kind": "navigation",
                "source": {"kind": "column", "index": 0},
                "navigation": {},
                "mode": "expand",
                "header": "Subpart",
                "json_export": {"group": True},
            },
            {
                "kind": "property",
                "source": {"kind": "column", "index": 1},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }
    plan = build_group_plan(TABLE_ADAPTER.validate_python(doc), base_slots=1)
    assert plan.members[0] == (0,)
    assert plan.members[1] == (1, 2)
