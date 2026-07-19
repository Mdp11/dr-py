"""ScriptColumn schema + evaluation tests. Model/metamodel fixtures follow
tests/table/test_build_rows.py's construction pattern — reuse its helpers."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.cells import ErrorCell, ValueCell, evaluate_cells
from data_rover.core.table.evaluate import build_rows_ex
from data_rover.core.table.resolve import resolve_table_refs, table_has_script
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    ColumnRef,
    PropertyColumn,
    RowSlot,
    ScopeRows,
    ScriptColumn,
    TableDefinition,
)


def _snip(code: str) -> SnippetSource:
    return SnippetSource(definition=SnippetDefinition(code=code))


def test_script_column_parses_ref_inline_and_empty() -> None:
    defn = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": []},
            "columns": [
                {"kind": "script", "snippet": {}},  # unconfigured
                {"kind": "script", "snippet": {"ref": "a1"}},  # ref
                {"kind": "script", "snippet": {"definition": {"code": "x=1"}}},
            ],
        }
    )
    assert [c.kind for c in defn.columns] == ["script"] * 3
    col0 = defn.columns[0]
    assert isinstance(col0, ScriptColumn)
    assert col0.snippet.is_empty
    with pytest.raises(ValidationError):
        SnippetSource(ref="a1", definition=SnippetDefinition(code="x=1"))


def test_script_column_is_chainable_but_not_step_indexable() -> None:
    # a ColumnRef against a script column is legal (element-capable at runtime)
    TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): return els")),
            ScriptColumn(source=ColumnRef(index=0), snippet=_snip("def value(els): return 1")),
        ],
    )
    # step_index refs still require a NAVIGATION column
    with pytest.raises(ValidationError, match="navigation column"):
        TableDefinition(
            row_source=ScopeRows(types=[]),
            columns=[
                ScriptColumn(snippet=_snip("def value(els): return els")),
                ScriptColumn(
                    source=ColumnRef(index=0, step_index=1),
                    snippet=_snip("def value(els): return 1"),
                ),
            ],
        )


def test_error_cell_shape() -> None:
    c = ErrorCell(message="boom")
    assert c.traceback is None


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[PropertyDef(name="name", datatype="string")],
            ),
        ],
    )


def _fixture() -> Model:
    model = Model(_mm())
    for name in ("Block A", "Block B"):
        el = model.create_element("Block")
        model.set_property(el, "name", name)
    return model


def test_expand_script_column_keeps_slot_arithmetic() -> None:
    # ScriptColumn(mode="expand") followed by an expand property column:
    # build_rows_ex + evaluate_cells must not IndexError; script cells render
    # empty ValueCells (placeholder era: no script context is passed).
    mm = _mm()
    model = _fixture()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(mode="expand", source=RowSlot(), snippet=SnippetSource()),
            PropertyColumn(name="name", mode="expand"),
        ],
    )
    build = build_rows_ex(mm, model, defn)
    cells = evaluate_cells(mm, model, defn, build.keys)
    assert all(isinstance(r[0], ValueCell) and not r[0].present for r in cells)
    assert all(isinstance(r[1], ValueCell) for r in cells)


def test_resolve_table_inlines_script_column_refs() -> None:
    defn = TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=[ScriptColumn(snippet=SnippetSource(ref="s1")),
                 ScriptColumn(snippet=SnippetSource(ref="missing"))],
    )

    def snippet_fetch(aid: str) -> SnippetDefinition:
        if aid == "s1":
            return SnippetDefinition(code="def value(els): return 1")
        raise LookupError(aid)

    def nav_fetch(aid: str):
        raise LookupError(aid)

    out = resolve_table_refs(defn, nav_fetch, snippet_fetch=snippet_fetch)
    col0, col1 = out.columns
    assert isinstance(col0, ScriptColumn)
    assert isinstance(col1, ScriptColumn)
    assert col0.snippet.definition is not None
    assert col1.snippet.ref == "missing"
    assert table_has_script(out)
    assert not table_has_script(
        TableDefinition(row_source=ScopeRows(types=[]),
                        columns=[ScriptColumn(snippet=SnippetSource())])
    )
