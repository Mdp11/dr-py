"""ScriptColumn schema + evaluation tests. Model/metamodel fixtures follow
tests/table/test_evaluate.py's construction pattern — reuse its helpers."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.cells import ErrorCell
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    ColumnRef,
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
    assert defn.columns[0].snippet.is_empty
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
