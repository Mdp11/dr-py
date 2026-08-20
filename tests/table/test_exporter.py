"""The exporter payload schema and the presentation-override application
(spec §3.3/§3.4). `overridden_table` output is RENDER ONLY — these tests pin
that it never touches structural fields and never mutates its input."""

from data_rover.core.table.exporter import (
    EXPORTER_ADAPTER,
    ExporterEntry,
    JsonDocumentOptions,
    TableRef,
    overridden_table,
)
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    ColumnExportOptions,
    JsonColumnOptions,
    JsonSplitOptions,
)


def _defn():
    return TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [
                {"kind": "element", "source": {"kind": "row"}, "header": "A",
                 "export": {"include": False}},
                {"kind": "property", "source": {"kind": "row"}, "name": "mass",
                 "header": "B", "json_export": {"key": "own_key"}},
            ],
            "export_order": [1, 0],
        }
    )


def _entry(**over):
    doc = {"source": {"ref": "tbl-1"}, "name": "out", "format": "json"}
    doc.update(over)
    return ExporterEntry.model_validate(doc)


def test_payload_roundtrips_and_defaults():
    cdef = EXPORTER_ADAPTER.validate_python(
        {"entries": [{"source": {"ref": "tbl-1"}}]}
    )
    e = cdef.entries[0]
    assert (e.source, e.name, e.format) == (TableRef(ref="tbl-1"), "", "xlsx")
    assert (e.columns, e.export_order, e.show_row_numbers) == ([], [], False)
    assert e.json_split is None
    assert cdef.schema_version == 1


def test_overrides_replace_presentation_by_index():
    defn = _defn()
    entry = _entry(
        columns=[{"index": 0, "export": {"include": True, "header": "Renamed"},
                  "json_export": {"key": "k0"}}],
        export_order=[0, 1],
        show_row_numbers=True,
        json_split={"enabled": True, "filename_template": "${name}"},
    )
    out = overridden_table(defn, entry)
    assert out.columns[0].export == ColumnExportOptions(include=True, header="Renamed")
    assert out.columns[0].json_export == JsonColumnOptions(key="k0")
    assert out.export_order == [0, 1]
    assert out.show_row_numbers is True
    assert out.json_split == JsonSplitOptions(enabled=True, filename_template="${name}")


def test_unmentioned_columns_get_DEFAULTS_not_the_tables_own_settings():
    # Column 1 has json_export {"key": "own_key"} on the table — the entry
    # doesn't mention it, so the override output must NOT inherit it (spec:
    # the two config sets never bleed into each other).
    out = overridden_table(_defn(), _entry())
    assert out.columns[1].export is None
    assert out.columns[1].json_export is None


def test_out_of_range_and_duplicate_override_indices_drift_normalize():
    entry = _entry(
        columns=[
            {"index": 99, "export": {"include": True}},
            {"index": 0, "export": {"header": "first"}},
            {"index": 0, "export": {"header": "second"}},  # duplicate: first wins
        ]
    )
    out = overridden_table(_defn(), entry)
    assert out.columns[0].export == ColumnExportOptions(header="first")


def test_structural_fields_and_the_input_are_untouched():
    defn = _defn()
    out = overridden_table(defn, _entry(columns=[{"index": 0}]))
    assert [c.kind for c in out.columns] == [c.kind for c in defn.columns]
    assert out.columns[1].hidden == defn.columns[1].hidden
    assert out.row_source == defn.row_source
    # input not mutated
    assert defn.columns[0].export == ColumnExportOptions(include=False)
    assert defn.columns[1].json_export == JsonColumnOptions(key="own_key")
    assert defn.export_order == [1, 0]


def test_output_options_default_and_roundtrip():
    d = EXPORTER_ADAPTER.validate_python({"entries": []})
    assert d.output.mode == "zip"
    assert d.output.filename == ""
    assert d.output.manifest is True

    d2 = EXPORTER_ADAPTER.validate_python(
        {
            "output": {"mode": "bare", "filename": "x_${rev}", "manifest": False},
            "entries": [{"source": {"ref": "t1"}, "folder": "a/b"}],
        }
    )
    assert d2.output.mode == "bare"
    assert d2.entries[0].folder == "a/b"
    dumped = d2.model_dump()
    assert EXPORTER_ADAPTER.validate_python(dumped) == d2


def test_entry_accepts_all_four_formats_and_json_doc():
    for fmt in ("xlsx", "json", "csv", "jsonl"):
        d = EXPORTER_ADAPTER.validate_python(
            {"entries": [{"source": {"ref": "t1"}, "format": fmt}]}
        )
        assert d.entries[0].format == fmt
    d = EXPORTER_ADAPTER.validate_python(
        {
            "entries": [
                {
                    "source": {"ref": "t1"},
                    "format": "json",
                    "json_doc": {"shape": "object", "key_column": 2,
                                 "pretty": False, "on_error": "fail"},
                }
            ]
        }
    )
    doc = d.entries[0].json_doc
    assert doc is not None
    assert (doc.shape, doc.key_column, doc.pretty, doc.on_error) == (
        "object", 2, False, "fail",
    )


def test_json_doc_defaults_preserve_todays_behavior():
    d = EXPORTER_ADAPTER.validate_python(
        {"entries": [{"source": {"ref": "t1"}}]}
    )
    assert d.entries[0].json_doc is None  # no-migration guarantee
    opts = JsonDocumentOptions()
    assert (opts.shape, opts.key_column, opts.pretty, opts.on_error) == (
        "array", None, True, "emit",
    )
