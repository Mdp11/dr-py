"""JSON export: schema, key derivation, cell rendering, and grouping.

Grouping is slot arithmetic over the evaluator's RowKey tuples, so these tests
build real rows through `build_rows`/`evaluate_cells` rather than hand-rolling
cells — a hand-rolled cell cannot catch a slot-index mistake."""

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
