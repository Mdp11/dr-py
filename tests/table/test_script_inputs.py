"""resolve_script_inputs / evaluate_script_column against TrustedRunner:
one test per input column kind, plus failure propagation."""

from __future__ import annotations

from typing import Literal

from data_rover.core.metamodel.schema import (
    ElementType,
    Metamodel,
    PropertyDef,
    RelationshipType,
)
from data_rover.core.model.model import Model
from data_rover.core.navigation.schema import PathNavigation, RelationshipStep, RowStart
from data_rover.core.script.cell_cache import ScriptCellCache
from data_rover.core.script.embed import ScriptEvalContext
from data_rover.core.script.runner import RunLimits, ScriptBudget
from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.cells import (
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
    evaluate_cells,
)
from data_rover.core.table.evaluate import (
    SortSpec,
    TableLimits,
    build_rows_ex,
    order_rows,
)
from data_rover.core.table.schema import (
    Column,
    ColumnRef,
    ElementColumn,
    NavigationColumn,
    NavigationSource,
    PropertyColumn,
    ScopeRows,
    ScriptColumn,
    ScriptInput,
    TableDefinition,
)
from data_rover.core.table.script_inputs import (
    InputFailure,
    evaluate_script_column,
    resolve_script_inputs,
)
from tests.script.trusted_runner import TrustedRunner


def _mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="tags", datatype="string", multiplicity="0..*"),
                ],
            )
        ],
        relationships=[RelationshipType(name="Uses", source="Block", target="Block")],
    )


def _model() -> Model:
    model = Model(_mm())
    a = model.create_element("Block")
    model.set_property(a, "name", "A")
    model.set_property(a, "tags", ["x", "y"])
    b = model.create_element("Block")
    model.set_property(b, "name", "B")
    model.connect("Uses", a.id, b.id)
    return model


def _snip(code: str) -> SnippetSource:
    return SnippetSource(definition=SnippetDefinition(code=code))


def _ctx(model: Model, **kw) -> ScriptEvalContext:
    return ScriptEvalContext(
        TrustedRunner(), model, RunLimits(), ScriptBudget.start(30), **kw
    )


def _uses_nav() -> NavigationSource:
    return NavigationSource(
        definition=PathNavigation(
            kind="path",
            start=RowStart(),
            steps=[RelationshipStep(relationship_type="Uses", direction="out")],
        )
    )


def _resolve(model, defn, col_index, ctx):
    build = build_rows_ex(model.metamodel, model, defn, TableLimits(), script=ctx)
    out = []
    for key in build.keys:
        out.append(
            resolve_script_inputs(
                model.metamodel,
                model,
                defn,
                key,
                defn.columns[col_index],
                build.base_slots,
                TableLimits(),
                ctx,
            )
        )
    return build, out


def _row_of(model, name):
    return next(
        i for i, e in model.elements.items() if e.properties.get("name") == name
    )


def test_no_inputs_resolves_to_none():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[ScriptColumn(snippet=_snip("def value(els): return 1"))],
    )
    _, res = _resolve(model, defn, 0, _ctx(model))
    assert res == [None, None]


def test_property_input_is_scalars_flattened():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            PropertyColumn(name="tags"),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return inputs['t']"),
                inputs=[ScriptInput(name="t", ref=ColumnRef(index=0))],
            ),
        ],
    )
    build, res = _resolve(model, defn, 1, _ctx(model))
    by_row = {key[0]: r for key, r in zip(build.keys, res)}
    assert by_row[_row_of(model, "A")] == {
        "t": {"kind": "scalars", "values": ["x", "y"]}
    }
    assert by_row[_row_of(model, "B")] == {"t": {"kind": "scalars", "values": []}}


def test_navigation_input_is_elements():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            NavigationColumn(navigation=_uses_nav()),
            ScriptColumn(
                snippet=_snip(
                    "def value(els, inputs): return [e.name for e in inputs['u']]"
                ),
                inputs=[ScriptInput(name="u", ref=ColumnRef(index=0))],
            ),
        ],
    )
    build, res = _resolve(model, defn, 1, _ctx(model))
    by_row = {key[0]: r for key, r in zip(build.keys, res)}
    assert by_row[_row_of(model, "A")] == {
        "u": {"kind": "elements", "ids": [_row_of(model, "B")]}
    }
    assert by_row[_row_of(model, "B")] == {"u": {"kind": "elements", "ids": []}}


def test_element_and_expand_inputs():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ElementColumn(),
            PropertyColumn(name="tags", mode="expand"),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return inputs['tag']"),
                inputs=[
                    ScriptInput(name="self", ref=ColumnRef(index=0)),
                    ScriptInput(name="tag", ref=ColumnRef(index=1)),
                ],
            ),
        ],
    )
    build, res = _resolve(model, defn, 2, _ctx(model))
    a = _row_of(model, "A")
    rows_a = [r for key, r in zip(build.keys, res) if key[0] == a]
    assert [r["tag"] for r in rows_a] == [
        {"kind": "scalars", "values": ["x"]},
        {"kind": "scalars", "values": ["y"]},
    ]
    assert all(r["self"] == {"kind": "elements", "ids": [a]} for r in rows_a)


