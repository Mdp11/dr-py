"""JSON export: schema, key derivation, cell rendering, and grouping.

Grouping is slot arithmetic over the evaluator's RowKey tuples, so these tests
build real rows through `build_rows`/`evaluate_cells` rather than hand-rolling
cells — a hand-rolled cell cannot catch a slot-index mistake."""

import copy

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.table.cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)
from data_rover.core.table.evaluate import TableLimits, build_rows_ex, iter_export_rows
from data_rover.core.table.json_export import (
    build_group_plan,
    render_cell,
    render_json,
    resolve_item_keys,
    resolve_json_keys,
)
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
    return _defn(
        columns=[{"kind": "element", "source": {"kind": "row"}, **s} for s in specs]
    )


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
    keys = resolve_json_keys(
        _cols({"header": "Mass"}, {"header": "Mass"}, {"header": "Mass"})
    )
    assert keys == ["Mass", "Mass_2", "Mass_3"]


def test_a_suffix_that_would_itself_collide_keeps_counting():
    keys = resolve_json_keys(
        _cols({"header": "Mass"}, {"header": "Mass_2"}, {"header": "Mass"})
    )
    assert keys == ["Mass", "Mass_2", "Mass_3"]


def test_hidden_columns_get_no_key_and_do_not_consume_a_name():
    keys = resolve_json_keys(
        _cols({"header": "Mass", "hidden": True}, {"header": "Mass"})
    )
    assert keys == [None, "Mass"]


def _one_element_model() -> tuple[Model, str]:
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="name", datatype="string")]
            )
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "Root")
    return model, el.id


def test_value_cell_absent_property_is_null():
    model, _ = _one_element_model()
    assert (
        render_cell(
            model,
            ValueCell(present=False, value=None, element_id=None, editable=False),
            "name",
        )
        is None
    )


def test_value_cell_passes_native_types_through():
    model, _ = _one_element_model()
    cell = ValueCell(present=True, value=12, element_id=None, editable=False)
    assert render_cell(model, cell, "name") == 12


def test_value_cell_passes_falsy_but_present_values_through():
    # `render_cell` reads `None if not cell.present else cell.value` -- a
    # regression to `cell.value or None` would still pass every other test
    # in this file (they all use truthy values) while silently exporting a
    # real `0`/`""`/`False` as `null`. Pin each falsy-but-present value to
    # itself, not to `None`.
    model, _ = _one_element_model()
    for value in (0, "", False):
        cell = ValueCell(present=True, value=value, element_id=None, editable=False)
        rendered = render_cell(model, cell, "name")
        assert rendered == value
        assert rendered is not None


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
    assert render_cell(
        model, ElementsCell(element_ids=[eid], total=1, truncated=False), "name"
    ) == ["Root"]
    assert (
        render_cell(
            model, ElementsCell(element_ids=[], total=0, truncated=False), "name"
        )
        == []
    )


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
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "name",
                "header": "Name",
            },
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


def _chain_mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="name", datatype="string")]
            )
        ],
        relationships=[
            RelationshipType(name="BlockHasPart", source="Block", target="Block")
        ],
    )


def _chain_fixture(model: Model) -> dict[str, str]:
    """root: a Block owning 3 parts, each a leaf Block."""
    ids: dict[str, str] = {}
    for key, name in [
        ("root", "Root"),
        ("part1", "P1"),
        ("part2", "P2"),
        ("part3", "P3"),
    ]:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        ids[key] = el.id
    for part in ("part1", "part2", "part3"):
        model.connect("BlockHasPart", ids["root"], ids[part])
    return ids


_HAS_PART_STEP = {
    "kind": "relationship",
    "relationship_type": "BlockHasPart",
    "direction": "out",
}


def test_build_rows_ex_base_slots_is_one_for_a_scope_source():
    mm = _chain_mm()
    model = Model(mm)
    _chain_fixture(model)
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [{"kind": "element", "source": {"kind": "row"}}],
        }
    )
    assert build_rows_ex(mm, model, defn).base_slots == 1


