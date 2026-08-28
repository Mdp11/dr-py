"""Export layout: which columns land in an exported file, in what order.

Every assertion here is about PRESENTATION. The definition's own column order
is structural (backward-only ColumnRef, positional expand slots) and is never
permuted — these tests exist to prove the layout is the only thing that moves.
"""

from data_rover.core.table.export_layout import (
    ROW_NUMBER_SLOT,
    export_definition,
    export_header,
    export_layout,
    normalized_display_order,
    normalized_order,
)
from data_rover.core.table.schema import TABLE_ADAPTER


def _defn(**over):
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }
    doc.update(over)
    return TABLE_ADAPTER.validate_python(doc)


def test_defaults_are_definition_order_with_no_row_number():
    layout = export_layout(_defn())
    assert layout.order == (0, 1)
    assert layout.rank == (0, 1)
    assert layout.row_number_pos is None


def test_column_export_options_default_to_none():
    assert _defn().columns[0].export is None


def test_hidden_column_is_excluded_by_default():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "hidden": True,
            },
        ]
    )
    assert export_layout(defn).order == (0,)


def test_hidden_column_can_be_opted_into_the_export():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "hidden": True,
                "export": {"include": True},
            },
        ]
    )
    assert export_layout(defn).order == (0, 1)
    assert export_definition(defn).columns[1].hidden is False


def test_visible_column_can_be_opted_out_of_the_export():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "export": {"include": False},
            },
        ]
    )
    assert export_layout(defn).order == (0,)
    assert export_definition(defn).columns[1].hidden is True


def test_export_order_permutes_the_output_only():
    defn = _defn(export_order=[1, 0])
    layout = export_layout(defn)
    assert layout.order == (1, 0)
    assert layout.rank == (1, 0)
    # the definition itself is untouched
    assert [c.header for c in defn.columns] == ["Block", "Mass"]


def test_normalized_order_drops_garbage_and_appends_the_rest():
    # 7 is out of range, the second 1 is a duplicate, -1 has no row-number
    # column to stand for; column 0 was never listed and must come back.
    defn = _defn(export_order=[7, 1, 1, ROW_NUMBER_SLOT])
    assert normalized_order(defn) == (1, 0)


def test_row_number_entry_leads_when_unlisted():
    defn = _defn(show_row_numbers=True)
    layout = export_layout(defn)
    assert normalized_order(defn) == (ROW_NUMBER_SLOT, 0, 1)
    assert layout.row_number_pos == 0
    assert layout.order == (0, 1)
    assert layout.rank == (1, 2)


def test_row_number_entry_sits_where_the_order_puts_it():
    defn = _defn(show_row_numbers=True, export_order=[0, ROW_NUMBER_SLOT, 1])
    layout = export_layout(defn)
    assert layout.row_number_pos == 1
    assert layout.rank == (0, 2)


def test_an_excluded_column_before_the_row_number_consumes_no_position():
    """Position compaction, which nothing else pins.

    `export_layout` advances `pos` only for entries that survive, so an
    EXCLUDED column sitting ahead of the row-number slot must not push the
    slot right. Getting this wrong is not a cosmetic misorder: the xlsx caller
    builds `headers` from `layout.order` and then inserts the "#" header at
    `row_number_pos`, so a position that counts a dropped column lands the
    header on the wrong output column — and one past the end is exactly the
    `build_workbook` `ValueError` guard's reason to exist.
    """
    defn = _defn(
        show_row_numbers=True,
        export_order=[0, ROW_NUMBER_SLOT, 1],
        columns=[
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "export": {"include": False},
            },
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ],
    )
    layout = export_layout(defn)
    assert layout.order == (1,)
    assert layout.row_number_pos == 0  # NOT 1 — column 0 is not in the file
    assert layout.rank[1] == 1
    # The header list the xlsx route builds from this stays in range.
    headers = [export_header(defn, i) for i in layout.order]
    headers.insert(layout.row_number_pos, layout.row_number_header)
    assert headers == ["#", "Mass"]


def test_row_number_entry_can_be_excluded():
    defn = _defn(show_row_numbers=True, export_row_number={"include": False})
    layout = export_layout(defn)
    assert layout.row_number_pos is None
    assert layout.rank == (0, 1)


def test_row_number_names_fall_back_to_the_defaults():
    layout = export_layout(_defn(show_row_numbers=True))
    assert layout.row_number_header == "#"
    assert layout.row_number_key == "row_number"


def test_row_number_names_can_be_overridden():
    defn = _defn(
        show_row_numbers=True,
        export_row_number={"header": "No.", "key": "idx"},
    )
    layout = export_layout(defn)
    assert layout.row_number_header == "No."
    assert layout.row_number_key == "idx"


def test_excluded_columns_rank_past_every_included_one():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "export": {"include": False},
            },
        ]
    )
    layout = export_layout(defn)
    assert layout.rank[1] > max(layout.rank[i] for i in layout.order)


def test_export_header_prefers_the_override_then_header_then_kind():
    defn = _defn(
        columns=[
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "export": {"header": "Assembly"},
            },
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
        ]
    )
    assert export_header(defn, 0) == "Assembly"
    assert export_header(defn, 1) == "property"


def test_export_definition_leaves_headers_alone():
    # The xlsx header override must never reach `resolve_json_keys`, which
    # falls back to `col.header` — the two renames are separate by design.
    defn = _defn(
        columns=[
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "export": {"header": "Assembly"},
            },
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
        ]
    )
    assert export_definition(defn).columns[0].header == "Block"


# ---- display_order ---------------------------------------------------------
# The grid's own column order. An export with NO explicit `export_order`
# follows it (the file matches what the user arranged on screen); a partial
# `export_order` is completed in display order rather than definition order.


def test_normalized_display_order_defaults_to_definition_order():
    assert normalized_display_order(_defn()) == (0, 1)


def test_normalized_display_order_drops_garbage_and_appends_the_rest():
    # 7 is out of range, the second 1 a duplicate, -1 is not a column; 0 was
    # never listed and comes back at the end.
    defn = _defn(display_order=[7, 1, 1, -1])
    assert normalized_display_order(defn) == (1, 0)


def test_empty_export_order_follows_the_display_order():
    defn = _defn(display_order=[1, 0])
    assert normalized_order(defn) == (1, 0)
    layout = export_layout(defn)
    assert layout.order == (1, 0)
    # the definition itself is untouched
    assert [c.header for c in defn.columns] == ["Block", "Mass"]


def test_explicit_export_order_wins_over_the_display_order():
    defn = _defn(display_order=[1, 0], export_order=[0, 1])
    assert normalized_order(defn) == (0, 1)


def test_partial_export_order_is_completed_in_display_order():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {"kind": "property", "source": {"kind": "row"}, "name": "a"},
            {"kind": "property", "source": {"kind": "row"}, "name": "b"},
        ],
        display_order=[2, 1, 0],
        export_order=[0],
    )
    assert normalized_order(defn) == (0, 2, 1)


def test_row_number_slot_still_leads_a_display_ordered_export():
    defn = _defn(display_order=[1, 0], show_row_numbers=True)
    assert normalized_order(defn) == (ROW_NUMBER_SLOT, 1, 0)
