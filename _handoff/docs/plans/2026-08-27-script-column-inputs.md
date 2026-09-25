# Script Column Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A table `ScriptColumn` can declare named inputs — refs to earlier columns — whose per-row values are handed to the snippet as `value(elements, inputs)` with `inputs: dict[str, list]`.

**Architecture:** `ScriptInput {name, ref: ColumnRef}` joins the table schema (backward-only refs, so cycles are structurally impossible). A new `core/table/script_inputs.py` resolves each input to exactly what that column's cell holds for the row (`{"kind": "elements", "ids"}` / `{"kind": "scalars", "values"}`), and `evaluate_script_column` becomes the single wrapper every call site uses — a pending/errored input yields a synthetic pending/error `CallResult` that never touches the memo or cell cache. The resolved inputs are carried on the bridge `call` frame as an optional `"inputs"` field and baked into the memo/cell-cache key as a fourth component (`""` when absent, so every existing key stays byte-identical). The sweep resolves inputs live during its serial enumeration, following the existing script-as-source precedent.

**Tech Stack:** Python 3.14 / pydantic v2 / pytest (`pixi run -e core-dev pytest`), SvelteKit + zod + vitest (`pixi run frontend-test`), `TrustedRunner` (tests only) for in-process snippet execution.

**Spec:** `docs/superpowers/specs/2026-08-27-script-column-inputs-design.md`

## Global Constraints

- Toolchain: everything through `pixi run`. Python tests: `pixi run -e core-dev pytest <path> -v`. Lint/format/typecheck (ruff + mypy + pyright): `pixi run core-lint` and `pixi run backend-lint`; frontend: `pixi run frontend-check` and `pixi run frontend-test`.
- A column with no `inputs` must keep calling `value(elements)` with ONE argument; existing snippets, cache keys and sweep behaviour must be byte-identical.
- `inputs[name]` is always a `list`; `[]` for an empty cell.
- Failure propagation: pending input → pending cell; errored input → error cell `input '<name>': <message>`; neither memoized nor cell-cached.
- `docs/` is gitignored in this repo — commit code and tests only; spec/plan stay untracked.
- Comments: concise, present tense, only for non-obvious invariants. No references to plans/phases/tasks.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_013QbbSEzqe9iYBs6a6d2vLZ
  ```

## File map

| File | Responsibility |
|---|---|
| `src/data_rover/core/script/lint.py` | `entry_arity(code, name)`; `value` accepts arity 1 or 2 |
| `src/data_rover/core/table/schema.py` | `ScriptInput`, `ScriptColumn.inputs`, static validation incl. inline arity |
| `src/data_rover/core/script/runner.py` | `WireInput`/`WireInputs` types, `input_element_ids`, `SnippetSession.call(..., inputs=)` |
| `src/data_rover/core/script/facade_src.py` | guest `_dr_call_entry` builds the inputs dict and calls `fn(els, inputs)` |
| `src/data_rover/api/script_runner.py` | host frame carries `"inputs"`, projects input element ids |
| `tests/script/trusted_runner.py` | mirrors the host |
| `src/data_rover/core/script/cell_cache.py` | `CellKey` 4-tuple, `inputs_digest` |
| `src/data_rover/core/script/embed.py` | `ScriptEvalContext.call(..., inputs=)` keyed by digest |
| `src/data_rover/core/table/script_inputs.py` (new) | `resolve_script_inputs`, `evaluate_script_column`, `property_input_values` |
| `src/data_rover/core/table/cells.py`, `evaluate.py` | call sites route through `evaluate_script_column` |
| `src/data_rover/api/script_sweep.py` | `_Item` carries inputs; enumeration resolves them |
| `frontend/src/lib/api/types.ts`, `table/columns.ts` | zod mirror; ref remapping on move/remove/clone |
| `frontend/src/lib/components/Table/ColumnSourceEditor.svelte` | `allowRow` prop (column-only mode) |
| `frontend/src/lib/components/Table/ScriptInputsEditor.svelte` (new) | the Inputs block |
| `frontend/src/lib/components/Table/ScriptColumnEditor.svelte` | mounts the Inputs block |
| `frontend/src/lib/snippet/entry-stubs.ts` | 2-arg stub/hint when inputs exist |
| docs | `core/script/README.md`, `CLAUDE.md`, `frontend/README.md` |

---

### Task 1: Lint — `entry_arity` and a two-arg `value`

**Files:**
- Modify: `src/data_rover/core/script/lint.py:30-38, 58-68, 104-118`
- Test: `tests/script/test_lint.py`

**Interfaces:**
- Produces: `entry_arity(code: str, name: str) -> int | None` — positional parameter count of the top-level `def <name>`, `None` when absent or unparseable. `derive_entry_points` lists `"value"` for arity 1 OR 2.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_lint.py`:

```python
from data_rover.core.script.lint import entry_arity


def test_two_arg_value_is_an_entry_point():
    assert "value" in derive_entry_points("def value(els, inputs):\n    return 1\n")
    assert "value" not in derive_entry_points("def value(a, b, c):\n    return 1\n")
    # step/transform keep the strict one-arg rule
    assert "step" not in derive_entry_points("def step(el, x):\n    return []\n")


def test_entry_arity():
    assert entry_arity("def value(els):\n    return 1\n", "value") == 1
    assert entry_arity("def value(els, inputs):\n    return 1\n", "value") == 2
    assert entry_arity("x = 1\n", "value") is None
    assert entry_arity("x = (", "value") is None


def test_two_arg_value_is_not_a_lint_warning():
    assert lint_code("def value(els, inputs):\n    return inputs\n") == []
    diags = lint_code("def value(a, b, c):\n    return 1\n")
    assert any("value()" in d.message and d.severity == "warning" for d in diags)
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_lint.py -v`
Expected: FAIL — `ImportError: cannot import name 'entry_arity'`.

- [ ] **Step 3: Implement**

In `src/data_rover/core/script/lint.py` replace the `_ENTRY_NAMES`/`_ENTRY_ARG_DESC` block with:

```python
_ENTRY_NAMES = ("value", "step", "transform")
#: Accepted positional-parameter counts per entry. `value` takes the bound
#: element list plus, on a column that declares inputs, the inputs dict.
_ENTRY_ARITIES: dict[str, tuple[int, ...]] = {
    "value": (1, 2),
    "step": (1,),
    "transform": (1,),
}
_ENTRY_ARG_DESC = {
    "value": "the list of elements, optionally followed by the inputs dict",
    "step": "the element",
    "transform": "the document",
}
```

Replace `derive_entry_points` and add `entry_arity`:

```python
def _positional_count(node: ast.FunctionDef) -> int:
    return len(node.args.posonlyargs) + len(node.args.args)


def derive_entry_points(code: str) -> list[str]:
    tree, _ = _parse(code)
    if tree is None:
        return []
    eps = ["script"]
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _ENTRY_NAMES:
            if _positional_count(node) in _ENTRY_ARITIES[node.name]:
                eps.append(node.name)
    # stable, de-duped
    return list(dict.fromkeys(eps))


def entry_arity(code: str, name: str) -> int | None:
    """Positional-parameter count of the top-level `def <name>`; None when the
    code does not parse or defines no such function."""
    tree, _ = _parse(code)
    if tree is None:
        return None
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return _positional_count(node)
    return None
```

In `lint_code`'s "entry-point signature checks" loop, replace the `argc != 1` check:

```python
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _ENTRY_NAMES:
            argc = _positional_count(node)
            allowed = _ENTRY_ARITIES[node.name]
            if argc not in allowed:
                expect = " or ".join(str(a) for a in allowed)
                diags.append(
                    Diagnostic(
                        node.lineno,
                        node.col_offset,
                        "warning",
                        f"{node.name}() must take {expect} argument(s) "
                        f"({_ENTRY_ARG_DESC[node.name]}), got {argc}",
                    )
                )
```

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/script/test_lint.py -v`
Expected: PASS. Then `pixi run -e core-dev pytest tests/script tests/api/test_snippets_routes.py -q` (existing lint-message assertions may match on `"exactly one argument"` — update any such assertion to the new wording).

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add src/data_rover/core/script/lint.py tests/script/test_lint.py
git commit -m "feat(script): value() entry point accepts one or two positional args; entry_arity helper"
```

---

### Task 2: Schema — `ScriptInput` and `ScriptColumn.inputs`

**Files:**
- Modify: `src/data_rover/core/table/schema.py:90-100, 255-279, 313-340`
- Test: `tests/table/test_schema.py`, `tests/api/test_artifacts_routes.py`