def test_build_rows_ex_base_slots_is_the_chain_length_not_the_key_length():
    # chains of length 2 (root, part); one expand column adds a THIRD slot, so
    # a base_slots that just echoed len(key) would wrongly read 3.
    mm = _chain_mm()
    model = Model(mm)
    _chain_fixture(model)
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {
                "kind": "chains",
                "navigation": {
                    "definition": {
                        "kind": "path",
                        "start": {"kind": "scope", "types": ["Block"]},
                        "steps": [_HAS_PART_STEP],
                    }
                },
            },
            "columns": [
                {
                    "kind": "navigation",
                    "source": {"kind": "row", "chain_index": 0},
                    "mode": "expand",
                    "navigation": {
                        "definition": {
                            "kind": "path",
                            "start": {"kind": "row"},
                            "steps": [_HAS_PART_STEP],
                        }
                    },
                },
            ],
        }
    )
    result = build_rows_ex(mm, model, defn)
    assert result.base_slots == 2
    assert result.keys and all(len(k) == 3 for k in result.keys)


def test_build_rows_ex_base_slots_survives_a_capped_build():
    # Two expand columns; max_rows is small enough that the cap trips inside
    # the FIRST one, so the loop breaks before the second ever runs (see
    # `build_rows_ex`'s `if capped: break`). Every built key therefore has
    # base_slots(2) + 1 slot, never base_slots(2) + 2 — and `base_slots`
    # itself, carried from the pre-expand count rather than reconstructed,
    # must still read 2 despite the truncation.
    mm = _chain_mm()
    model = Model(mm)
    _chain_fixture(model)
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {
                "kind": "chains",
                "navigation": {
                    "definition": {
                        "kind": "path",
                        "start": {"kind": "scope", "types": ["Block"]},
                        "steps": [_HAS_PART_STEP],
                    }
                },
            },
            "columns": [
                {
                    "kind": "navigation",
                    "source": {"kind": "row", "chain_index": 0},
                    "mode": "expand",
                    "navigation": {
                        "definition": {
                            "kind": "path",
                            "start": {"kind": "row"},
                            "steps": [_HAS_PART_STEP],
                        }
                    },
                },
                {
                    "kind": "navigation",
                    "source": {"kind": "row", "chain_index": 1},
                    "mode": "expand",
                    "navigation": {
                        "definition": {
                            "kind": "path",
                            "start": {"kind": "row"},
                            "steps": [_HAS_PART_STEP],
                        }
                    },
                },
            ],
        }
    )
    result = build_rows_ex(mm, model, defn, TableLimits(max_rows=2))
    assert result.truncated is True
    assert result.base_slots == 2
    assert result.keys and all(len(k) == 3 for k in result.keys)