def test_script_scalar_input_and_end_to_end_call():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): return len(els[0].name)")),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return inputs['n'][0] * 10"),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )
    ctx = _ctx(model)
    build, res = _resolve(model, defn, 1, ctx)
    assert all(r == {"n": {"kind": "scalars", "values": [1]}} for r in res)
    key = build.keys[0]
    eid = key[0]
    assert isinstance(eid, str)  # scope row source: always an element id
    col1 = defn.columns[1]
    assert isinstance(col1, ScriptColumn)
    out = evaluate_script_column(
        model.metamodel,
        model,
        defn,
        key,
        col1,
        [eid],
        build.base_slots,
        TableLimits(),
        ctx,
    )
    assert out.value == {"kind": "scalar", "value": 10}


def test_errored_input_propagates_without_calling_the_guest():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): raise RuntimeError('boom')")),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return 1"),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )
    ctx = _ctx(model)
    build, res = _resolve(model, defn, 1, ctx)
    f = res[0]
    assert isinstance(f, InputFailure) and f.kind == "error" and f.name == "n"
    assert "boom" in f.message
    key = build.keys[0]
    eid = key[0]
    assert isinstance(eid, str)  # scope row source: always an element id
    col1 = defn.columns[1]
    assert isinstance(col1, ScriptColumn)
    out = evaluate_script_column(
        model.metamodel,
        model,
        defn,
        key,
        col1,
        [eid],
        build.base_slots,
        TableLimits(),
        ctx,
    )
    assert out.error is not None and out.error.kind == "runtime"
    assert out.error.message.startswith("input 'n': ")


def test_pending_input_propagates_and_is_never_cached():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): return 1")),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return 1"),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )
    cache = ScriptCellCache()
    ctx = _ctx(model, cell_cache=cache, rev=0, cache_only=True)
    build, res = _resolve(model, defn, 1, ctx)
    assert all(isinstance(r, InputFailure) and r.kind == "pending" for r in res)
    key = build.keys[0]
    eid = key[0]
    assert isinstance(eid, str)  # scope row source: always an element id
    col1 = defn.columns[1]
    assert isinstance(col1, ScriptColumn)
    out = evaluate_script_column(
        model.metamodel,
        model,
        defn,
        key,
        col1,
        [eid],
        build.base_slots,
        TableLimits(),
        ctx,
    )
    assert out.error is not None and out.error.kind == "pending"
    assert cache.size == 0
    assert not ctx.errored


def test_ref_arity_mismatch_is_a_runtime_error_cell():
    # A ref snippet is inlined by resolve_table_refs AFTER schema validation,
    # so the mismatch surfaces at evaluation: build the resolved definition
    # via model_copy exactly as resolve_table_refs does.
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ElementColumn(),
            ScriptColumn(
                snippet=SnippetSource(ref="s1"),
                inputs=[ScriptInput(name="e", ref=ColumnRef(index=0))],
            ),
        ],
    )
    col = defn.columns[1]
    resolved = defn.model_copy(
        update={
            "columns": [
                defn.columns[0],
                col.model_copy(update={"snippet": _snip("def value(els): return 1")}),
            ]
        }
    )
    ctx = _ctx(model)
    build = build_rows_ex(model.metamodel, model, resolved, TableLimits(), script=ctx)
    key = build.keys[0]
    eid = key[0]
    assert isinstance(eid, str)  # scope row source: always an element id
    col1 = resolved.columns[1]
    assert isinstance(col1, ScriptColumn)
    out = evaluate_script_column(
        model.metamodel,
        model,
        resolved,
        key,
        col1,
        [eid],
        build.base_slots,
        TableLimits(),
        ctx,
    )
    assert out.error is not None
    assert "takes 1 argument but column declares 1 input" in out.error.message


def _table_with_inputs(
    mode: Literal["collapse", "expand"] = "collapse", keep_empty: bool = True
) -> TableDefinition:
    columns: list[Column] = [
        PropertyColumn(name="tags"),
        NavigationColumn(navigation=_uses_nav()),
        ScriptColumn(
            snippet=_snip(
                "def value(els, inputs):\n"
                "    return [t + ':' + u.name for t in inputs['t'] for u in inputs['u']]"
            ),
            inputs=[
                ScriptInput(name="t", ref=ColumnRef(index=0)),
                ScriptInput(name="u", ref=ColumnRef(index=1)),
            ],
            mode=mode,
            keep_empty=keep_empty,
        ),
    ]
    return TableDefinition(row_source=ScopeRows(types=["Block"]), columns=columns)