**Interfaces:**
- Consumes: `entry_arity` (Task 1).
- Produces: `ScriptInput(name: str, ref: ColumnRef)`; `ScriptColumn.inputs: list[ScriptInput]` (default `[]`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/table/test_schema.py`:

```python
import pytest
from pydantic import ValidationError

from data_rover.core.script.schema import SnippetDefinition, SnippetSource
from data_rover.core.table.schema import (
    TABLE_ADAPTER,
    ColumnRef,
    ElementColumn,
    PropertyColumn,
    ScopeRows,
    ScriptColumn,
    ScriptInput,
    TableDefinition,
)


def _code(code: str) -> SnippetSource:
    return SnippetSource(definition=SnippetDefinition(code=code))


TWO_ARG = "def value(els, inputs): return 1"
ONE_ARG = "def value(els): return 1"


def _cols(*extra):
    return [ElementColumn(), PropertyColumn(name="name"), *extra]


def test_script_inputs_default_empty_and_round_trip():
    defn = TableDefinition(row_source=ScopeRows(types=[]), columns=[ScriptColumn()])
    col = defn.columns[0]
    assert isinstance(col, ScriptColumn) and col.inputs == []
    assert "inputs" in TABLE_ADAPTER.dump_python(defn)["columns"][0]
    parsed = TABLE_ADAPTER.validate_python(
        {
            "row_source": {"kind": "scope", "types": []},
            "columns": [
                {"kind": "property", "name": "name"},
                {
                    "kind": "script",
                    "snippet": {"definition": {"code": TWO_ARG}},
                    "inputs": [{"name": "nm", "ref": {"kind": "column", "index": 0}}],
                },
            ],
        }
    )
    col1 = parsed.columns[1]
    assert isinstance(col1, ScriptColumn)
    assert col1.inputs[0].name == "nm" and col1.inputs[0].ref.index == 0


def test_script_input_must_point_backward():
    with pytest.raises(ValidationError, match="must be < 2"):
        TableDefinition(
            row_source=ScopeRows(types=[]),
            columns=_cols(
                ScriptColumn(
                    snippet=_code(TWO_ARG),
                    inputs=[ScriptInput(name="x", ref=ColumnRef(index=2))],
                )
            ),
        )


def test_script_input_names_are_identifiers_and_unique():
    with pytest.raises(ValidationError, match="not a valid identifier"):
        ScriptInput(name="not valid", ref=ColumnRef(index=0))
    with pytest.raises(ValidationError, match="not a valid identifier"):
        ScriptInput(name="class", ref=ColumnRef(index=0))
    with pytest.raises(ValidationError, match="duplicate input name"):
        TableDefinition(
            row_source=ScopeRows(types=[]),
            columns=_cols(
                ScriptColumn(
                    snippet=_code(TWO_ARG),
                    inputs=[
                        ScriptInput(name="a", ref=ColumnRef(index=0)),
                        ScriptInput(name="a", ref=ColumnRef(index=1)),
                    ],
                )
            ),
        )


def test_script_input_step_index_requires_navigation_ref():
    with pytest.raises(ValidationError, match="navigation column"):
        TableDefinition(
            row_source=ScopeRows(types=[]),
            columns=_cols(
                ScriptColumn(
                    snippet=_code(TWO_ARG),
                    inputs=[ScriptInput(name="a", ref=ColumnRef(index=0, step_index=1))],
                )
            ),
        )


def test_script_input_any_column_kind_is_legal():
    # property (not element-producing) is fine as an INPUT, unlike a source
    TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=_cols(
            ScriptColumn(
                snippet=_code(TWO_ARG),
                inputs=[ScriptInput(name="a", ref=ColumnRef(index=1))],
            )
        ),
    )


def test_inline_arity_mismatch_rejected_both_directions():
    with pytest.raises(ValidationError, match="takes 1 argument but column declares 1 input"):
        TableDefinition(
            row_source=ScopeRows(types=[]),
            columns=_cols(
                ScriptColumn(
                    snippet=_code(ONE_ARG),
                    inputs=[ScriptInput(name="a", ref=ColumnRef(index=0))],
                )
            ),
        )
    with pytest.raises(ValidationError, match="takes 2 arguments but column declares no inputs"):
        TableDefinition(row_source=ScopeRows(types=[]), columns=[ScriptColumn(snippet=_code(TWO_ARG))])
    # a ref snippet cannot be checked at save time: accepted here, error cell at runtime
    TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=_cols(
            ScriptColumn(
                snippet=SnippetSource(ref="s1"),
                inputs=[ScriptInput(name="a", ref=ColumnRef(index=0))],
            )
        ),
    )
    # no value() at all (e.g. still being written) is not an arity mismatch
    TableDefinition(
        row_source=ScopeRows(types=[]),
        columns=_cols(
            ScriptColumn(
                snippet=_code("x = 1"),
                inputs=[ScriptInput(name="a", ref=ColumnRef(index=0))],
            )
        ),
    )
```

Append to `tests/api/test_artifacts_routes.py`:

```python
def test_create_table_with_inline_arity_mismatch_422(client: TestClient) -> None:
    payload = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "property", "name": "name"},
            {
                "kind": "script",
                "snippet": {"definition": {"code": "def value(els): return 1"}},
                "inputs": [{"name": "nm", "ref": {"kind": "column", "index": 0}}],
            },
        ],
    }
    res = client.post(
        f"{API}/artifacts", json={"kind": "table", "name": "t", "payload": payload}
    )
    assert res.status_code == 422
    assert "takes 1 argument" in res.text
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_schema.py tests/api/test_artifacts_routes.py -v -k "script_input or arity"`
Expected: FAIL — `ImportError: cannot import name 'ScriptInput'`.

- [ ] **Step 3: Implement**

In `src/data_rover/core/table/schema.py`:

Add imports at the top: `import keyword` and `from pydantic import BaseModel, Field, TypeAdapter, field_validator, model_validator` and `from data_rover.core.script.lint import entry_arity`.

After `ColumnSource = Annotated[...]` add:

```python
class ScriptInput(BaseModel):
    """A named earlier column a script column reads for the same row.
    `ref` is backward-only like every ColumnRef; ANY column kind is legal."""

    name: str
    ref: ColumnRef

    @field_validator("name")
    @classmethod
    def _identifier(cls, v: str) -> str:
        if not v.isidentifier() or keyword.iskeyword(v):
            raise ValueError(f"input name {v!r} is not a valid identifier")
        return v
```

In `ScriptColumn`, after `snippet`:

```python
    #: Named earlier columns handed to `value(elements, inputs)` as
    #: `inputs[name]` (always a list). Empty → `value(elements)`, one arg.
    inputs: list[ScriptInput] = Field(default_factory=list)
```

In `_validate_sources`, inside the `for i, col in enumerate(self.columns):` loop, after the existing element-column checks and before `return self`, add:

```python
            if col.kind == "script":
                self._validate_script_inputs(i, col)
```

Add the method after `_validate_sources`:

```python
    def _validate_script_inputs(self, i: int, col: ScriptColumn) -> None:
        seen: set[str] = set()
        for inp in col.inputs:
            if inp.name in seen:
                raise ValueError(f"column {i}: duplicate input name {inp.name!r}")
            seen.add(inp.name)
            if inp.ref.index >= i:
                raise ValueError(
                    f"column {i}: input {inp.name!r} references column "
                    f"{inp.ref.index} (must be < {i})"
                )
            if (
                inp.ref.step_index is not None
                and self.columns[inp.ref.index].kind != "navigation"
            ):
                raise ValueError(
                    f"column {i}: input {inp.name!r} step_index requires the "
                    "referenced column to be a navigation column"
                )
        # Inline code is pinned here; a ref snippet is edited independently and
        # is checked at evaluation time instead (error cell).
        if col.snippet.definition is not None:
            arity = entry_arity(col.snippet.definition.code, "value")
            n = len(col.inputs)
            if arity == 1 and n:
                raise ValueError(
                    f"column {i}: value() takes 1 argument but column declares "
                    f"{n} input{'s' if n != 1 else ''}"
                )
            if arity == 2 and not n:
                raise ValueError(
                    f"column {i}: value() takes 2 arguments but column declares no inputs"
                )