def test_grouping_works_with_a_chains_row_source():
    """The one shape where `base_slots != 1`: a `chains` row source combined
    with grouping. This is exactly the case the deleted `base_slot_count`
    formula got wrong, yet no other grouping test exercises it -- they all
    use a `scope` row source, where `base_slots` is always 1 and a hardcoded
    `1` would silently pass.

    Reuses the fixture from the `base_slots` tests above: root owning 3
    parts, chains of (root, part_i). The expand column here hops from the
    chain's root slot (chain_index 0) back out over `BlockHasPart`, so its
    own key slot sits AFTER the two chain slots (`_expand_slot_of` = base_slots
    + 0 = 2) -- grouping must key off the (root, part_i) base slots, not off
    its own slot, or every row would collapse into one group instead of
    three.
    """
    mm = _chain_mm()
    model = Model(mm)
    _chain_fixture(model)
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {
                "kind": "chains",
                "navigation": {
                    "definition": {
                        "kind": "path",
                        "start": {"kind": "scope", "types": ["Block"]},
                        "steps": [_HAS_PART_STEP],
                    }
                },
            },
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row", "chain_index": 1},
                    "name": "name",
                    "header": "Part",
                },
                {
                    "kind": "navigation",
                    "source": {"kind": "row", "chain_index": 0},
                    "mode": "expand",
                    "navigation": {
                        "definition": {
                            "kind": "path",
                            "start": {"kind": "row"},
                            "steps": [_HAS_PART_STEP],
                        }
                    },
                    "header": "Sibling",
                    "json_export": {"group": True},
                },
            ],
        }
    )
    build = build_rows_ex(mm, model, defn)
    docs = render_json(
        model,
        defn,
        build.keys,
        iter_export_rows(mm, model, defn, build.keys),
        build.base_slots,
    )
    # Three base chains -- (root, P1), (root, P2), (root, P3) -- each grouping
    # the sibling expand into the full [P1, P2, P3] set, keyed by the base
    # (root, part_i) slots rather than by the grouped column's own slot.
    assert len(docs) == 3
    assert {d["Part"] for d in docs} == {"P1", "P2", "P3"}
    for d in docs:
        assert d["Sibling"] == ["P1", "P2", "P3"]


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
    assert plan.members[1] == (1, 2)  # the grouped column itself, then its dependent
    assert plan.children[1] == ()
    assert plan.slot_of[1] == 1  # base slot 0, then the first expand column


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
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "name",
                "header": "Name",
            },
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


def _parts_mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="mass", datatype="integer", multiplicity="0..1"),
                ],
            )
        ],
        relationships=[
            RelationshipType(name="BlockHasPart", source="Block", target="Block")
        ],
    )


def _parts_model(mm: Metamodel) -> Model:
    """Root -> (Part 1 mass 12, Part 2 mass 9); Lonely has no parts."""
    model = Model(mm)
    ids = {}
    for key, name, mass in [
        ("root", "Root", None),
        ("p1", "Part 1", 12),
        ("p2", "Part 2", 9),
        ("lonely", "Lonely", None),
    ]:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        if mass is not None:
            model.set_property(el, "mass", mass)
        ids[key] = el.id
    model.connect("BlockHasPart", ids["root"], ids["p1"])
    model.connect("BlockHasPart", ids["root"], ids["p2"])
    return model


def _hop_nav(mode: str, group: bool) -> dict:
    """An inline one-hop navigation column over BlockHasPart.

    The navigation-definition shape is copied verbatim from
    `tests/table/test_cells.py` — `kind: "path"`, a `start`, and
    `relationship_type`/`direction: "out"` steps. Do not invent field names
    here; a mismatch 422s at validation, not at evaluation.
    """
    col = {
        "kind": "navigation",
        "source": {"kind": "row"},
        "navigation": {
            "definition": {
                "kind": "path",
                "start": {"kind": "row"},
                "steps": [
                    {
                        "kind": "relationship",
                        "relationship_type": "BlockHasPart",
                        "direction": "out",
                    }
                ],
            }
        },
        "mode": mode,
        "header": "Component",
    }
    if group:
        col["json_export"] = {"group": True}
    return col


def _render(mm, model, doc):
    defn = TABLE_ADAPTER.validate_python(doc)
    build = build_rows_ex(mm, model, defn)
    return render_json(
        model,
        defn,
        build.keys,
        iter_export_rows(mm, model, defn, build.keys),
        build.base_slots,
    )


def test_ungrouped_is_one_object_per_row():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _hop_nav("expand", group=False),
            ],
        },
    )
    rows = [d for d in docs if d["Name"] == "Root"]
    assert rows == [
        {"Name": "Root", "Component": "Part 1"},
        {"Name": "Root", "Component": "Part 2"},
    ]