def test_page_cell_sees_both_inputs():
    model = _model()
    defn = _table_with_inputs()
    ctx = _ctx(model)
    build = build_rows_ex(model.metamodel, model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(model.metamodel, model, defn, build.keys, script=ctx)
    by_row = {key[0]: row[2] for key, row in zip(build.keys, cells)}
    a = by_row[_row_of(model, "A")]
    assert isinstance(a, ValuesCell) and a.values == ["x:B", "y:B"]
    b = by_row[_row_of(model, "B")]
    assert isinstance(b, ValuesCell) and b.values == []


def test_expand_and_keep_empty_filter_use_inputs():
    model = _model()
    ctx = _ctx(model)
    defn = _table_with_inputs(mode="expand", keep_empty=False)
    build = build_rows_ex(model.metamodel, model, defn, TableLimits(), script=ctx)
    # A expands to two rows (x:B, y:B); B has no values and is dropped
    assert [k[0] for k in build.keys] == [_row_of(model, "A")] * 2
    cells = evaluate_cells(model.metamodel, model, defn, build.keys, script=ctx)
    assert [c[2].value for c in cells] == ["x:B", "y:B"]  # type: ignore[union-attr]
    defn2 = _table_with_inputs(mode="collapse", keep_empty=False)
    build2 = build_rows_ex(model.metamodel, model, defn2, TableLimits(), script=ctx)
    assert [k[0] for k in build2.keys] == [_row_of(model, "A")]


def test_sort_by_script_column_with_inputs():
    model = _model()
    ctx = _ctx(model)
    defn = _table_with_inputs()
    build = build_rows_ex(model.metamodel, model, defn, TableLimits(), script=ctx)
    ordered = order_rows(
        model.metamodel,
        model,
        defn,
        build.keys,
        SortSpec(column=2, direction="asc"),
        script=ctx,
    )
    # A has values, B is empty → empties last
    assert [k[0] for k in ordered] == [_row_of(model, "A"), _row_of(model, "B")]


def test_script_column_with_inputs_as_a_source():
    model = _model()
    ctx = _ctx(model)
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            NavigationColumn(navigation=_uses_nav()),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return inputs['u']"),
                inputs=[ScriptInput(name="u", ref=ColumnRef(index=0))],
            ),
            PropertyColumn(name="name", source=ColumnRef(index=1)),
        ],
    )
    build = build_rows_ex(model.metamodel, model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(model.metamodel, model, defn, build.keys, script=ctx)
    by_row = {key[0]: row[2] for key, row in zip(build.keys, cells)}
    a = by_row[_row_of(model, "A")]
    assert isinstance(a, ValueCell) and a.value == "B"


def test_errored_and_pending_inputs_render_as_cells():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): raise RuntimeError('boom')")),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return 1"),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )
    ctx = _ctx(model)
    build = build_rows_ex(model.metamodel, model, defn, TableLimits(), script=ctx)
    cells = evaluate_cells(model.metamodel, model, defn, build.keys, script=ctx)
    c = cells[0][1]
    assert isinstance(c, ErrorCell) and c.message.startswith("input 'n': ")
    defn_ok = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(snippet=_snip("def value(els): return 1")),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return 1"),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )
    ctx2 = _ctx(model, cell_cache=ScriptCellCache(), rev=0, cache_only=True)
    build2 = build_rows_ex(model.metamodel, model, defn_ok, TableLimits(), script=ctx2)
    cells2 = evaluate_cells(model.metamodel, model, defn_ok, build2.keys, script=ctx2)
    assert isinstance(cells2[0][1], PendingCell)


def test_evaluate_script_column_with_no_inputs_calls_one_arg():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[ScriptColumn(snippet=_snip("def value(els): return len(els)"))],
    )
    ctx = _ctx(model)
    build = build_rows_ex(model.metamodel, model, defn, TableLimits(), script=ctx)
    key = build.keys[0]
    eid = key[0]
    assert isinstance(eid, str)  # scope row source: always an element id
    col = defn.columns[0]
    assert isinstance(col, ScriptColumn)
    out = evaluate_script_column(
        model.metamodel,
        model,
        defn,
        key,
        col,
        [eid],
        build.base_slots,
        TableLimits(),
        ctx,
    )
    assert out.error is None
    assert out.value == {"kind": "scalar", "value": 1}


def test_dangling_ref_input_checked_before_empty_roots():
    # The input's referenced column has a dangling ref AND its own roots
    # resolve to nothing for this row: the dangling check must still win.
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            NavigationColumn(navigation=_uses_nav()),
            ScriptColumn(snippet=SnippetSource(ref="s1"), source=ColumnRef(index=0)),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return 1"),
                inputs=[ScriptInput(name="s", ref=ColumnRef(index=1))],
            ),
        ],
    )
    ctx = _ctx(model)
    build, res = _resolve(model, defn, 2, ctx)
    by_row = {key[0]: r for key, r in zip(build.keys, res)}
    b = by_row[_row_of(model, "B")]  # B has no outgoing Uses: col1's roots are empty
    assert isinstance(b, InputFailure)
    assert b.name == "s"
    assert "s1" in b.message