```

Export `ScriptInput` wherever `ScriptColumn` is re-exported (check `src/data_rover/core/table/__init__.py`; add it if the module lists names).

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/table tests/api/test_artifacts_routes.py -q`
Expected: PASS (the whole `tests/table` package must stay green — the default `[]` keeps every existing definition valid).

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add src/data_rover/core/table/schema.py tests/table/test_schema.py tests/api/test_artifacts_routes.py
git commit -m "feat(table): ScriptColumn.inputs — named backward-only column refs, inline arity check"
```

---

### Task 3: Wire + guest — `inputs` on the session call

**Files:**
- Modify: `src/data_rover/core/script/runner.py:189-216` (protocol) and near `_WIRE_SCALARS` (types)
- Modify: `src/data_rover/core/script/facade_src.py:679-716`
- Modify: `src/data_rover/api/script_runner.py:422-434` (guest loop), `1223-1262` (host `call`)
- Modify: `tests/script/trusted_runner.py:233-258`
- Modify: `tests/api/_script_fakes.py` (every `def call(` — 5 sessions), `tests/script/test_embed_cache.py:23`
- Test: `tests/script/test_session.py`

**Interfaces:**
- Produces (in `runner.py`):
  ```python
  WireInput = dict[str, Any]   # {"kind": "elements", "ids": list[str]} | {"kind": "scalars", "values": list}
  WireInputs = dict[str, WireInput]
  def input_element_ids(inputs: WireInputs | None) -> list[str]  # deduped ids of every "elements" input, in order
  SnippetSession.call(self, entry, element_ids, *, doc=None, inputs: WireInputs | None = None) -> CallResult
  ```
- Guest: `_dr_call_entry(entry, element_ids, elements=None, doc=None, inputs=None)`; when `entry == "value"` and `inputs is not None` it calls `fn(els, {name: list})`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_session.py` (uses the file's `_open` helper and `small_model` fixture):

```python
def test_session_value_receives_named_inputs(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(
        small_model,
        "def value(els, inputs):\n"
        "    return [inputs['n'][0] + len(inputs['els']), inputs['els'][0].id]",
    )
    assert sess.boot_error is None
    r = sess.call(
        "value",
        [ids[0]],
        inputs={
            "n": {"kind": "scalars", "values": [10]},
            "els": {"kind": "elements", "ids": ids[:2]},
        },
    )
    assert r.error is None, r.error
    assert r.value == {"kind": "scalars", "values": [12, ids[0]]}
    sess.close()


def test_session_value_without_inputs_is_called_with_one_arg(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "def value(els): return len(els)")
    r = sess.call("value", [ids[0]])
    assert r.value == {"kind": "scalar", "value": 1}
    sess.close()


def test_session_empty_inputs_are_empty_lists(small_model) -> None:
    ids = sorted(small_model.elements)
    sess = _open(small_model, "def value(els, inputs): return len(inputs['x'])")
    r = sess.call("value", [ids[0]], inputs={"x": {"kind": "scalars", "values": []}})
    assert r.value == {"kind": "scalar", "value": 0}
    sess.close()


def test_input_element_ids_dedupes_in_order() -> None:
    from data_rover.core.script.runner import input_element_ids

    assert input_element_ids(None) == []
    assert input_element_ids(
        {
            "a": {"kind": "elements", "ids": ["e2", "e1"]},
            "b": {"kind": "scalars", "values": [1]},
            "c": {"kind": "elements", "ids": ["e1", "e3"]},
        }
    ) == ["e2", "e1", "e3"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_session.py -v -k "inputs or one_arg"`
Expected: FAIL — `TypeError: call() got an unexpected keyword argument 'inputs'`.

- [ ] **Step 3: Implement**

`src/data_rover/core/script/runner.py` — next to `ReadKey` add:

```python
#: One resolved script-column input as it crosses the bridge: the elements a
#: column holds for the row, or its scalar values. The tag set is closed.
WireInput = dict[str, Any]
WireInputs = dict[str, WireInput]


def input_element_ids(inputs: WireInputs | None) -> list[str]:
    """Deduped ids of every `elements` input, in input order — the extra
    roots the host projects so the guest's first touch costs no round trip."""
    if not inputs:
        return []
    out: dict[str, None] = {}
    for spec in inputs.values():
        if spec.get("kind") == "elements":
            for i in spec.get("ids", ()):
                out.setdefault(i, None)
    return list(out)
```

(`Any` must be imported from `typing`.) Extend the `SnippetSession.call` protocol signature with `inputs: WireInputs | None = None` after `doc`, and its docstring with: `inputs` is a `value` call's named column inputs; ignored for `step`/`transform`.

`src/data_rover/core/script/facade_src.py` — `_dr_call_entry` signature becomes `def _dr_call_entry(entry, element_ids, elements=None, doc=None, inputs=None):` and the call block becomes:

```python
        if entry == "transform":
            value = fn(doc)
        else:
            els = [_fetch_element(i) for i in element_ids]
            arg = els if entry == "value" else (els[0] if els else None)
            if entry == "value" and inputs is not None:
                # Column inputs: element inputs become handles through the
                # same memoized fetch as the roots, so their reads are
                # charged to this call's read-set like any other.
                bound = {}
                for name, spec in inputs.items():
                    if spec.get("kind") == "elements":
                        bound[name] = [_fetch_element(i) for i in spec["ids"]]
                    else:
                        bound[name] = list(spec["values"])
                value = fn(arg, bound)
            else:
                value = fn(arg)
```

`src/data_rover/api/script_runner.py` — guest loop (the `_run_embedded` source string): after `doc = call.get("doc")` add `inputs = call.get("inputs")` and pass it: `res = namespace["_dr_call_entry"](entry, element_ids, elements, doc, inputs)`. Host `_WasmSnippetSession.call`: add `inputs: WireInputs | None = None` after `doc`; project `element_ids + input_element_ids(inputs)` instead of `element_ids`:

```python
        project_ids = (
            [] if entry == "transform" else [*element_ids, *input_element_ids(inputs)]
        )
        elements = (
            project_roots(self._dispatcher.model, list(dict.fromkeys(project_ids)))
            if project_ids and self._limits.read_memo_max > 0
            else []
        )
```

and add `"inputs": inputs` to the `"call"` frame dict. Import `WireInputs, input_element_ids` from `data_rover.core.script.runner`.

`tests/script/trusted_runner.py` `_TrustedSession.call`: same signature change, same `project_ids` logic, and pass `inputs` as the fifth argument of `_dr_call_entry`.

`tests/api/_script_fakes.py`: add `inputs: object | None = None` (keyword-only, after `doc`) to every session `call` (`_CountingSession`, `_ScriptedSession`, `_BlockingSession`, `_BarrierSession`, and the unavailable one if it has a session). `tests/script/test_embed_cache.py` `_FakeSession.call`: signature `def call(self, entry, element_ids, *, doc=None, inputs=None)`.

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/script tests/api/test_script_sweep.py tests/api/test_snippets_routes.py -q`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint && pixi run backend-lint
git add src/data_rover/core/script/runner.py src/data_rover/core/script/facade_src.py src/data_rover/api/script_runner.py tests/script/trusted_runner.py tests/api/_script_fakes.py tests/script/test_embed_cache.py tests/script/test_session.py
git commit -m "feat(script): session call carries named column inputs to value(elements, inputs)"
```

---

### Task 4: Memo + cell-cache key — `inputs_digest`

**Files:**
- Modify: `src/data_rover/core/script/cell_cache.py:36-44`
- Modify: `src/data_rover/core/script/embed.py:104, 114-177, 196-213`
- Modify (hand-built keys): `tests/script/test_cell_cache.py:6`, `tests/api/test_tables_nav_script.py:164-167`, `tests/api/test_tables_script_status.py:327,645,909`, `tests/api/test_incremental_invalidation.py:494`
- Test: `tests/script/test_embed_cache.py`, `tests/script/test_cell_cache.py`

**Interfaces:**
- Consumes: `WireInputs` (Task 3).
- Produces: `CellKey = tuple[str, str, tuple[str, ...], str]` (sha, entry, ids, inputs digest); `inputs_digest(inputs: WireInputs | None) -> str` (`""` for `None`/`{}`); `ScriptEvalContext.call(code, entry, element_ids, *, inputs=None, cache_only=None)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/script/test_embed_cache.py`:

```python
from data_rover.core.script.cell_cache import inputs_digest


def _in(*values):
    return {"a": {"kind": "scalars", "values": list(values)}}


def test_inputs_participate_in_memo_and_cell_key():
    runner = _FakeRunner(OK)
    cache = ScriptCellCache()
    ctx = _ctx(runner, cache)
    ctx.call("c", "value", ["e1"], inputs=_in(1))
    ctx.call("c", "value", ["e1"], inputs=_in(1))  # memo hit
    assert runner.calls[0] == 1
    ctx.call("c", "value", ["e1"], inputs=_in("1"))  # different value → new key
    assert runner.calls[0] == 2
    ctx.call("c", "value", ["e1"])  # no inputs → a third key
    assert runner.calls[0] == 3
    assert cache.size() == 3
    # a fresh context reads all three back without a guest call
    ctx2 = _ctx(runner, cache)
    ctx2.call("c", "value", ["e1"], inputs=_in(1))
    ctx2.call("c", "value", ["e1"], inputs=_in("1"))
    ctx2.call("c", "value", ["e1"])
    assert runner.calls[0] == 3


def test_inputs_digest_empty_without_inputs_and_type_sensitive():
    assert inputs_digest(None) == ""
    assert inputs_digest({}) == ""
    digests = {inputs_digest(_in(v)) for v in (1, 1.0, "1", True)}
    assert len(digests) == 4
    assert inputs_digest(_in(1)) == inputs_digest(_in(1))  # deterministic
```

Append to `tests/script/test_cell_cache.py`:

```python
def test_cell_key_is_four_wide():
    assert len(KEY) == 4 and KEY[3] == ""
```

and change line 6 to `KEY = ("a" * 64, "value", ("e1",), "")`.

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/script/test_embed_cache.py tests/script/test_cell_cache.py -v`
Expected: FAIL — `ImportError: cannot import name 'inputs_digest'`.

- [ ] **Step 3: Implement**

`src/data_rover/core/script/cell_cache.py`:

```python
import hashlib
import json

from .runner import CallResult, ReadKey, WireInputs

#: (sha256(code).hexdigest(), entry, element_ids, inputs digest) — code is
#: hashed so keys stay small; the digest is "" for a call without column
#: inputs, so every pre-inputs key is unchanged.
CellKey = tuple[str, str, tuple[str, ...], str]


def inputs_digest(inputs: WireInputs | None) -> str:
    """Key component for a call's resolved column inputs: "" when there are
    none, else a sha256 prefix of the canonical JSON. JSON keeps 1, 1.0, "1"
    and true distinct, so no type tags are needed; hashing bounds the key
    size for long text inputs."""
    if not inputs:
        return ""
    canon = json.dumps(inputs, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()[:32]
```

`src/data_rover/core/script/embed.py`:
- `self._memo: dict[tuple[str, str, tuple[str, ...], str], CallResult] = {}`
- `_cell_key(self, code, entry, ids, digest) -> CellKey` returns `(sha, entry, ids, digest)`.
- `call(...)`: add `inputs: WireInputs | None = None` (keyword-only, before `cache_only`); `digest = inputs_digest(inputs)`; `key = (code, entry, tuple(element_ids), digest)`; `ckey = self._cell_key(code, entry, key[2], digest)`; `res = self._call_uncached(code, entry, element_ids, inputs)`.
- `_call_uncached(self, code, entry, element_ids, inputs)` ends with `return sess.call(entry, element_ids, inputs=inputs)`.
- Import `inputs_digest` from `.cell_cache` and `WireInputs` from `.runner`. Update the module docstring bullet "Calls are memoized by `(code, entry, element_ids)`" to "`(code, entry, element_ids, inputs digest)`".

Hand-built keys: `tests/api/test_tables_nav_script.py::_step_cell_key` returns `(sha, "step", (element_id,), "")` and its annotation becomes `tuple[str, str, tuple[str, ...], str]`; `tests/api/test_tables_script_status.py` lines 327/645/909 add a trailing `""`; `tests/api/test_incremental_invalidation.py:494` unpacks `(sha, entry, ids, _digest)`.

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/script tests/api/test_tables_nav_script.py tests/api/test_tables_script_status.py tests/api/test_incremental_invalidation.py tests/api/test_script_cell_cache_api.py -q`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint && pixi run backend-lint
git add src/data_rover/core/script/cell_cache.py src/data_rover/core/script/embed.py tests/script tests/api
git commit -m "feat(script): column inputs are a fourth cell-key component (empty digest without inputs)"
```

---

### Task 5: `core/table/script_inputs.py` — resolver and single call wrapper

**Files:**
- Create: `src/data_rover/core/table/script_inputs.py`
- Modify: `src/data_rover/core/table/cells.py:207-217` (`_property_cell` many-branch uses `property_input_values`)
- Test: `tests/table/test_script_inputs.py` (new)

**Interfaces:**
- Consumes: `ScriptInput`/`ScriptColumn.inputs` (Task 2), `ScriptEvalContext.call(..., inputs=)` (Task 4), `resolve_source_elements`, `_expand_slot_of`, `_navigation_reached`, `PropertyValue`, `display_name`.
- Produces:
  ```python
  @dataclass(frozen=True)
  class InputFailure: name: str; kind: Literal["pending", "error"]; message: str; traceback: str | None = None
  ResolvedInputs = dict[str, WireInput]
  def property_input_values(mm, model, col: PropertyColumn, els: list[str]) -> list[object]
  def resolve_script_inputs(mm, model, defn, key, col: ScriptColumn, base_slots, limits, script, memo=None) -> ResolvedInputs | InputFailure | None   # None ⇔ no inputs declared
  def failure_result(f: InputFailure) -> CallResult   # error kind "pending" or "runtime", message "input 'name': ..."
  def evaluate_script_column(mm, model, defn, key, col, roots, base_slots, limits, script, memo=None, *, cache_only=None) -> CallResult
  ```
  `evaluate_script_column` is THE call site: resolves inputs, returns `failure_result` on an `InputFailure` (never touching `script.call`), otherwise `script.call(col.snippet.definition.code, "value", roots, inputs=..., cache_only=cache_only)`. It also returns a runtime error result `value() takes 1 argument but column declares N inputs` (or the 2-vs-none mirror) when `entry_arity` of the resolved code disagrees with the column — this is the ref-snippet path the schema could not pin.

- [ ] **Step 1: Write the failing tests**

Create `tests/table/test_script_inputs.py`:

```python
"""resolve_script_inputs / evaluate_script_column against TrustedRunner:
one test per input column kind, plus failure propagation."""

from __future__ import annotations

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
from data_rover.core.table.evaluate import TableLimits, build_rows_ex
from data_rover.core.table.schema import (
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
        relationships=[
            RelationshipType(name="Uses", mappings=[{"source": "Block", "target": "Block"}])
        ],
    )


def _model() -> Model:
    model = Model(_mm())
    a = model.create_element("Block")
    model.set_property(a, "name", "A")
    model.set_property(a, "tags", ["x", "y"])
    b = model.create_element("Block")
    model.set_property(b, "name", "B")
    model.connect("Uses", a, b)
    return model


def _snip(code: str) -> SnippetSource:
    return SnippetSource(definition=SnippetDefinition(code=code))


def _ctx(model: Model, **kw) -> ScriptEvalContext:
    return ScriptEvalContext(TrustedRunner(), model, RunLimits(), ScriptBudget.start(30), **kw)


def _uses_nav() -> NavigationSource:
    return NavigationSource(
        definition=PathNavigation(
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
                model.metamodel, model, defn, key, defn.columns[col_index],
                build.base_slots, TableLimits(), ctx,
            )
        )
    return build, out


def _row_of(model, name):
    return next(i for i, e in model.elements.items() if e.properties.get("name") == name)


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
    assert by_row[_row_of(model, "A")] == {"t": {"kind": "scalars", "values": ["x", "y"]}}
    assert by_row[_row_of(model, "B")] == {"t": {"kind": "scalars", "values": []}}


def test_navigation_input_is_elements():
    model = _model()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            NavigationColumn(navigation=_uses_nav()),
            ScriptColumn(
                snippet=_snip("def value(els, inputs): return [e.name for e in inputs['u']]"),
                inputs=[ScriptInput(name="u", ref=ColumnRef(index=0))],
            ),
        ],
    )
    build, res = _resolve(model, defn, 1, _ctx(model))
    by_row = {key[0]: r for key, r in zip(build.keys, res)}
    assert by_row[_row_of(model, "A")] == {"u": {"kind": "elements", "ids": [_row_of(model, "B")]}}
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
    out = evaluate_script_column(
        model.metamodel, model, defn, key, defn.columns[1], [key[0]],
        build.base_slots, TableLimits(), ctx,
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
    out = evaluate_script_column(
        model.metamodel, model, defn, key, defn.columns[1], [key[0]],
        build.base_slots, TableLimits(), ctx,
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
    out = evaluate_script_column(
        model.metamodel, model, defn, key, defn.columns[1], [key[0]],
        build.base_slots, TableLimits(), ctx,
    )
    assert out.error is not None and out.error.kind == "pending"
    assert cache.size() == 0
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
    out = evaluate_script_column(
        model.metamodel, model, resolved, key, resolved.columns[1], [key[0]],
        build.base_slots, TableLimits(), ctx,
    )
    assert out.error is not None
    assert "takes 1 argument but column declares 1 input" in out.error.message
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_script_inputs.py -v`
Expected: FAIL — `ModuleNotFoundError: data_rover.core.table.script_inputs`.

- [ ] **Step 3: Implement**

Create `src/data_rover/core/table/script_inputs.py`:

```python
"""Resolve a script column's named inputs for one row, and the ONE wrapper
every `value()` call site goes through.

An input resolves to exactly what the referenced column's cell holds for the
row — elements for an element-producing column, scalars for a property or
scalar-script column, this row's single binding for an expand column — as
the tagged wire shape the guest turns into `inputs[name]` (always a list).

A pending or errored input never reaches the guest: `evaluate_script_column`
returns a synthetic result instead, which — because it never goes through
`ScriptEvalContext.call` — is neither memoized nor cell-cached, so the column
self-heals the moment the input computes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from data_rover.core.metamodel.schema import Metamodel
from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name
from data_rover.core.navigation.evaluate import PropertyValue
from data_rover.core.script.lint import entry_arity
from data_rover.core.script.runner import CallResult, ScriptError, WireInput

from .evaluate import (
    RowKey,
    TableLimits,
    _expand_slot_of,
    _navigation_reached,
    resolve_source_elements,
)
from .nav_memo import NavMemo
from .schema import PropertyColumn, ScriptColumn, ScriptInput, TableDefinition

if TYPE_CHECKING:
    from data_rover.core.script.embed import ScriptEvalContext


@dataclass(frozen=True)
class InputFailure:
    name: str
    kind: Literal["pending", "error"]
    message: str
    traceback: str | None = None


ResolvedInputs = dict[str, WireInput]


def _elements(ids: list[str]) -> WireInput:
    return {"kind": "elements", "ids": ids}


def _scalars(values: list[object]) -> WireInput:
    return {"kind": "scalars", "values": values}


def property_input_values(
    mm: Metamodel, model: Model, col: PropertyColumn, els: list[str]
) -> list[object]:
    """The values a COLLAPSE property column holds over `els`: list values
    flattened, None skipped, elements whose type lacks the property
    contributing nothing. Shared with `cells._property_cell` so an input and
    the rendered cell cannot drift."""
    vals: list[object] = []
    for eid in els:
        el = model.elements[eid]
        if not any(pd.name == col.name for pd in mm.effective_element_properties(el.type_name)):
            continue
        v = el.properties.get(col.name)
        if isinstance(v, (list, tuple)):
            vals.extend(v)
        elif v is not None:
            vals.append(v)
    return vals


def failure_result(f: InputFailure) -> CallResult:
    kind: Literal["pending", "runtime"] = "pending" if f.kind == "pending" else "runtime"
    return CallResult(
        value=None,
        error=ScriptError(
            kind=kind, message=f"input {f.name!r}: {f.message}", traceback=f.traceback
        ),
        duration_ms=0,
    )


def resolve_script_inputs(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None = None,
) -> ResolvedInputs | InputFailure | None:
    """`None` when the column declares no inputs (one-arg `value()`); the
    first failing input otherwise, in declaration order."""
    if not col.inputs:
        return None
    out: ResolvedInputs = {}
    for inp in col.inputs:
        r = _resolve_one(mm, model, defn, key, inp, base_slots, limits, script, memo)
        if isinstance(r, InputFailure):
            return r
        out[inp.name] = r
    return out


def _resolve_one(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    inp: ScriptInput,
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None,
) -> WireInput | InputFailure:
    ref_col = defn.columns[inp.ref.index]
    if inp.ref.step_index is not None:
        # navigation ref at a chain step: element-producing by contract
        return _elements(
            resolve_source_elements(
                mm, model, defn, key, inp.ref, base_slots, limits, script=script, memo=memo
            )
        )
    if getattr(ref_col, "mode", "collapse") == "expand":
        b = key[_expand_slot_of(defn, base_slots, inp.ref.index)]
        if isinstance(b, str):
            return _elements([b])
        if isinstance(b, PropertyValue):
            return _scalars([b.value])
        if isinstance(ref_col, ScriptColumn):
            # None slot: keep_empty row OR an errored/pending cell — the
            # cache-only re-derive tells them apart (mirrors cells._script_cell).
            roots = resolve_source_elements(
                mm, model, defn, key, ref_col.source, base_slots, limits, script=script, memo=memo
            )
            res = _script_result(
                mm, model, defn, key, ref_col, roots, base_slots, limits, script, memo,
                cache_only=True,
            )
            if res.error is not None:
                return _failure(inp.name, res)
        return _scalars([])
    if ref_col.kind == "element":
        return _elements(
            resolve_source_elements(
                mm, model, defn, key, ref_col.source, base_slots, limits, script=script, memo=memo
            )
        )
    roots = resolve_source_elements(
        mm, model, defn, key, ref_col.source, base_slots, limits, script=script, memo=memo
    )
    if isinstance(ref_col, PropertyColumn):
        return _scalars(property_input_values(mm, model, ref_col, roots))
    if ref_col.kind == "navigation":
        reached = _navigation_reached(mm, model, ref_col, roots, limits, script=script, memo=memo)
        if any(isinstance(n, PropertyValue) for n in reached):
            # value-projected navigation: the cell shows VALUES (mixed
            # frontiers degrade element nodes to display names, as the cell does)
            return _scalars(
                [
                    n.value if isinstance(n, PropertyValue) else display_name(model.elements[n])
                    for n in reached
                ]
            )
        return _elements([n for n in reached if isinstance(n, str)])
    assert isinstance(ref_col, ScriptColumn)
    if not roots:
        return _scalars([])
    res = _script_result(
        mm, model, defn, key, ref_col, roots, base_slots, limits, script, memo
    )
    if res.error is not None:
        return _failure(inp.name, res)
    p = res.value
    assert p is not None
    if p["kind"] == "scalar":
        return _scalars([] if p["value"] is None else [p["value"]])
    if p["kind"] == "scalars":
        return _scalars([v for v in p["values"] if v is not None])
    if p["kind"] == "element":
        return _elements([p["id"]] if p["id"] in model.elements else [])
    return _elements([i for i in dict.fromkeys(p["ids"]) if i in model.elements])


def _failure(name: str, res: CallResult) -> InputFailure:
    assert res.error is not None
    kind: Literal["pending", "error"] = "pending" if res.error.kind == "pending" else "error"
    return InputFailure(name, kind, res.error.message, res.error.traceback)


def _script_result(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    roots: list[str],
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext | None,
    memo: NavMemo | None,
    *,
    cache_only: bool | None = None,
) -> CallResult:
    """A script column's raw call result for one row, dangling-ref and
    unavailable-runner cases included, so an input's failure shape matches
    the cell's."""
    if col.snippet.ref is not None:
        return CallResult(
            value=None,
            error=ScriptError(kind="runtime", message=f"snippet artifact {col.snippet.ref!r} not found"),
            duration_ms=0,
        )
    if col.snippet.definition is None:
        return CallResult(value={"kind": "scalars", "values": []}, error=None, duration_ms=0)
    if script is None:
        return CallResult(
            value=None,
            error=ScriptError(kind="unavailable", message="script runner unavailable"),
            duration_ms=0,
        )
    return evaluate_script_column(
        mm, model, defn, key, col, roots, base_slots, limits, script, memo, cache_only=cache_only
    )


def evaluate_script_column(
    mm: Metamodel,
    model: Model,
    defn: TableDefinition,
    key: RowKey,
    col: ScriptColumn,
    roots: list[str],
    base_slots: int,
    limits: TableLimits,
    script: ScriptEvalContext,
    memo: NavMemo | None = None,
    *,
    cache_only: bool | None = None,
) -> CallResult:
    """THE `value()` call site for a script column: resolves the column's
    inputs, then calls through the context. Callers have already handled the
    dangling-ref / unconfigured / no-roots cases the way their cell renders."""
    assert col.snippet.definition is not None
    code = col.snippet.definition.code
    arity = entry_arity(code, "value")
    n = len(col.inputs)
    if arity == 1 and n:
        return _arity_error(f"value() takes 1 argument but column declares {n} input{'s' if n != 1 else ''}")
    if arity == 2 and not n:
        return _arity_error("value() takes 2 arguments but column declares no inputs")
    inputs = resolve_script_inputs(mm, model, defn, key, col, base_slots, limits, script, memo)
    if isinstance(inputs, InputFailure):
        return failure_result(inputs)
    return script.call(code, "value", roots, inputs=inputs, cache_only=cache_only)


def _arity_error(message: str) -> CallResult:
    return CallResult(
        value=None, error=ScriptError(kind="runtime", message=message), duration_ms=0
    )
```

In `src/data_rover/core/table/cells.py`, import `from .script_inputs import property_input_values` and replace the many-element collapse loop at the end of `_property_cell` (`vals: list[object] = [] ... return ValuesCell(...)`) with:

```python
    vals = property_input_values(mm, model, col, els)
    return ValuesCell(present=True, values=vals, total=len(vals), truncated=False)
```

Import-cycle note: `script_inputs.py` imports `evaluate.py` at module level and nothing from `cells.py`; `cells.py` imports `script_inputs.py`; `evaluate.py` will import `evaluate_script_column` FUNCTION-LOCALLY in Task 6 (the same pattern `_expand_values` uses for `expand_property_values`).

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/table -q`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add src/data_rover/core/table/script_inputs.py src/data_rover/core/table/cells.py tests/table/test_script_inputs.py
git commit -m "feat(table): resolve script column inputs per row; evaluate_script_column is the single value() call site"
```

---

### Task 6: Route every call site through `evaluate_script_column`

**Files:**
- Modify: `src/data_rover/core/table/cells.py:281-355` (`_script_cell`)
- Modify: `src/data_rover/core/table/evaluate.py:295-310` (script-as-source), `542-567` + `592-690` (`_collapse_has_value`, `_expand_values` — gain `defn`, `key`, `base_slots` params), `1008-1016` (`_sort_value`)
- Test: `tests/table/test_script_inputs.py`

**Interfaces:**
- Consumes: `evaluate_script_column` (Task 5).
- Changes: `_collapse_has_value(mm, model, defn, key, col, roots, base_slots, limits, script=None, memo=None)` and `_expand_values(...)` with the same three extra positional params (internal functions; only `build_rows_ex` calls them — grep to confirm no test imports them).

- [ ] **Step 1: Write the failing tests**

Append to `tests/table/test_script_inputs.py`:

```python
from data_rover.core.table.cells import ErrorCell, PendingCell, ValueCell, ValuesCell, evaluate_cells
from data_rover.core.table.evaluate import SortSpec, order_rows


def _table_with_inputs(mode="collapse", keep_empty=True):
    return TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
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
        ],
    )


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
        model.metamodel, model, defn, build.keys, SortSpec(column=2, direction="asc"), script=ctx
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
    assert isinstance(by_row[_row_of(model, "A")], ValueCell)
    assert by_row[_row_of(model, "A")].value == "B"


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
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_script_inputs.py -v -k "page_cell or expand_and or sort_by or as_a_source or render_as"`
Expected: FAIL — cells are `ErrorCell`s: the one-arg call raises `TypeError: value() missing 1 required positional argument: 'inputs'`.

- [ ] **Step 3: Implement**

`cells.py::_script_cell` — both `script.call(...)` calls become `evaluate_script_column(...)`:

```python
                res = evaluate_script_column(
                    mm, model, defn, key, col, roots, base_slots, limits, script, memo,
                    cache_only=True,
                )
```
and
```python
    res = evaluate_script_column(
        mm, model, defn, key, col, els, base_slots, limits, script, memo
    )
```
(add `evaluate_script_column` to the `from .script_inputs import ...` line).

`evaluate.py`:
- script-as-source branch in `resolve_source_elements`: replace `res = script.call(ref_col.snippet.definition.code, "value", roots)` with a function-local import and call:
  ```python
        from .script_inputs import evaluate_script_column  # cells/evaluate cycle guard

        res = evaluate_script_column(
            mm, model, defn, key, ref_col, roots, base_slots, limits, script, memo
        )
  ```
- `_collapse_has_value` and `_expand_values`: add `defn: TableDefinition, key: RowKey,` after `model` and `base_slots: int,` after `roots`; replace their `script.call(col.snippet.definition.code, "value", roots)` with the same function-local import + `evaluate_script_column(mm, model, defn, key, col, roots, base_slots, limits, script, memo)`. Update the two call sites in `build_rows_ex` (`_collapse_has_value(mm, model, defn, key, col, roots, base_slots, limits, script=script, memo=memo)` and likewise `_expand_values`).
- `_sort_value` script branch: replace `res = script.call(col.snippet.definition.code, "value", els)` with the function-local import + `evaluate_script_column(mm, model, defn, key, col, els, base_slots, limits, script, memo)`.

Grep to confirm no remaining direct calls: `grep -n 'script.call(' src/data_rover/core/table/` must return nothing.

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/table tests/api/test_tables_routes.py tests/api/test_tables_script_errors.py tests/api/test_tables_script_status.py tests/api/test_table_export.py -q`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run core-lint
git add src/data_rover/core/table/cells.py src/data_rover/core/table/evaluate.py tests/table/test_script_inputs.py
git commit -m "refactor(table): every value() call site goes through evaluate_script_column"
```

---

### Task 7: Sweep — items carry inputs

**Files:**
- Modify: `src/data_rover/api/script_sweep.py:275-278` (`_Item`), `326-341` (`_drain`), `440-472` (enumeration)
- Test: `tests/api/test_script_sweep.py`

**Interfaces:**
- Consumes: `resolve_script_inputs`, `InputFailure`, `ResolvedInputs` (Task 5).
- Changes: `_Item = tuple[str, tuple[str, ...], ResolvedInputs | None]`; `_drain` calls `wctx.call(code, "value", list(roots), inputs=inputs)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_script_sweep.py`:

```python
from data_rover.core.table.schema import ColumnRef, PropertyColumn, ScriptInput


def _defn_with_inputs() -> TableDefinition:
    """Property input → every row's inputs differ (name), so no dedupe."""
    return TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            PropertyColumn(name="name"),
            ScriptColumn(
                snippet=SnippetSource(
                    definition=SnippetDefinition(code="def value(els, inputs): return inputs['n']")
                ),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )


def test_sweep_items_are_keyed_by_inputs(settings_sync_sweep: Settings) -> None:
    model = _model(3)
    session = _session_with(model)
    runner = CountingRunner()
    job = kick_or_join_sweep(
        session, model.metamodel, model, _defn_with_inputs(), runner, settings_sync_sweep, 0
    )
    assert job.state == "done" and job.done == job.total == 3
    assert runner.calls == 3
    ctx = ScriptEvalContext(
        runner, model, RunLimits(), ScriptBudget.start(60),
        cell_cache=session.script_cell_cache, rev=0, cache_only=True,
    )
    built = build_rows_ex(model.metamodel, model, _defn_with_inputs(), script=ctx)
    from data_rover.core.table.cells import evaluate_cells

    evaluate_cells(model.metamodel, model, _defn_with_inputs(), built.keys, script=ctx)
    assert ctx.pending_misses == 0


def test_sweep_computes_a_script_input_at_enumeration(settings_sync_sweep: Settings) -> None:
    model = _model(2)
    session = _session_with(model)
    runner = CountingRunner()
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(snippet=SnippetSource(definition=SnippetDefinition(code=VALUE_CODE))),
            ScriptColumn(
                snippet=SnippetSource(
                    definition=SnippetDefinition(code="def value(els, inputs): return inputs['n']")
                ),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )
    job = kick_or_join_sweep(session, model.metamodel, model, defn, runner, settings_sync_sweep, 0)
    assert job.state == "done"
    # column 0: 2 cells (computed serially while resolving column 1's input);
    # column 1: 2 cells → 4 guest calls, and total counts every script cell
    assert runner.calls == 4
    assert job.total == 4 and job.done == 4


def test_sweep_counts_a_failed_input_as_done(settings_sync_sweep: Settings) -> None:
    model = _model(2)
    session = _session_with(model)
    runner = ScriptedRunner([ok(1), ok(1)])  # column 0's two calls succeed…
    defn = TableDefinition(
        row_source=ScopeRows(types=["Block"]),
        columns=[
            ScriptColumn(
                snippet=SnippetSource(definition=SnippetDefinition(code="def value(els): raise ValueError('x')"))
            ),
            ScriptColumn(
                snippet=SnippetSource(
                    definition=SnippetDefinition(code="def value(els, inputs): return 1")
                ),
                inputs=[ScriptInput(name="n", ref=ColumnRef(index=0))],
            ),
        ],
    )
    from tests.script.trusted_runner import TrustedRunner

    job = kick_or_join_sweep(session, model.metamodel, model, defn, TrustedRunner(), settings_sync_sweep, 0)
    assert job.state == "done"
    assert job.total == 4 and job.done == 4  # the 2 errored-input cells count as done
```

(Delete the unused `runner = ScriptedRunner(...)` line in the third test if the fake's constructor signature differs; the assertion is about `job.done`, driven by `TrustedRunner`.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_script_sweep.py -v -k "inputs or enumeration or failed_input"`
Expected: FAIL — pending misses > 0 / `runner.calls` mismatch (drain calls without inputs → different key).

- [ ] **Step 3: Implement**

`src/data_rover/api/script_sweep.py`:

```python
#: One unit of shardable sweep work: (snippet code, root element ids, resolved
#: column inputs or None). The entry point is always "value" — expand columns
#: were resolved by the serial row build, which happens before any fan-out.
_Item = tuple[str, tuple[str, ...], ResolvedInputs | None]
```

Import `from data_rover.core.table.script_inputs import InputFailure, ResolvedInputs, resolve_script_inputs`.

In `_drain`: `code, roots, inputs = q.get_nowait()` and `res = wctx.call(code, "value", list(roots), inputs=inputs)`.

In `_run_inner`'s enumeration loop, after computing `roots` and before building `item`:

```python
                if not roots:
                    dup_or_empty += 1
                    continue
                inputs = resolve_script_inputs(
                    metamodel, model, defn, key, col, base_slots, TableLimits(), ctx
                )
                if isinstance(inputs, InputFailure):
                    # Nothing to compute for this cell: its pending/error is
                    # derived from an input cell the sweep accounts for itself.
                    dup_or_empty += 1
                    continue
                item: _Item = (col.snippet.definition.code, tuple(roots), inputs)
                if item in seen:
                    dup_or_empty += 1
                    continue
```

`ResolvedInputs` is a dict — not hashable — so `seen` must key on a hashable form: `seen_key = (item[0], item[1], inputs_digest(item[2]))` with `inputs_digest` imported from `data_rover.core.script.cell_cache`; keep `seen: set[tuple[str, tuple[str, ...], str]]`.

- [ ] **Step 4: Run tests**

Run: `pixi run -e core-dev pytest tests/api/test_script_sweep.py tests/api/test_script_sweep_perf.py tests/api/test_tables_script_status.py -q`
Expected: PASS.

- [ ] **Step 5: Lint + commit**

```bash
pixi run backend-lint
git add src/data_rover/api/script_sweep.py tests/api/test_script_sweep.py
git commit -m "feat(sweep): script-column items carry their resolved inputs; failed inputs count as done"
```

---

### Task 8: Frontend types + `columns.ts` ref remapping

**Files:**
- Modify: `frontend/src/lib/api/types.ts:864-871, 928-939`
- Modify: `frontend/src/lib/table/columns.ts:69-71, 147-165, 185-206, 209-232`
- Test: `frontend/src/lib/table/__tests__/columns.test.ts`

**Interfaces:**
- Produces: `ScriptInputSchema = z.object({name: z.string(), ref: ColumnRefSchema})`, `ScriptColumnSchema.inputs: z.array(ScriptInputSchema).default([])`, exported `type ScriptInput`; `columns.ts` helpers remap `inputs[].ref.index` alongside `source`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/lib/table/__tests__/columns.test.ts`:

```ts
describe('script column inputs', () => {
	const withInputs: TableDefinition = {
		...base,
		columns: [
			{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null, hidden: false },
			{ kind: 'property', source: { kind: 'row', chain_index: 0 }, name: 'name', mode: 'collapse', keep_empty: true, header: '', width_px: null, hidden: false },
			{
				kind: 'script',
				source: { kind: 'row', chain_index: 0 },
				snippet: {},
				inputs: [
					{ name: 'el', ref: { kind: 'column', index: 0, step_index: null } },
					{ name: 'nm', ref: { kind: 'column', index: 1, step_index: null } }
				],
				mode: 'collapse',
				keep_empty: true,
				header: '',
				width_px: null,
				hidden: false
			}
		]
	};

	it('parses with a default empty inputs list', () => {
		const col = ColumnSchema.parse({ kind: 'script' });
		expect(col.kind === 'script' && col.inputs).toEqual([]);
	});

	it('removeColumn refuses a column an input reads, and shifts later refs', () => {
		expect(() => removeColumn(withInputs, 0)).toThrow(ColumnInUseError);
		const next = removeColumn(
			{ ...withInputs, columns: [withInputs.columns[0], withInputs.columns[0], ...withInputs.columns.slice(1)] },
			1
		);
		const script = next.columns[2];
		expect(script.kind === 'script' && script.inputs.map((i) => i.ref.index)).toEqual([0, 1]);
	});

	it('moveColumn remaps input refs and rejects a forward input', () => {
		const moved = moveColumn(withInputs, 0, 1); // element ↔ property
		const script = moved.columns[2];
		expect(script.kind === 'script' && script.inputs.map((i) => i.ref.index)).toEqual([1, 0]);
		expect(() => moveColumn(withInputs, 2, 0)).toThrow(/forward/);
	});

	it('cloneColumn shifts input refs past the insertion point', () => {
		const next = cloneColumn(withInputs, 0);
		const script = next.columns[3];
		expect(script.kind === 'script' && script.inputs.map((i) => i.ref.index)).toEqual([0, 2]);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- columns.test.ts`
Expected: FAIL — `inputs` undefined / `removeColumn` does not throw.

- [ ] **Step 3: Implement**

`types.ts` — after `ColumnRefSchema`:

```ts
/** Mirror of core/table/schema.py's ScriptInput: a named earlier column a
 *  script column reads for the same row (`value(elements, inputs)`). */
export const ScriptInputSchema = z.object({
	name: z.string(),
	ref: ColumnRefSchema
});
export type ScriptInput = z.infer<typeof ScriptInputSchema>;
```

and in `ScriptColumnSchema` after `snippet`: `inputs: z.array(ScriptInputSchema).default([]),`.

`columns.ts`:

```ts
/** Every ColumnRef a column carries: its source plus, for a script column,
 * each input's ref. The remappers below treat them uniformly. */
function columnRefIndices(c: Column): number[] {
	const out: number[] = [];
	if (c.source.kind === 'column') out.push(c.source.index);
	if (c.kind === 'script') for (const i of c.inputs) out.push(i.ref.index);
	return out;
}

/** Copy-on-write: returns `c` itself when no ref changes. `f` returns the
 * new index for an old one, or throws. */
function remapColumnRefs(c: Column, f: (i: number) => number): Column {
	let next: Column = c;
	if (c.source.kind === 'column') {
		const to = f(c.source.index);
		if (to !== c.source.index) next = { ...next, source: { ...c.source, index: to } };
	}
	if (c.kind === 'script' && c.inputs.some((i) => f(i.ref.index) !== i.ref.index)) {
		const inputs = c.inputs.map((i) =>
			f(i.ref.index) === i.ref.index ? i : { ...i, ref: { ...i.ref, index: f(i.ref.index) } }
		);
		next = { ...(next as Extract<Column, { kind: 'script' }>), inputs };
	}
	return next;
}
```

- `removeColumn`: the in-use check becomes `if (i !== index && columnRefIndices(defn.columns[i]).includes(index)) throw new ColumnInUseError(...)`; the shift-down map becomes `next.columns.map((c) => remapColumnRefs(c, (i) => (i > index ? i - 1 : i)))`.
- `cloneColumn`: the shift-up map becomes `next.columns.map((c) => remapColumnRefs(c, (i) => (i > index ? i + 1 : i)))`.
- `moveColumn`: the body of the `order.map` becomes:
  ```ts
	next.columns = order.map((oldIdx, newIdx) => {
		const c = defn.columns[oldIdx];
		return remapColumnRefs(c, (i) => {
			const remapped = oldToNew.get(i);
			if (remapped === undefined) throw new Error('dangling column source');
			if (remapped >= newIdx) {
				throw new Error(`move makes column ${newIdx} source column ${remapped} (forward)`);
			}
			return remapped;
		});
	});
  ```
- Keep `sourcesColumn` if anything else uses it; otherwise delete it.

- [ ] **Step 4: Run tests**

Run: `pixi run frontend-test -- columns.test.ts && pixi run frontend-check`
Expected: PASS (all of `columns.test.ts`, including the existing move/remove/clone cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/table/columns.ts frontend/src/lib/table/__tests__/columns.test.ts
git commit -m "feat(frontend): ScriptColumn.inputs mirror; column edits remap input refs like sources"
```

---

### Task 9: Frontend — Inputs editor block

**Files:**
- Modify: `frontend/src/lib/components/Table/ColumnSourceEditor.svelte` (`allowRow`, `label` props)
- Create: `frontend/src/lib/components/Table/ScriptInputsEditor.svelte`
- Modify: `frontend/src/lib/components/Table/ScriptColumnEditor.svelte`
- Modify: `frontend/src/lib/snippet/entry-stubs.ts`, `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte` (optional `withInputs` prop)
- Test: `frontend/src/lib/components/Table/__tests__/ScriptInputsEditor.test.ts` (new), `frontend/src/lib/snippet/__tests__/entry-stubs.test.ts` (extend if present, else create)

**Interfaces:**
- `ColumnSourceEditor` props gain `allowRow?: boolean` (default `true`; `false` hides the kind select and always emits a `column` ref) and `label?: string` (default `'source'`).
- `ScriptInputsEditor` props: `{ inputs: ScriptInput[]; columns: Column[]; columnIndex: number; rowSource: RowSource | null; onChange: (next: ScriptInput[]) => void }`. Renders one row per input: name text input (`aria-label="Input name"`), a `ColumnSourceEditor` with `allowRow={false}`, a remove button (`aria-label="Remove input"`); an "Add input" button (`aria-label="Add input"`) disabled when `columnIndex === 0`. Invalid names (`!/^[A-Za-z_][A-Za-z0-9_]*$/` or a Python keyword, or a duplicate) show `data-testid="input-name-error"`.
- `entry-stubs.ts`: `withStub(code, entry, opts?: { inputs?: boolean })` — for `value` with `inputs: true` the stub is `def value(elements, inputs):` with a comment line `# inputs[name] is a list: Elements or values of the named column`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Table/__tests__/ScriptInputsEditor.test.ts`:

```ts
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Column, ScriptInput } from '$lib/api/types';
import ScriptInputsEditor from '../ScriptInputsEditor.svelte';

const columns: Column[] = [
	{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: 'Self', width_px: null, hidden: false },
	{ kind: 'property', source: { kind: 'row', chain_index: 0 }, name: 'name', mode: 'collapse', keep_empty: true, header: '', width_px: null, hidden: false },
	{ kind: 'script', source: { kind: 'row', chain_index: 0 }, snippet: {}, inputs: [], mode: 'collapse', keep_empty: true, header: '', width_px: null, hidden: false }
];

function render(inputs: ScriptInput[], onChange: (next: ScriptInput[]) => void) {
	const c = mount(ScriptInputsEditor, {
		target: document.body,
		props: { inputs, columns, columnIndex: 2, rowSource: { kind: 'scope', types: [], criteria: [] }, onChange }
	});
	flushSync();
	return c;
}

let mounted: ReturnType<typeof render> | null = null;
afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
	document.body.innerHTML = '';
});

describe('ScriptInputsEditor', () => {
	it('adds an input pointing at the latest earlier column', () => {
		const onChange = vi.fn();
		mounted = render([], onChange);
		(document.querySelector('[aria-label="Add input"]') as HTMLButtonElement).click();
		flushSync();
		expect(onChange).toHaveBeenCalledWith([
			{ name: 'input1', ref: { kind: 'column', index: 1, step_index: null } }
		]);
	});

	it('renames, retargets and removes an input', () => {
		const onChange = vi.fn();
		mounted = render([{ name: 'a', ref: { kind: 'column', index: 1, step_index: null } }], onChange);
		const name = document.querySelector('[aria-label="Input name"]') as HTMLInputElement;
		name.value = 'nm';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(onChange).toHaveBeenLastCalledWith([{ name: 'nm', ref: { kind: 'column', index: 1, step_index: null } }]);
		const sel = document.querySelector('[aria-label="Source column"]') as HTMLSelectElement;
		sel.value = '0';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(onChange).toHaveBeenLastCalledWith([{ name: 'a', ref: { kind: 'column', index: 0, step_index: null } }]);
		(document.querySelector('[aria-label="Remove input"]') as HTMLButtonElement).click();
		flushSync();
		expect(onChange).toHaveBeenLastCalledWith([]);
	});

	it('flags invalid and duplicate names', () => {
		const onChange = vi.fn();
		mounted = render(
			[
				{ name: 'class', ref: { kind: 'column', index: 0, step_index: null } },
				{ name: 'x', ref: { kind: 'column', index: 0, step_index: null } },
				{ name: 'x', ref: { kind: 'column', index: 1, step_index: null } }
			],
			onChange
		);
		expect(document.querySelectorAll('[data-testid="input-name-error"]').length).toBe(3);
	});

	it('does not offer a Row source', () => {
		mounted = render([{ name: 'a', ref: { kind: 'column', index: 1, step_index: null } }], vi.fn());
		expect(document.querySelector('[aria-label="Column source kind"]')).toBeNull();
	});
});
```

Add to the entry-stubs test file (create `frontend/src/lib/snippet/__tests__/entry-stubs.test.ts` if absent):

```ts
import { describe, expect, it } from 'vitest';
import { withStub } from '$lib/snippet/entry-stubs';

describe('withStub inputs variant', () => {
	it('emits a two-arg value() when the column has inputs', () => {
		expect(withStub('', 'value', { inputs: true })).toMatch(/^def value\(elements, inputs\):/);
		expect(withStub('', 'value')).toMatch(/^def value\(elements\):/);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- ScriptInputsEditor entry-stubs`
Expected: FAIL — component module not found / `withStub` ignores the option.

- [ ] **Step 3: Implement**

`ColumnSourceEditor.svelte` — add props `allowRow = true` and `label = 'source'` to the destructured `$props()` (types `allowRow?: boolean; label?: string`). In the template replace `<span class="text-muted-foreground/70">source</span>` with `{label}` and wrap the kind `<select>` in `{#if allowRow} … {/if}`. Guard `source.kind === 'row'` rendering unchanged (a column-only caller never passes a row source).

`entry-stubs.ts`:

```ts
const VALUE_INPUTS_STUB =
	'def value(elements, inputs):\n' +
	'    # Read-only. inputs[name] is a list: the Elements or values the\n' +
	'    # named column holds for this row.\n' +
	'    return [el.name for el in elements]\n';

export function withStub(code: string, entry: BoundEntry, opts: { inputs?: boolean } = {}): string {
	const stub = entry === 'value' && opts.inputs ? VALUE_INPUTS_STUB : STUBS[entry];
	return code.trim() === '' ? stub : `${code.trimEnd()}\n\n\n${stub}`;
}
```

`SnippetSourceEditor.svelte` — add an optional prop `withInputs = false` (`withInputs?: boolean`) and pass it: `code: code ?? withStub('', entry, { inputs: withInputs })`.

Create `ScriptInputsEditor.svelte`:

```svelte
<script lang="ts">
	// The Inputs block of a script column: one row per named earlier column
	// the snippet reads as `inputs[name]`. Fully controlled — emits a whole
	// new list via `onChange`. Refs are backward-only, so the picker (a
	// column-only ColumnSourceEditor) lists only columns before this one.
	import type { Column, ColumnSource, RowSource, ScriptInput } from '$lib/api/types';
	import ColumnSourceEditor from './ColumnSourceEditor.svelte';

	let {
		inputs,
		columns,
		columnIndex,
		rowSource,
		onChange
	}: {
		inputs: ScriptInput[];
		columns: Column[];
		columnIndex: number;
		rowSource: RowSource | null;
		onChange: (next: ScriptInput[]) => void;
	} = $props();

	const PY_KEYWORDS = new Set([
		'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
		'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
		'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
		'try', 'while', 'with', 'yield'
	]);

	function nameError(name: string, i: number): string | null {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || PY_KEYWORDS.has(name)) return 'not a valid identifier';
		if (inputs.some((o, j) => j !== i && o.name === name)) return 'duplicate name';
		return null;
	}

	function add(): void {
		const taken = new Set(inputs.map((i) => i.name));
		let n = inputs.length + 1;
		while (taken.has(`input${n}`)) n++;
		onChange([...inputs, { name: `input${n}`, ref: { kind: 'column', index: columnIndex - 1, step_index: null } }]);
	}
	function rename(i: number, e: Event): void {
		const name = (e.currentTarget as HTMLInputElement).value;
		onChange(inputs.map((inp, j) => (j === i ? { ...inp, name } : inp)));
	}
	function retarget(i: number, source: ColumnSource): void {
		if (source.kind !== 'column') return;
		onChange(inputs.map((inp, j) => (j === i ? { ...inp, ref: source } : inp)));
	}
	function remove(i: number): void {
		onChange(inputs.filter((_, j) => j !== i));
	}
</script>

<div class="space-y-1" data-testid="script-inputs-editor">
	{#each inputs as inp, i (i)}
		<div class="flex flex-wrap items-center gap-2">
			<input
				aria-label="Input name"
				class="w-24 rounded border border-input bg-card px-1 py-0.5 font-mono"
				value={inp.name}
				oninput={(e) => rename(i, e)}
			/>
			<ColumnSourceEditor
				source={inp.ref}
				{columns}
				{columnIndex}
				{rowSource}
				allowRow={false}
				label="reads"
				onSourceChange={(s) => retarget(i, s)}
			/>
			<button type="button" aria-label="Remove input" class="text-muted-foreground" onclick={() => remove(i)}>×</button>
			{#if nameError(inp.name, i)}
				<span data-testid="input-name-error" class="text-destructive">{nameError(inp.name, i)}</span>
			{/if}
		</div>
	{/each}
	<button
		type="button"
		aria-label="Add input"
		class="rounded border border-border px-1.5 py-0.5"
		disabled={columnIndex === 0}
		onclick={add}
	>
		+ input
	</button>
</div>
```

`ScriptColumnEditor.svelte` — import `ScriptInputsEditor`; between the `ColumnSourceEditor` and `SnippetSourceEditor` add:

```svelte
	<div class="flex items-start gap-2">
		<span class="text-muted-foreground/70" title="Earlier columns the script receives as inputs[name]">inputs</span>
		<ScriptInputsEditor
			inputs={column.inputs}
			{columns}
			{columnIndex}
			{rowSource}
			onChange={(inputs) => onChange({ ...column, inputs })}
		/>
	</div>
```

and pass `withInputs={column.inputs.length > 0}` to `SnippetSourceEditor`.

Check `newScriptColumn()` in `columns.ts` includes `inputs: []` (add it if the default column literal lists fields explicitly) and update the `scriptColumn()` helper in `ScriptColumnEditor.test.ts` with `inputs: []`.

- [ ] **Step 4: Run tests**

Run: `pixi run frontend-test -- Table Snippet entry-stubs && pixi run frontend-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte frontend/src/lib/snippet frontend/src/lib/table/columns.ts
git commit -m "feat(frontend): Inputs block on the script column editor; two-arg value() stub"
```

---

### Task 10: WASM integration test + docs

**Files:**
- Modify: `tests/api/test_snippets_wasm.py`
- Modify: `src/data_rover/core/script/README.md:139-147, 315-330, 268-300 (memo bullet), 689-699`
- Modify: `CLAUDE.md` (embedded-evaluation bullet), `frontend/README.md:728-740`

- [ ] **Step 1: Add the integration test**

Append to `tests/api/test_snippets_wasm.py` (same `integration` mark and runner fixture the file already uses for its `open_session` tests — copy the fixture name from the nearest existing session test):

```python
@pytest.mark.integration
def test_wasm_session_value_receives_inputs(wasm_runner, small_model) -> None:
    ids = sorted(small_model.elements)
    sess = wasm_runner.open_session(
        small_model,
        "def value(els, inputs):\n    return [inputs['n'][0], inputs['e'][0].id]",
        RunLimits(),
        budget=ScriptBudget.start(30),
    )
    try:
        assert sess.boot_error is None, sess.boot_error
        r = sess.call(
            "value",
            [ids[0]],
            inputs={
                "n": {"kind": "scalars", "values": [7]},
                "e": {"kind": "elements", "ids": [ids[1]]},
            },
        )
        assert r.error is None, r.error
        assert r.value == {"kind": "scalars", "values": [7, ids[1]]}
    finally:
        sess.close()
```

Run: `pixi run -e core-dev pytest tests/api/test_snippets_wasm.py -m integration -v -k inputs` (needs the guest binary; `bash spikes/code_exec/fetch_python_wasi.sh` if absent). Expected: PASS.

- [ ] **Step 2: Docs — `core/script/README.md`**

- Line ~139 "Entry-point calling convention": after the sentence ending "for `value` that one argument is the list." add: "A table script column that declares `inputs` calls `value(elements, inputs)` instead — `inputs` is a `dict[str, list]`, one key per declared input, each value the `Element` handles or scalars the named column holds for the row (`[]` for an empty cell). Lint accepts a `value` of arity 1 or 2; `step`/`transform` stay one-arg."
- Wire contract bullet (~315): add `"inputs": {name: {"kind": "elements", "ids": [...]} | {"kind": "scalars", "values": [...]}} | null` to the frame shape, with: "`\"inputs\"` is null except on a `value` call from a script column with inputs; element inputs are projected into `\"elements\"` beside the roots (trip collapse), and the guest fetches them through the same memoized path, so their reads land in the call's read-set."
- Evaluation-sessions "Calls are memoized" bullet: key is `(code, entry, element_ids, inputs digest)`; the digest is `""` without inputs (existing keys unchanged) else a sha256 prefix of the canonical JSON of the resolved inputs — an input's VALUE is in the key, so a commit that changes what an input column holds simply misses. Add: "A pending or errored input never reaches the guest: `core/table/script_inputs.evaluate_script_column` returns a synthetic pending/error result that is neither memoized nor cached (`input 'name': …`)."
- "What counts as COVERED" bullet: add "Script-column INPUTS are resolved the same way — live, through the serial context during enumeration — so an input that is itself a script column is computed and cached before the dependent item is queued; a pending/errored input counts the dependent cell as done (its state derives from a cell the sweep accounts for separately)."

- [ ] **Step 3: Docs — `CLAUDE.md` and `frontend/README.md`**

`CLAUDE.md`, in the "Embedded evaluation (`ScriptColumn`/`ScriptStep`)" bullet, after "memoizes by `(code, entry, element_ids)`" change to "`(code, entry, element_ids, inputs digest)`" and append one sentence: "A `ScriptColumn` may declare `inputs` (named backward-only `ColumnRef`s, `core/table/schema.py::ScriptInput`) handed to `value(elements, inputs)` as `dict[str, list]`; `core/table/script_inputs.py` resolves them per row to what the referenced cell holds and is the ONE `value()` call site (`evaluate_script_column`) — the resolved values are in the cache key, so invalidation needs nothing new, and a pending/errored input yields an uncached pending/error cell rather than a call."

`frontend/README.md` "Script columns & steps" section: add a paragraph: "**Inputs** — `ScriptInputsEditor.svelte` (mounted by `ScriptColumnEditor`) edits `column.inputs`: a name plus a column-only `ColumnSourceEditor` (`allowRow={false}`) per input. Names are validated as Python identifiers and unique; the server re-validates. `columns.ts`'s move/remove/clone helpers remap `inputs[].ref.index` exactly like `source` (`remapColumnRefs`). When a column has inputs the snippet stub is the two-arg `value(elements, inputs)`."

- [ ] **Step 4: Full verification**

```bash
pixi run dr-tidy
pixi run dr-test
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tests/api/test_snippets_wasm.py src/data_rover/core/script/README.md CLAUDE.md frontend/README.md
git commit -m "docs: script column inputs — calling convention, wire frame, cache key, sweep rule; wasm integration test"
```

---

## Self-review

**Spec coverage:** §2.1 schema → Task 2; §2.2 calling convention + lint → Tasks 1, 3; §2.3 arity mismatch (inline 422 / ref error cell / mirror case) → Tasks 2, 5; §2.4 propagation → Tasks 5, 6; §3.1 one resolver/one call site → Tasks 5, 6; §3.2 cache key → Task 4; §3.3 invalidation (nothing new; element-input projections + read-set) → Task 3; §3.4 sweep → Task 7; §3.5 row-order cache untouched → no task (verified by Task 6's status tests); §4 wire/guest/trusted → Task 3; §5 frontend → Tasks 8, 9; §6 docs → Task 10; §7 tests → each task; WASM integration → Task 10.

**Type consistency:** `WireInput`/`WireInputs`/`input_element_ids` (Task 3) are what Tasks 4, 5, 7 import; `evaluate_script_column(mm, model, defn, key, col, roots, base_slots, limits, script, memo=None, *, cache_only=None)` is used identically in Tasks 5, 6; `resolve_script_inputs(..., script, memo=None)` returns `ResolvedInputs | InputFailure | None` in Tasks 5, 7; `inputs_digest` (Task 4) is reused by Task 7's `seen` key; `ScriptInput`/`inputs` field names match across schema, zod, and editors.