def test_ungrouped_does_not_bucket_identical_row_keys():
    """The no-bucketing fast path's own contract: two rows sharing the SAME
    row key must still render as two separate objects when nothing is
    grouped -- bucketing by key would merge them and silently drop a row.

    `test_ungrouped_is_one_object_per_row` doesn't pin this: its two Root
    rows carry DIFFERENT keys (different expand slots), so an implementation
    that bucketed by row key would still pass it. Constructing two rows with
    a genuinely equal key isn't natural through `build_rows_ex` (keys track
    distinct element bindings, one per row), so this calls `render_json`
    directly with hand-built keys/cells -- legitimate here since the target
    is `render_json`'s own contract, not the row builder's.
    """
    mm = _parts_mm()
    model = _parts_model(mm)
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
            ],
        }
    )
    same_key = ("dupe",)
    cells: list[list[Cell]] = [
        [ValueCell(present=True, value="First", element_id=None, editable=False)],
        [ValueCell(present=True, value="Second", element_id=None, editable=False)],
    ]
    docs = render_json(model, defn, [same_key, same_key], iter(cells), 1)
    assert docs == [{"Name": "First"}, {"Name": "Second"}]


def test_grouping_with_no_dependent_unwraps_to_scalars():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _hop_nav("expand", group=True),
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {"Name": "Root", "Component": ["Part 1", "Part 2"]}


def test_grouping_nests_a_dependent_column():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _hop_nav("expand", group=True),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {
        "Name": "Root",
        "Component": [
            {"Component": "Part 1", "Component Mass": 12},
            {"Component": "Part 2", "Component Mass": 9},
        ],
    }


def test_keep_empty_group_is_an_empty_list_not_a_null_entry():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _hop_nav("expand", group=True),
            ],
        },
    )
    lonely = next(d for d in docs if d["Name"] == "Lonely")
    assert lonely == {"Name": "Lonely", "Component": []}


def test_hidden_columns_are_not_emitted():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "mass",
                    "header": "Mass",
                    "hidden": True,
                },
            ],
        },
    )
    assert all(set(d) == {"Name"} for d in docs)


def test_key_order_follows_column_order_with_the_group_in_place():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _hop_nav("expand", group=True),
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "mass",
                    "header": "Own Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert list(root) == ["Name", "Component", "Own Mass"]


def test_groups_merge_even_when_their_rows_are_not_contiguous():
    """Grouping merges by row key through a dict, so an order that scatters a
    group's rows must not produce two objects for one group.

    A plain `reversed()` of the build order does NOT scatter anything --
    reversal preserves adjacency, so a wrong run-length "merge consecutive
    equal keys" implementation would pass it too. The build order here is
    [(Root,P1), (Root,P2), (P1,None), (P2,None), (Lonely,None)] (asserted
    below rather than assumed), so this picks an explicit permutation that
    puts the Lonely row BETWEEN Root's two rows, and asserts up front that
    Root's rows really are non-adjacent -- so this test cannot silently decay
    into a no-op if the fixture ever changes.
    """
    mm = _parts_mm()
    model = _parts_model(mm)
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _hop_nav("expand", group=True),
            ],
        }
    )
    build = build_rows_ex(mm, model, defn)
    keys = build.keys
    root_id = keys[0][0]
    assert [k[0] == root_id for k in keys] == [True, True, False, False, False]

    scattered = [keys[1], keys[4], keys[0], keys[3], keys[2]]
    root_positions = [i for i, k in enumerate(scattered) if k[0] == root_id]
    assert len(root_positions) == 2
    assert root_positions[1] - root_positions[0] > 1, (
        "the chosen permutation must keep Root's two rows non-adjacent, or "
        "this test cannot catch a run-length merge"
    )

    docs = render_json(
        model,
        defn,
        scattered,
        iter_export_rows(mm, model, defn, scattered),
        build.base_slots,
    )
    roots = [d for d in docs if d["Name"] == "Root"]
    assert len(roots) == 1
    assert roots[0] == {"Name": "Root", "Component": ["Part 2", "Part 1"]}


def test_zero_rows_is_an_empty_document():
    mm = _parts_mm()
    model = Model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                }
            ],
        },
    )
    assert docs == []


