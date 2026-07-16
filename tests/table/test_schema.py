import pytest
from pydantic import ValidationError
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    SCHEMA_VERSION,
    ChainRows,
    NavigationColumn,
    RowSlot,
)


def _table(**kw):
    base = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row", "chain_index": 0}}],
    }
    base.update(kw)
    return TABLE_ADAPTER.validate_python(base)


def test_minimal_table_parses():
    t = _table()
    assert t.schema_version == SCHEMA_VERSION
    assert t.default_cell_mode == "collapse"


def test_columns_min_length_one():
    with pytest.raises(ValidationError):
        _table(columns=[])


def test_column_ref_must_point_backward():
    with pytest.raises(ValidationError):
        _table(columns=[
            {"kind": "element", "source": {"kind": "column", "index": 1}},
            {"kind": "element", "source": {"kind": "row"}},
        ])


def test_navigation_column_source_must_be_element_producing():
    # a property column produces values, not elements
    with pytest.raises(ValidationError):
        _table(columns=[
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
            {"kind": "navigation", "source": {"kind": "column", "index": 0},
             "navigation": {"definition": {"kind": "path",
                             "start": {"kind": "row"}, "steps": []}}},
        ])


def test_element_column_source_must_be_single_binding():
    # sourcing an element column from a collapse navigation column (n elements)
    with pytest.raises(ValidationError):
        _table(columns=[
            {"kind": "navigation", "source": {"kind": "row"}, "mode": "collapse",
             "navigation": {"definition": {"kind": "path",
                             "start": {"kind": "row"}, "steps": []}}},
            {"kind": "element", "source": {"kind": "column", "index": 0}},
        ])


def test_chain_index_nonzero_requires_chains_source():
    with pytest.raises(ValidationError):
        _table(columns=[{"kind": "element", "source": {"kind": "row", "chain_index": 2}}])


def test_element_column_source_must_be_element_producing():
    # A2 hazard: a ColumnRef to an EXPAND property column is single-binding
    # (one value per row) but does NOT produce elements — it produces the
    # property's scalar value. An element column sourced from it must be
    # rejected at schema validation, not crash at eval time (final-review A3).
    with pytest.raises(ValidationError):
        _table(columns=[
            {"kind": "property", "source": {"kind": "row"}, "name": "mass",
             "mode": "expand"},
            {"kind": "element", "source": {"kind": "column", "index": 0}},
        ])


def test_element_column_source_from_element_producing_column_ok():
    # A legitimate ColumnRef chain: an element column sourced from an earlier
    # element column must still validate.
    t = _table(columns=[
        {"kind": "element", "source": {"kind": "row"}},
        {"kind": "element", "source": {"kind": "column", "index": 0}},
    ])
    assert len(t.columns) == 2


def test_empty_navigation_source_allowed():
    # An UNCONFIGURED navigation source ({} — no ref, no definition) is a legal
    # transient UI state (the editor creates the column before the user picks a
    # navigation). It must parse — evaluation treats it as reaching nothing —
    # instead of 422-ing every request for the whole table until configured.
    t = _table(columns=[
        {"kind": "element", "source": {"kind": "row"}},
        {"kind": "navigation", "source": {"kind": "row"}, "navigation": {}},
    ])
    col = t.columns[1]
    assert isinstance(col, NavigationColumn)
    assert col.navigation.ref is None and col.navigation.definition is None
    # same for the row source's navigation
    t = _table(
        row_source={"kind": "chains", "navigation": {}},
        columns=[{"kind": "element", "source": {"kind": "row"}}],
    )
    assert isinstance(t.row_source, ChainRows)
    assert t.row_source.navigation.ref is None


def test_navigation_source_rejects_both_ref_and_definition():
    with pytest.raises(ValidationError, match="at most one"):
        _table(columns=[
            {"kind": "element", "source": {"kind": "row"}},
            {"kind": "navigation", "source": {"kind": "row"},
             "navigation": {"ref": "abc", "definition": {"kind": "path",
                            "start": {"kind": "row"}, "steps": []}}},
        ])


def test_hidden_defaults_false_and_parses():
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": []},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}},
                {"kind": "property", "name": "p", "hidden": True},
            ],
        }
    )
    assert defn.columns[0].hidden is False
    assert defn.columns[1].hidden is True


def test_source_step_index_requires_navigation_ref():
    with pytest.raises(ValidationError, match="navigation column"):
        TABLE_ADAPTER.validate_python(
            {
                "row_source": {"kind": "scope", "types": []},
                "columns": [
                    {"kind": "element", "source": {"kind": "row"}},
                    {
                        "kind": "property",
                        "name": "p",
                        "source": {"kind": "column", "index": 0, "step_index": 1},
                    },
                ],
            }
        )


def test_source_step_index_on_expand_nav_is_multi_binding():
    # an element column needs a single-binding source; a step-index override
    # on an expand nav ref returns the (possibly many) step elements
    with pytest.raises(ValidationError, match="single-binding"):
        TABLE_ADAPTER.validate_python(
            {
                "row_source": {"kind": "scope", "types": []},
                "columns": [
                    {"kind": "element", "source": {"kind": "row"}},
                    {"kind": "navigation", "navigation": {}, "mode": "expand"},
                    {
                        "kind": "element",
                        "source": {"kind": "column", "index": 1, "step_index": 1},
                    },
                ],
            }
        )


def test_chain_index_nonzero_ok_with_chains_source():
    t = _table(
        row_source={"kind": "chains",
                    "navigation": {"definition": {"kind": "path",
                                   "start": {"kind": "scope", "types": ["Block"]},
                                   "steps": []}}},
        columns=[{"kind": "element", "source": {"kind": "row", "chain_index": 2}}],
    )
    source = t.columns[0].source
    assert isinstance(source, RowSlot)
    assert source.chain_index == 2
