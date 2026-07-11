import pytest
from pydantic import ValidationError
from data_rover.core.table.schema import TABLE_ADAPTER, SCHEMA_VERSION, RowSlot


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