def _grouped(**over) -> dict:
    """A visible expand column with `group` on — the only shape whose
    `item_key` is honored."""
    col = {
        "kind": "property",
        "source": {"kind": "row"},
        "name": "mass",
        "mode": "expand",
        "header": "Signal",
        "json_export": {"group": True},
    }
    col.update(over)
    return col


def _item_keys(*cols):
    defn = _defn(columns=list(cols))
    return resolve_item_keys(defn, resolve_json_keys(defn))


def test_item_key_defaults_to_empty():
    defn = _defn(columns=[_grouped()])
    opts = defn.columns[0].json_export
    assert opts is not None
    assert opts.item_key == ""


def test_blank_item_key_falls_back_to_the_resolved_group_key():
    assert _item_keys(_grouped(json_export={"group": True, "key": "Signals"})) == [
        "Signals"
    ]


def test_explicit_item_key_wins():
    keys = _item_keys(
        _grouped(json_export={"group": True, "key": "Signals", "item_key": "One Signal"})
    )
    assert keys == ["One Signal"]


def test_item_key_is_none_for_a_column_that_does_not_group():
    keys = _item_keys(
        {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
        _grouped(json_export={"group": True, "item_key": "ignored"}, mode="collapse"),
    )
    assert keys == [None, None]


def test_item_key_is_none_for_a_hidden_grouped_column():
    assert _item_keys(_grouped(hidden=True, json_export={"group": True})) == [None]


def test_an_item_key_equal_to_its_own_group_key_is_not_suffixed():
    """The group key and the item key name the SAME column at two levels, so
    the global 'one key, one column' namespace is not violated and a `_2`
    suffix would be pure noise."""
    keys = _item_keys(_grouped(json_export={"group": True, "key": "Signal"}))
    assert keys == ["Signal"]


def test_an_explicit_item_key_colliding_with_another_column_is_suffixed():
    keys = _item_keys(
        {"kind": "element", "source": {"kind": "row"}, "header": "Mass"},
        _grouped(json_export={"group": True, "key": "Signals", "item_key": "Mass"}),
    )
    assert keys == [None, "Mass_2"]


def test_two_explicit_item_keys_that_collide_are_suffixed():
    keys = _item_keys(
        _grouped(json_export={"group": True, "key": "A", "item_key": "one"}),
        _grouped(json_export={"group": True, "key": "B", "item_key": "one"}),
    )
    assert keys == ["one", "one_2"]


def _nav_group(json_export: dict) -> dict:
    """`_hop_nav('expand', group=True)` with the json_export block spelled out,
    so a test can set `key`/`item_key` on it."""
    col = _hop_nav("expand", group=False)
    col["json_export"] = json_export
    return col


def test_item_key_names_the_value_inside_a_group():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group(
                    {"group": True, "key": "Components", "item_key": "One Component"}
                ),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {
        "Name": "Root",
        "Components": [
            {"One Component": "Part 1", "Component Mass": 12},
            {"One Component": "Part 2", "Component Mass": 9},
        ],
    }


def test_a_blank_item_key_still_repeats_the_group_key():
    """Back-compat: this is the pre-`item_key` output, verbatim."""
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group({"group": True, "key": "Components"}),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {
        "Name": "Root",
        "Components": [
            {"Components": "Part 1", "Component Mass": 12},
            {"Components": "Part 2", "Component Mass": 9},
        ],
    }


def test_item_key_is_unused_when_the_group_unwraps_to_scalars():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group({"group": True, "key": "Components", "item_key": "each"}),
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {"Name": "Root", "Components": ["Part 1", "Part 2"]}


def test_a_grouped_column_keeps_its_group_key_at_the_top_level():
    """The array's own name comes from `key`, never from `item_key` — the
    grouped column is in its home level's group set."""
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(
        mm,
        model,
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _nav_group({"group": True, "key": "Components", "item_key": "each"}),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
    )
    root = next(d for d in docs if d["Name"] == "Root")
    assert set(root) == {"Name", "Components"}
    components = root["Components"]
    assert isinstance(components, list)
    assert set(components[0]) == {"each", "Component Mass"}
