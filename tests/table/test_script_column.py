"""ScriptColumn schema + evaluation tests. Model/metamodel fixtures follow
tests/table/test_build_rows.py's construction pattern — reuse its helpers."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.cells import ElementsCell, ErrorCell, ValueCell, evaluate_cells
from data_rover.core.table.evaluate import TableLimits, build_rows_ex
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
from tests.script.trusted_runner import TrustedRunner


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
    for name in ("Block A", "Block B", "Block C"):
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


# ---- Task 7: real ScriptColumn evaluation (cells, chaining, expand) ---------
#
# These exercise build_rows_ex/evaluate_cells with a real ScriptEvalContext
# backed by TrustedRunner (test-only, no sandbox — see tests/script/
# trusted_runner.py). Fixture: _mm()/_fixture() above (3 "Block" elements
# named "Block A"/"Block B"/"Block C", each with a `name` string property).


def _script_ctx(model: Model) -> ScriptEvalContext:
    return ScriptEvalContext(TrustedRunner(), model, RunLimits(), ScriptBudget.start(30))


def _one_col_table(code: str, **col_kw) -> TableDefinition:
    return TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[ScriptColumn(snippet=_snip(code), **col_kw)],
    )


def test_script_cell_scalar_and_error() -> None:
    model = _fixture()
    defn = _one_col_table(
        "def value(els):\n"
        "    if els[0].name == 'Block B': raise RuntimeError('boom')\n"
        "    return els[0].name"
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(_mm(), model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(_mm(), model, defn, build.keys, TableLimits(), script=ctx)
    kinds = {type(row[0]).__name__ for row in cells}
    assert "ValueCell" in kinds and "ErrorCell" in kinds
    err = next(r[0] for r in cells if isinstance(r[0], ErrorCell))
    assert "boom" in err.message
    assert ctx.errored
    ctx.close()


def test_script_cell_elements_and_chaining() -> None:
    # column 0 returns the row element; column 1 chains off it via ColumnRef
    model = _fixture()
    mm = _mm()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): return els")),
            ScriptColumn(
                source=ColumnRef(index=0),
                snippet=_snip("def value(els): return els[0].name"),
            ),
        ],
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    for key, row in zip(build.keys, cells, strict=True):
        eid = key[0]
        assert isinstance(eid, str)  # scope row source: always an element id
        cell0, cell1 = row[0], row[1]
        assert isinstance(cell0, ElementsCell)
        assert cell0.element_ids == [eid]
        assert isinstance(cell1, ValueCell)
        assert cell1.value == model.elements[eid].properties.get("name")
    ctx.close()


def test_script_expand_scalars_wrap_property_value() -> None:
    model = _fixture()
    mm = _mm()
    defn = _one_col_table("def value(els): return ['x', 'y']", mode="expand")
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    n_blocks = len(model.indexes.elements_by_type.get("Block", set()))
    assert len(build.keys) == 2 * n_blocks
    cells = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    values: set[object] = set()
    for row in cells:
        assert isinstance(row[0], ValueCell)  # ValueCells, not ElementCells
        values.add(row[0].value)
    assert values == {"x", "y"}
    ctx.close()


def test_script_expand_error_keeps_one_error_row() -> None:
    model = _fixture()
    mm = _mm()
    defn = _one_col_table(
        "def value(els): raise RuntimeError('boom')",
        mode="expand", keep_empty=False,
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    n_blocks = len(model.indexes.elements_by_type.get("Block", set()))
    assert len(build.keys) == n_blocks                  # one row each, not dropped
    cells = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    assert all(isinstance(r[0], ErrorCell) for r in cells)
    ctx.close()


def test_script_dangling_ref_and_unconfigured() -> None:
    model = _fixture()
    mm = _mm()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[ScriptColumn(snippet=SnippetSource(ref="missing")),
                 ScriptColumn(snippet=SnippetSource())],
    )
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    assert all(isinstance(r[0], ErrorCell) and "not found" in r[0].message for r in cells)
    assert all(isinstance(r[1], ValueCell) and not r[1].present for r in cells)
    ctx.close()


def test_script_memo_one_call_per_binding() -> None:
    # module-level counter proves value() ran once per distinct binding even
    # though cells are evaluated after row building touched the same rows
    model = _fixture()
    mm = _mm()
    code = "n = [0]\ndef value(els):\n    n[0] += 1\n    return n[0]"
    defn = _one_col_table(code, keep_empty=False)       # forces build-time calls too
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    counters: list[int] = []
    for row in cells:
        assert isinstance(row[0], ValueCell)
        assert isinstance(row[0].value, int)
        counters.append(row[0].value)
    assert sorted(counters) == list(range(1, len(build.keys) + 1))  # each binding once
    ctx.close()


# ---- Task 8: table sorting by script columns --------------------------------


def test_sort_by_script_column_mixed_kinds_and_errors() -> None:
    from data_rover.core.table.evaluate import SortSpec, order_rows

    # names: rows return int for 'A', string for 'B', error for 'C' — the sort
    # must not raise, numbers sort before strings, errors sort last.
    code = (
        "def value(els):\n"
        "    n = els[0].name\n"
        "    if n == 'Block A': return 2\n"
        "    if n == 'Block B': return 'b'\n"
        "    raise RuntimeError('boom')"
    )
    defn = _one_col_table(code)
    mm = _mm()
    model = _fixture()
    ctx = _script_ctx(model)
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    ordered = order_rows(
        mm, model, defn, build.keys, SortSpec(column=0, direction="asc"),
        TableLimits(), script=ctx,
    )
    names = [
        model.elements[k[0]].properties.get("name")
        for k in ordered
        if isinstance(k[0], str)
    ]
    assert names.index("Block A") < names.index("Block B")       # number before string
    assert names[-1] == "Block C"                                 # error last
    ctx.close()


# ---- Task 5: PendingCell (cache-only misses) ---------------------------------
#
# Task 4 gave ScriptEvalContext a cache-only mode: a cell-cache miss under
# cache_only synthesizes a `pending` CallResult instead of calling the guest.
# These tests prove the table cell layer renders that as a `PendingCell`
# (never as an `ErrorCell`, never setting `ctx.errored`) in both the collapse
# fresh-call path and the expand re-derive path — and that the re-derive path
# never reaches the sandbox even when the surrounding context is live.


class _CountingRunner:
    """Wraps `TrustedRunner`, counting real guest calls (`SnippetSession.call`)
    so a test can prove a code path never reaches the sandbox. `calls` is a
    one-element list (mutable counter) mirroring the shape a real caller would
    use to observe a shared counter across sessions."""

    def __init__(self) -> None:
        self._inner = TrustedRunner()
        self.calls = [0]

    def open_session(self, model: Model, code: str, limits: RunLimits, *, budget):
        session = self._inner.open_session(model, code, limits, budget=budget)
        counts = self.calls

        class _CountingSession:
            boot_error = session.boot_error

            def call(self, entry, element_ids):
                counts[0] += 1
                return session.call(entry, element_ids)

            def close(self) -> None:
                session.close()

        return _CountingSession()

    def run(self, model: Model, req, limits: RunLimits, *, record_ops: bool, rev: int):
        return self._inner.run(model, req, limits, record_ops=record_ops, rev=rev)


def test_pending_cell_from_cache_only_context() -> None:
    # A collapse script column evaluated through a cache-only context with an
    # empty cell cache: every cell must be a PendingCell (never an ErrorCell),
    # `errored` must stay False, and `pending_misses` must record the misses.
    from data_rover.core.script.cell_cache import ScriptCellCache
    from data_rover.core.table.cells import PendingCell

    mm = _mm()
    model = _fixture()
    defn = _one_col_table("def value(els): return els[0].name")
    ctx = ScriptEvalContext(
        TrustedRunner(),
        model,
        RunLimits(),
        ScriptBudget.start(60),
        cell_cache=ScriptCellCache(),
        rev=0,
        cache_only=True,
    )
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    assert build.keys  # sanity: the fixture's 3 Blocks produced rows
    assert all(isinstance(row[0], PendingCell) for row in cells)
    assert not ctx.errored and ctx.pending_misses > 0
    ctx.close()


def test_expand_rederive_is_cache_only() -> None:
    # An expand script column whose BUILD phase ran cache-only (so the
    # promoted binding is None, the same slot value an error row would leave)
    # must NOT trigger a live guest call when the row is later rendered — even
    # though the context is flipped to LIVE (cache_only=False) by then. The
    # expand re-derive branch in `_script_cell` forces `cache_only=True`
    # per-call regardless of the instance attribute.
    from data_rover.core.script.cell_cache import ScriptCellCache
    from data_rover.core.table.cells import PendingCell

    mm = _mm()
    model = _fixture()
    runner = _CountingRunner()
    defn = _one_col_table(
        "def value(els): return els[0].name", mode="expand"
    )
    ctx = ScriptEvalContext(
        runner,
        model,
        RunLimits(),
        ScriptBudget.start(60),
        cell_cache=ScriptCellCache(),
        rev=0,
        cache_only=True,
    )
    build = build_rows_ex(mm, model, defn, TableLimits(), script=ctx)
    n_blocks = len(model.indexes.elements_by_type.get("Block", set()))
    assert len(build.keys) == n_blocks  # one promoted (pending) row per Block
    assert runner.calls[0] == 0  # the build-phase cache-only call never hit the guest

    ctx.cache_only = False  # flip to live for cell-render, as a real caller would
    cells = evaluate_cells(mm, model, defn, build.keys, TableLimits(), script=ctx)
    assert all(isinstance(row[0], PendingCell) for row in cells)
    assert runner.calls[0] == 0  # re-derive still never called the guest
    ctx.close()
