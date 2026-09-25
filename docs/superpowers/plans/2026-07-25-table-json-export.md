# Table JSON Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a data-rover table as JSON — one row per object by default, with per-column key renaming, per-column element rendering, and the ability to group an `expand` column's rows back up into a nested array.

**Architecture:** A new pure core module `core/table/json_export.py` turns the evaluator's `RowKey` tuples plus the existing `Cell` dataclasses into a JSON document; grouping is slot arithmetic on the row keys, never value comparison. The existing `POST /tables/export` gains a `format: "xlsx" | "json"` field and branches only at its final render step, so the subtle 202/completeness-probe preamble stays in one place. A new read-only `POST /tables/json-preview` renders a bounded sample through the *same* core function so the Settings UI never reimplements grouping in TypeScript.

**Tech Stack:** Python 3.14, pydantic v2, FastAPI, pytest; SvelteKit 5 (runes), zod, vitest + happy-dom + MSW, TailwindCSS, bits-ui. Everything runs through **pixi** — there is no global `python` or `node`.

**Spec:** `docs/superpowers/specs/2026-07-25-table-json-export-design.md`

## Global Constraints

- Every command runs through pixi. Python: `pixi run -e core-dev pytest <args>`. Frontend: `pixi run -e frontend bash -c 'cd frontend && npm test'` — the `cd frontend` is REQUIRED (pixi runs from the repo root and a bare `npm test` fails with "Missing script").
- Lint/format/typecheck gate: `pixi run dr-tidy` must pass. It runs ruff, mypy AND pyright — all three.
- Target Python is **3.14**. Use PEP 604 unions (`X | Y`), `Literal`, `assert_never` etc. freely. `from __future__ import annotations` at the top of every new Python module (matches every existing module in this package).
- `core/` MUST NOT import from `api/`. The JSON renderer is core; the route wiring is api.
- `core/table/schema.py`'s `SCHEMA_VERSION` stays `1`. Every added field is optional, so old saved tables parse unchanged.
- The new pydantic field is named `json_export`, never `json` — pydantic v2 still carries a deprecated `.json()` method that a field of that name would collide with.
- Code in this repo carries dense docstrings explaining *why* an invariant exists. Match that density in the new modules; the grouping rules are load-bearing.
- Python tests live in `tests/<area>/` mirroring `src/data_rover/<area>`; `pythonpath=src` is set in `pytest.ini`, so import as `from data_rover.core...`.
- API tests use the `client` fixture pattern plus `AUTH_HEADERS`, `papi`, and `seed_default_project` from `tests/api/conftest.py`. Never add a database service — API tests run in-memory SQLite.
- Commit after every task. Do not push.

## File Structure

**Create:**
- `src/data_rover/core/table/json_export.py` — key resolution, group planning, cell→JSON rendering, document assembly. Pure; no API imports.
- `tests/table/test_json_export.py` — core unit tests (the bulk of the coverage).
- `tests/api/test_table_export_json.py` — route-level tests for `format: "json"` and `/tables/json-preview`.
- `frontend/src/lib/components/Table/JsonExportEditor.svelte` — the "JSON export" Settings tab.
- `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts` — its vitest suite.

**Modify:**
- `src/data_rover/core/table/schema.py` — add `JsonColumnOptions`; add `json_export` to the four column classes.
- `src/data_rover/core/table/cells.py` — host `NOT_COMPUTED_MESSAGE`.
- `src/data_rover/core/table/evaluate.py` — add the public `base_slot_count` helper.
- `src/data_rover/api/schemas.py` — add `ExportTableIn` and `JsonPreviewOut`.
- `src/data_rover/api/routes/tables.py` — `format` branch in `export_table`; new `json_preview` route; import `NOT_COMPUTED_MESSAGE` from core.
- `src/data_rover/api/authz.py` — allowlist `/tables/json-preview`.
- `frontend/src/lib/api/types.ts` — `JsonColumnOptionsSchema` on all four column schemas.
- `frontend/src/lib/api/tables.ts` — `format` on `exportTable`; new `previewTableJson`.
- `frontend/src/lib/table/columns.ts` — `setColumnJsonOptions`, `defaultJsonKeys`, `snakeCaseKey`.
- `frontend/src/lib/state/table-editor.svelte.ts` — `format` on `downloadTable`.
- `frontend/src/lib/components/Table/TableView.svelte` — Export dropdown; Settings tab strip.
- `CLAUDE.md`, `frontend/README.md` — document the feature.

---

### Task 1: Schema — `JsonColumnOptions` on every column

**Files:**
- Modify: `src/data_rover/core/table/schema.py`
- Test: `tests/table/test_json_export.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `JsonColumnOptions(key: str = "", value: Literal["name","id","object"] = "name", group: bool = False)`; field `json_export: JsonColumnOptions | None = None` on `ElementColumn`, `PropertyColumn`, `NavigationColumn`, `ScriptColumn`.

- [ ] **Step 1: Write the failing test**

Create `tests/table/test_json_export.py`:

```python
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
    assert [c.json_export.key for c in defn.columns] == ["a", "b", "c", "d"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: FAIL — pydantic ignores unknown keys by default, so `defn.columns[0].json_export` raises `AttributeError: 'ElementColumn' object has no attribute 'json_export'`.

- [ ] **Step 3: Write minimal implementation**

In `src/data_rover/core/table/schema.py`, add above the `# ---- columns ---` section:

```python
class JsonColumnOptions(BaseModel):
    """Per-column JSON-export settings (spec:
    docs/superpowers/specs/2026-07-25-table-json-export-design.md).

    Lives on the COLUMN rather than on `TableDefinition` as an index-keyed map
    deliberately: column indices move under reorder/insert/remove (the frontend
    already carries `remapTableSortForRemove/Move/Insert` to keep a single index
    valid across those edits), and settings attached to the column travel with
    it for free.

    The field is named `json_export` and not `json`: pydantic v2 still carries a
    deprecated `.json()` method that a field of that name would collide with.
    """

    #: "" means "derive from the header" — see `resolve_json_keys`.
    key: str = ""
    #: How an element reference renders. Ignored by columns that never produce
    #: elements (a property column), which is tolerated rather than rejected.
    value: Literal["name", "id", "object"] = "name"
    #: Roll this `expand` column's rows back up into one array. Honored only on
    #: a VISIBLE EXPAND column; ignored elsewhere (the column editor can flip
    #: expand->collapse at any time and a 422 would block the whole export).
    group: bool = False
```

Then add this line to `ElementColumn`, `PropertyColumn`, `NavigationColumn`, and `ScriptColumn` — put it directly after each class's `hidden` field:

```python
    #: JSON-export settings; `None` means "all defaults", which keeps saved
    #: payloads clean for the overwhelming majority of columns.
    json_export: JsonColumnOptions | None = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Verify no existing table test regressed**

Run: `pixi run -e core-dev pytest tests/table -q`
Expected: PASS — the field is optional and additive.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/table/schema.py tests/table/test_json_export.py
git commit -m "feat(table): add per-column JsonColumnOptions to the table schema"
```

---

### Task 2: Core — JSON key resolution

**Files:**
- Create: `src/data_rover/core/table/json_export.py`
- Test: `tests/table/test_json_export.py` (append)

**Interfaces:**
- Consumes: `JsonColumnOptions`, `TableDefinition` from Task 1.
- Produces: `resolve_json_keys(defn: TableDefinition) -> list[str | None]` — one entry per definition column, positionally aligned; `None` for a hidden column.

- [ ] **Step 1: Write the failing test**

Append to `tests/table/test_json_export.py`:

```python
from data_rover.core.table.json_export import resolve_json_keys


def _cols(*specs):
    """One `_defn` per test with N element columns described by dicts."""
    return _defn(columns=[{"kind": "element", "source": {"kind": "row"}, **s} for s in specs])


def test_keys_default_to_the_header():
    keys = resolve_json_keys(_cols({"header": "Name"}, {"header": "Component Mass"}))
    assert keys == ["Name", "Component Mass"]


def test_explicit_key_wins_over_the_header():
    keys = resolve_json_keys(_cols({"header": "Name", "json_export": {"key": "name"}}))
    assert keys == ["name"]


def test_blank_header_falls_back_to_kind_and_index():
    keys = resolve_json_keys(_cols({"header": "A"}, {"header": ""}))
    assert keys == ["A", "element_1"]


def test_duplicate_keys_are_suffixed_first_one_wins():
    keys = resolve_json_keys(_cols({"header": "Mass"}, {"header": "Mass"}, {"header": "Mass"}))
    assert keys == ["Mass", "Mass_2", "Mass_3"]


def test_a_suffix_that_would_itself_collide_keeps_counting():
    keys = resolve_json_keys(_cols({"header": "Mass"}, {"header": "Mass_2"}, {"header": "Mass"}))
    assert keys == ["Mass", "Mass_2", "Mass_3"]


def test_hidden_columns_get_no_key_and_do_not_consume_a_name():
    keys = resolve_json_keys(
        _cols({"header": "Mass", "hidden": True}, {"header": "Mass"})
    )
    assert keys == [None, "Mass"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v -k keys`
Expected: FAIL with `ModuleNotFoundError: No module named 'data_rover.core.table.json_export'`

- [ ] **Step 3: Write minimal implementation**

Create `src/data_rover/core/table/json_export.py`:

```python
"""JSON renderer for table export. Pure over (model, definition, row keys,
cells) — no API imports, unlike `api/table_export.py`, which lives in the API
layer only because core stays xlsx-free. JSON needs no dependency at all, so
the whole thing is unit-testable against a plain `Model`.

Spec: docs/superpowers/specs/2026-07-25-table-json-export-design.md
"""

from __future__ import annotations

from .schema import TableDefinition


def resolve_json_keys(defn: TableDefinition) -> list[str | None]:
    """One JSON key per definition column, positionally aligned; `None` for a
    hidden column (evaluated, because a visible column may reference it, but
    never emitted).

    Derivation, in order: an explicit `json_export.key`, else the column
    `header`, else `"<kind>_<index>"`. On a collision the FIRST occurrence keeps
    the name and later ones take `_2`, `_3`, ... The map is GLOBAL rather than
    per nesting level so a column carries the same key wherever it appears in
    the document — a reader can then rely on one key meaning one column.

    A hidden column consumes no name: its key is never emitted, so reserving one
    would push a visible column onto a `_2` suffix for no reason.
    """
    out: list[str | None] = []
    used: set[str] = set()
    for i, col in enumerate(defn.columns):
        if col.hidden:
            out.append(None)
            continue
        opts = col.json_export
        base = (opts.key if opts is not None else "") or col.header or f"{col.kind}_{i}"
        key = base
        n = 2
        # Loop rather than a single suffix: the `_2` a collision produces can
        # itself collide with a literal "Mass_2" header earlier in the table.
        while key in used:
            key = f"{base}_{n}"
            n += 1
        used.add(key)
        out.append(key)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/json_export.py tests/table/test_json_export.py
git commit -m "feat(table): resolve per-column JSON keys with dedupe and fallbacks"
```

---

### Task 3: Core — cell → JSON value rendering

**Files:**
- Modify: `src/data_rover/core/table/cells.py`, `src/data_rover/api/routes/tables.py`, `src/data_rover/core/table/json_export.py`
- Test: `tests/table/test_json_export.py` (append)

**Interfaces:**
- Consumes: `resolve_json_keys` from Task 2.
- Produces:
  - `NOT_COMPUTED_MESSAGE: str` moved to `data_rover.core.table.cells`.
  - `render_cell(model: Model, cell: Cell, mode: str) -> object` in `json_export.py`, where `mode` is one of `"name" | "id" | "object"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/table/test_json_export.py`:

```python
from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.table.cells import (
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)
from data_rover.core.model.model import Model
from data_rover.core.table.json_export import render_cell


def _one_element_model() -> tuple[Model, str]:
    mm = Metamodel(
        elements=[
            ElementType(name="Block", properties=[PropertyDef(name="name", datatype="string")])
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "Root")
    return model, el.id


def test_value_cell_absent_property_is_null():
    model, _ = _one_element_model()
    assert render_cell(model, ValueCell(present=False, value=None, element_id=None, editable=False), "name") is None


def test_value_cell_passes_native_types_through():
    model, _ = _one_element_model()
    cell = ValueCell(present=True, value=12, element_id=None, editable=False)
    assert render_cell(model, cell, "name") == 12


def test_value_cell_declared_but_unset_is_null():
    model, _ = _one_element_model()
    cell = ValueCell(present=True, value=None, element_id=None, editable=False)
    assert render_cell(model, cell, "name") is None


def test_values_cell_is_always_a_list_even_with_one_value():
    model, _ = _one_element_model()
    cell = ValuesCell(present=True, values=["a"], total=1, truncated=False)
    assert render_cell(model, cell, "name") == ["a"]


def test_element_cell_renders_by_mode():
    model, eid = _one_element_model()
    cell = ElementCell(element_id=eid)
    assert render_cell(model, cell, "name") == "Root"
    assert render_cell(model, cell, "id") == eid
    assert render_cell(model, cell, "object") == {
        "id": eid,
        "name": "Root",
        "type": "Block",
    }


def test_empty_element_cell_is_null():
    model, _ = _one_element_model()
    assert render_cell(model, ElementCell(element_id=None), "name") is None


def test_elements_cell_is_a_list_and_empty_is_a_list():
    model, eid = _one_element_model()
    assert render_cell(model, ElementsCell(element_ids=[eid], total=1, truncated=False), "name") == ["Root"]
    assert render_cell(model, ElementsCell(element_ids=[], total=0, truncated=False), "name") == []


def test_error_cell_becomes_an_error_marker():
    model, _ = _one_element_model()
    assert render_cell(model, ErrorCell(message="NameError: foo"), "name") == {
        "$error": "NameError: foo"
    }


def test_pending_cell_reuses_the_not_computed_wording():
    from data_rover.core.table.cells import NOT_COMPUTED_MESSAGE

    model, _ = _one_element_model()
    assert render_cell(model, PendingCell(), "name") == {"$error": NOT_COMPUTED_MESSAGE}


def test_dangling_element_id_becomes_an_error_marker_not_a_crash():
    model, _ = _one_element_model()
    assert render_cell(model, ElementCell(element_id="gone"), "name") == {
        "$error": "unknown element gone"
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v -k cell`
Expected: FAIL with `ImportError: cannot import name 'render_cell'`

- [ ] **Step 3: Move `NOT_COMPUTED_MESSAGE` into core**

In `src/data_rover/api/routes/tables.py`, DELETE these lines (currently around line 798-801):

```python
#: Wire message for a cell that is still `pending` after a TERMINAL sweep.
#: Deliberately the same wording `table_export.py` renders into a degraded
#: workbook cell (`#ERROR: not computed`), so the two surfaces agree.
NOT_COMPUTED_MESSAGE = "not computed"
```

Add it to `src/data_rover/core/table/cells.py`, directly below the `PendingCell` class:

```python
#: Wire message for a cell that is still `pending` after a TERMINAL sweep.
#: Deliberately the same wording `api/table_export.py` renders into a degraded
#: workbook cell (`#ERROR: not computed`) and `json_export.py` puts in a
#: `$error` marker, so every surface agrees. Lives HERE, beside `PendingCell`,
#: because core cannot import from the API layer where it used to sit.
NOT_COMPUTED_MESSAGE = "not computed"
```

Then in `src/data_rover/api/routes/tables.py`, add `NOT_COMPUTED_MESSAGE` to the existing import from `data_rover.core.table.cells`. If no such import exists, add:

```python
from data_rover.core.table.cells import NOT_COMPUTED_MESSAGE
```

Verify nothing else referenced it: `grep -rn "NOT_COMPUTED_MESSAGE" --include=*.py .` should show only the core definition, the route import, and the route's one use site.

- [ ] **Step 4: Write `render_cell`**

Append to `src/data_rover/core/table/json_export.py` (and extend the module's imports):

```python
from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import (
    NOT_COMPUTED_MESSAGE,
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)
from .schema import Column, TableDefinition


def _element_json(model: Model, eid: str, mode: str) -> object:
    """One element reference rendered per the column's `json_export.value`.

    A DANGLING id (the element was deleted between evaluation and render)
    yields an error marker rather than raising: the xlsx path tolerates the
    same case, and a whole export must not 500 over one stale reference.
    """
    el = model.elements.get(eid)
    if el is None:
        return {"$error": f"unknown element {eid}"}
    if mode == "id":
        return el.id
    if mode == "object":
        return {"id": el.id, "name": display_name(el), "type": el.type_name}
    return display_name(el)


def render_cell(model: Model, cell: Cell, mode: str) -> object:
    """One evaluated cell as a JSON-serializable value.

    Both "the type does not declare this property" and "declared but unset"
    render `null`: JSON has one absence, and the distinction the grid draws
    (greyed vs editable) is an editing affordance with no export meaning.

    A failed or uncomputed cell becomes `{"$error": ...}` rather than `null`.
    Nulling it would make a failure indistinguishable from an empty value for
    a programmatic consumer; the marker is the JSON analogue of the xlsx
    `#ERROR:` text, and it deliberately breaks type uniformity for that key.
    """
    if isinstance(cell, ValueCell):
        return None if not cell.present else cell.value
    if isinstance(cell, ValuesCell):
        # Always a list, length 1 included: a consumer must not have to
        # branch on arity to read a multi-source column.
        return list(cell.values)
    if isinstance(cell, ElementCell):
        return None if cell.element_id is None else _element_json(model, cell.element_id, mode)
    if isinstance(cell, ElementsCell):
        return [_element_json(model, e, mode) for e in cell.element_ids]
    if isinstance(cell, ErrorCell):
        return {"$error": cell.message}
    assert isinstance(cell, PendingCell)
    return {"$error": NOT_COMPUTED_MESSAGE}


def _mode_of(col: Column) -> str:
    return col.json_export.value if col.json_export is not None else "name"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS (20 tests)

- [ ] **Step 6: Verify the constant move broke nothing**

Run: `pixi run -e core-dev pytest tests/api/test_tables_script_errors.py tests/table -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/core/table/cells.py src/data_rover/core/table/json_export.py \
        src/data_rover/api/routes/tables.py tests/table/test_json_export.py
git commit -m "feat(table): render evaluated cells as JSON values"
```

---

### Task 4: Core — the group plan

**Files:**
- Modify: `src/data_rover/core/table/evaluate.py`, `src/data_rover/core/table/json_export.py`
- Test: `tests/table/test_json_export.py` (append)

**Interfaces:**
- Consumes: `_expand_slot_of` (already in `evaluate.py`).
- Produces:
  - `base_slot_count(defn: TableDefinition, row_keys: list[RowKey]) -> int` in `evaluate.py`.
  - `GroupPlan` dataclass and `build_group_plan(defn: TableDefinition, base_slots: int) -> GroupPlan` in `json_export.py`, with fields `grouped: tuple[int, ...]`, `slot_of: dict[int, int]`, `members: dict[int, tuple[int, ...]]`, `children: dict[int, tuple[int, ...]]`, `top_columns: tuple[int, ...]`, `top_groups: tuple[int, ...]`.

- [ ] **Step 1: Write the failing test**

Add `import copy` to the top of `tests/table/test_json_export.py`, then append:

```python
from data_rover.core.table.evaluate import base_slot_count
from data_rover.core.table.json_export import build_group_plan


def _nav_doc() -> dict:
    """Block rows; an expand navigation column; a property sourced from it.

    Returns a DOC, not a definition: every variant below tweaks the doc and
    re-validates through `TABLE_ADAPTER`. Do not reach for
    `model_copy(update=...)` — it skips validation, so `json_export` would stay
    a raw dict and `.group` would blow up with an AttributeError.
    """
    return {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "Component",
            },
            {
                "kind": "property",
                "source": {"kind": "column", "index": 1},
                "name": "mass",
                "header": "Component Mass",
            },
        ],
    }


def _validated(doc: dict, **column_patches: dict):
    """Validate `doc` after merging `{index: patch}` into its columns."""
    doc = copy.deepcopy(doc)
    for index, patch in column_patches.items():
        doc["columns"][int(index)].update(patch)
    return TABLE_ADAPTER.validate_python(doc)


def test_base_slot_count_is_one_for_a_scope_source():
    assert base_slot_count(_validated(_nav_doc()), [("a", "b")]) == 1


def test_no_grouping_means_every_column_is_top_level():
    plan = build_group_plan(_validated(_nav_doc()), base_slots=1)
    assert plan.grouped == ()
    assert plan.top_columns == (0, 1, 2)
    assert plan.top_groups == ()


def test_grouping_pulls_dependents_into_the_group():
    defn = _validated(_nav_doc(), **{"1": {"json_export": {"group": True}}})
    plan = build_group_plan(defn, base_slots=1)
    assert plan.grouped == (1,)
    assert plan.top_columns == (0,)
    assert plan.top_groups == (1,)
    assert plan.members[1] == (1, 2)   # the grouped column itself, then its dependent
    assert plan.children[1] == ()
    assert plan.slot_of[1] == 1        # base slot 0, then the first expand column


def test_group_flag_is_ignored_on_a_collapse_column():
    defn = _validated(
        _nav_doc(), **{"1": {"json_export": {"group": True}, "mode": "collapse"}}
    )
    assert build_group_plan(defn, base_slots=1).grouped == ()


def test_group_flag_is_ignored_on_a_hidden_column():
    defn = _validated(
        _nav_doc(), **{"1": {"json_export": {"group": True}, "hidden": True}}
    )
    assert build_group_plan(defn, base_slots=1).grouped == ()


def test_nested_groups_nest_by_dependency():
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "Part",
                "json_export": {"group": True},
            },
            {
                "kind": "navigation",
                "source": {"kind": "column", "index": 1},
                "navigation": {},
                "mode": "expand",
                "header": "Subpart",
                "json_export": {"group": True},
            },
        ],
    }
    plan = build_group_plan(TABLE_ADAPTER.validate_python(doc), base_slots=1)
    assert plan.grouped == (1, 2)
    assert plan.top_columns == (0,)
    assert plan.top_groups == (1,)
    assert plan.children[1] == (2,)
    assert plan.members[1] == (1,)
    assert plan.members[2] == (2,)
    assert plan.slot_of == {1: 1, 2: 2}


def test_two_independent_groups_are_both_top_level():
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "A",
                "json_export": {"group": True},
            },
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "B",
                "json_export": {"group": True},
            },
        ],
    }
    plan = build_group_plan(TABLE_ADAPTER.validate_python(doc), base_slots=1)
    assert plan.top_groups == (0, 1)
    assert plan.children == {0: (), 1: ()}
    assert plan.slot_of == {0: 1, 1: 2}


def test_innermost_grouped_ancestor_owns_a_dependent():
    """A column depending on BOTH grouped columns belongs to the inner one."""
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {
                "kind": "navigation",
                "source": {"kind": "row"},
                "navigation": {},
                "mode": "expand",
                "header": "Part",
                "json_export": {"group": True},
            },
            {
                "kind": "navigation",
                "source": {"kind": "column", "index": 0},
                "navigation": {},
                "mode": "expand",
                "header": "Subpart",
                "json_export": {"group": True},
            },
            {
                "kind": "property",
                "source": {"kind": "column", "index": 1},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }
    plan = build_group_plan(TABLE_ADAPTER.validate_python(doc), base_slots=1)
    assert plan.members[0] == (0,)
    assert plan.members[1] == (1, 2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v -k "plan or group or base_slot"`
Expected: FAIL with `ImportError: cannot import name 'base_slot_count'`

- [ ] **Step 3: Add `base_slot_count` to `evaluate.py`**

In `src/data_rover/core/table/evaluate.py`, directly below the existing `_row_source_base_slots`:

```python
def base_slot_count(defn: TableDefinition, row_keys: list[RowKey]) -> int:
    """Number of ROW-SOURCE slots at the head of a FULLY BUILT row key.

    `_row_source_base_slots` answers the same question from the PRE-expand
    base keys; callers downstream of `build_rows` (the exporters) only hold
    the post-expand keys, where the count is `len(key)` minus one slot per
    expand column. Both assume every chain of a chains row source has the
    same length, which is the assumption `_row_source_base_slots` already
    makes when it reads `len(base_keys[0])`.
    """
    if defn.row_source.kind != "chains":
        return 1
    if not row_keys:
        return 1
    expands = sum(
        1 for c in defn.columns if getattr(c, "mode", "collapse") == "expand"
    )
    return len(row_keys[0]) - expands
```

- [ ] **Step 4: Add the group plan to `json_export.py`**

Extend the imports and append:

```python
from dataclasses import dataclass

from .evaluate import _expand_slot_of
from .schema import ColumnRef


@dataclass(frozen=True)
class GroupPlan:
    """Static grouping layout, derived once per export and reused per row.

    `grouped` holds only the columns whose `group` flag is HONORED — a visible
    `expand` column. Everything else about the plan is derived from those.
    """

    #: honored grouped columns, ascending
    grouped: tuple[int, ...]
    #: grouped column -> its row-key slot
    slot_of: dict[int, int]
    #: grouped column -> the columns rendered inside its array entries,
    #: ascending and always starting with the grouped column itself
    members: dict[int, tuple[int, ...]]
    #: grouped column -> the grouped columns nested directly inside it
    children: dict[int, tuple[int, ...]]
    #: visible columns rendered on the top-level object
    top_columns: tuple[int, ...]
    #: grouped columns with no grouped ancestor
    top_groups: tuple[int, ...]


def _deps(defn: TableDefinition) -> list[set[int]]:
    """Per column, the TRANSITIVE set of columns its source chain reaches.

    Single forward pass: the schema guarantees a `ColumnRef` points strictly
    backward, so the referenced column's own set is always already computed.
    """
    out: list[set[int]] = []
    for col in defn.columns:
        src = col.source
        if isinstance(src, ColumnRef):
            out.append({src.index} | out[src.index])
        else:
            out.append(set())
    return out


def build_group_plan(defn: TableDefinition, base_slots: int) -> GroupPlan:
    """Work out what nests inside what, from the definition alone.

    A column `j` is OWNED BY grouped column `k` when `k` is in `deps(j)`; when
    several grouped columns qualify the INNERMOST (largest index) wins, which
    is what makes `{part: [{subpart: [{mass: ...}]}]}` come out right instead
    of hoisting `mass` up beside `subpart`.

    `group` is honored only on a VISIBLE EXPAND column. A stale flag on a
    collapse or hidden column is IGNORED rather than rejected: the column
    editor can flip expand->collapse at any moment, and 422-ing there would
    block exporting the whole table over a leftover checkbox.
    """
    deps = _deps(defn)
    grouped = tuple(
        i
        for i, c in enumerate(defn.columns)
        if c.json_export is not None
        and c.json_export.group
        and not c.hidden
        and getattr(c, "mode", "collapse") == "expand"
    )
    gset = set(grouped)

    def owner(i: int) -> int | None:
        candidates = [k for k in gset if k in deps[i]]
        return max(candidates) if candidates else None

    members: dict[int, list[int]] = {k: [] for k in grouped}
    children: dict[int, list[int]] = {k: [] for k in grouped}
    top_columns: list[int] = []
    top_groups: list[int] = []

    for i, col in enumerate(defn.columns):
        if col.hidden:
            continue  # evaluated, never emitted
        home = owner(i)
        if i in gset:
            # A grouped column renders its own value inside its own entries,
            # and nests under its grouped ANCESTOR (never under itself).
            members[i].append(i)
            (children[home] if home is not None else top_groups).append(i)
        elif home is None:
            top_columns.append(i)
        else:
            members[home].append(i)

    # Members come out ascending for free: ownership requires a backward
    # reference, so a grouped column always precedes everything it owns.
    return GroupPlan(
        grouped=grouped,
        slot_of={k: _expand_slot_of(defn, base_slots, k) for k in grouped},
        members={k: tuple(v) for k, v in members.items()},
        children={k: tuple(v) for k, v in children.items()},
        top_columns=tuple(top_columns),
        top_groups=tuple(top_groups),
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS (28 tests)

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/table/evaluate.py src/data_rover/core/table/json_export.py \
        tests/table/test_json_export.py
git commit -m "feat(table): derive the JSON export group plan from a definition"
```

---

### Task 5: Core — document assembly

**Files:**
- Modify: `src/data_rover/core/table/json_export.py`
- Test: `tests/table/test_json_export.py` (append)

**Interfaces:**
- Consumes: `resolve_json_keys`, `render_cell`, `_mode_of`, `GroupPlan`, `build_group_plan`, `base_slot_count`.
- Produces: `render_json(model: Model, defn: TableDefinition, row_keys: list[RowKey], row_iter: Iterable[list[Cell]], base_slots: int) -> list[dict[str, object]]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/table/test_json_export.py`:

```python
from data_rover.core.metamodel.schema import RelationshipType
from data_rover.core.table.cells import evaluate_cells
from data_rover.core.table.evaluate import build_rows, iter_export_rows
from data_rover.core.table.json_export import render_json


def _parts_mm() -> Metamodel:
    return Metamodel(
        elements=[
            ElementType(
                name="Block",
                properties=[
                    PropertyDef(name="name", datatype="string"),
                    PropertyDef(name="mass", datatype="integer", multiplicity="0..1"),
                ],
            )
        ],
        relationships=[RelationshipType(name="BlockHasPart", source="Block", target="Block")],
    )


def _parts_model(mm: Metamodel) -> Model:
    """Root -> (Part 1 mass 12, Part 2 mass 9); Lonely has no parts."""
    model = Model(mm)
    ids = {}
    for key, name, mass in [
        ("root", "Root", None),
        ("p1", "Part 1", 12),
        ("p2", "Part 2", 9),
        ("lonely", "Lonely", None),
    ]:
        el = model.create_element("Block")
        model.set_property(el, "name", name)
        if mass is not None:
            model.set_property(el, "mass", mass)
        ids[key] = el.id
    model.connect("BlockHasPart", ids["root"], ids["p1"])
    model.connect("BlockHasPart", ids["root"], ids["p2"])
    return model


def _hop_nav(mode: str, group: bool) -> dict:
    """An inline one-hop navigation column over BlockHasPart.

    The navigation-definition shape is copied verbatim from
    `tests/table/test_cells.py` — `kind: "path"`, a `start`, and
    `relationship_type`/`direction: "out"` steps. Do not invent field names
    here; a mismatch 422s at validation, not at evaluation.
    """
    col = {
        "kind": "navigation",
        "source": {"kind": "row"},
        "navigation": {
            "definition": {
                "kind": "path",
                "start": {"kind": "row"},
                "steps": [
                    {
                        "kind": "relationship",
                        "relationship_type": "BlockHasPart",
                        "direction": "out",
                    }
                ],
            }
        },
        "mode": mode,
        "header": "Component",
    }
    if group:
        col["json_export"] = {"group": True}
    return col


def _render(mm, model, doc):
    defn = TABLE_ADAPTER.validate_python(doc)
    keys, _ = build_rows(mm, model, defn)
    return render_json(model, defn, keys, iter_export_rows(mm, model, defn, keys), base_slot_count(defn, keys))


def test_ungrouped_is_one_object_per_row():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            _hop_nav("expand", group=False),
        ],
    })
    rows = [d for d in docs if d["Name"] == "Root"]
    assert rows == [
        {"Name": "Root", "Component": "Part 1"},
        {"Name": "Root", "Component": "Part 2"},
    ]


def test_grouping_with_no_dependent_unwraps_to_scalars():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            _hop_nav("expand", group=True),
        ],
    })
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {"Name": "Root", "Component": ["Part 1", "Part 2"]}


def test_grouping_nests_a_dependent_column():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            _hop_nav("expand", group=True),
            {
                "kind": "property",
                "source": {"kind": "column", "index": 1},
                "name": "mass",
                "header": "Component Mass",
            },
        ],
    })
    root = next(d for d in docs if d["Name"] == "Root")
    assert root == {
        "Name": "Root",
        "Component": [
            {"Component": "Part 1", "Component Mass": 12},
            {"Component": "Part 2", "Component Mass": 9},
        ],
    }


def test_keep_empty_group_is_an_empty_list_not_a_null_entry():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            _hop_nav("expand", group=True),
        ],
    })
    lonely = next(d for d in docs if d["Name"] == "Lonely")
    assert lonely == {"Name": "Lonely", "Component": []}


def test_hidden_columns_are_not_emitted():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "hidden": True,
            },
        ],
    })
    assert all(set(d) == {"Name"} for d in docs)


def test_key_order_follows_column_order_with_the_group_in_place():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs = _render(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            _hop_nav("expand", group=True),
            {"kind": "property", "source": {"kind": "row"}, "name": "mass", "header": "Own Mass"},
        ],
    })
    root = next(d for d in docs if d["Name"] == "Root")
    assert list(root) == ["Name", "Component", "Own Mass"]


def test_groups_merge_even_when_their_rows_are_not_contiguous():
    """Grouping merges by row key through a dict, so a sort that scatters a
    group's rows must not produce two objects for one group."""
    mm = _parts_mm()
    model = _parts_model(mm)
    defn = TABLE_ADAPTER.validate_python({
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"},
            _hop_nav("expand", group=True),
        ],
    })
    keys, _ = build_rows(mm, model, defn)
    scattered = list(reversed(keys))
    docs = render_json(
        model, defn, scattered,
        iter_export_rows(mm, model, defn, scattered),
        base_slot_count(defn, scattered),
    )
    assert len([d for d in docs if d["Name"] == "Root"]) == 1


def test_zero_rows_is_an_empty_document():
    mm = _parts_mm()
    model = Model(mm)
    docs = _render(mm, model, {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [{"kind": "property", "source": {"kind": "row"}, "name": "name", "header": "Name"}],
    })
    assert docs == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v -k "render_json or ungrouped or grouping or keep_empty or key_order or contiguous or zero_rows or hidden_columns"`
Expected: FAIL with `ImportError: cannot import name 'render_json'`

- [ ] **Step 3: Write the implementation**

Extend the imports of `src/data_rover/core/table/json_export.py` with `from collections.abc import Iterable` and `from .evaluate import RowKey, _expand_slot_of`, then append:

```python
#: One export row: its key (for grouping) paired with its evaluated cells.
_Pair = tuple[RowKey, list[Cell]]


def render_json(
    model: Model,
    defn: TableDefinition,
    row_keys: list[RowKey],
    row_iter: Iterable[list[Cell]],
    base_slots: int,
) -> list[dict[str, object]]:
    """The whole table as a list of JSON objects.

    `row_iter` yields cells in `row_keys` order (that is `iter_export_rows`'
    contract), so the two zip positionally.

    THIS CANNOT STREAM. Grouping merges rows through a dict, and a sort can
    scatter one group's rows across the whole result, so the document is held
    whole — the same trade `api/table_export.py` already makes when it gives up
    xlsxwriter's `constant_memory` for `autofit`, bounded by the same
    `TableLimits.max_rows`. Rows still ARRIVE chunk by chunk.
    """
    plan = build_group_plan(defn, base_slots)
    jkeys = resolve_json_keys(defn)
    pairs: list[_Pair] = list(zip(row_keys, row_iter, strict=True))

    if not plan.grouped:
        # Fast path, and not merely an optimization: bucketing would merge two
        # rows that happen to carry EQUAL keys into one object, silently
        # dropping a row the xlsx export renders twice.
        buckets: list[list[_Pair]] = [[p] for p in pairs]
    else:
        grouped_slots = {plan.slot_of[k] for k in plan.grouped}
        merged: dict[tuple[object, ...], list[_Pair]] = {}
        for rk, cells in pairs:
            gkey = tuple(v for i, v in enumerate(rk) if i not in grouped_slots)
            merged.setdefault(gkey, []).append((rk, cells))
        # dict preserves first-appearance order, which is what keeps the
        # document in the requested sort's order.
        buckets = list(merged.values())

    return [
        _render_level(model, defn, jkeys, plan, plan.top_columns, plan.top_groups, b)
        for b in buckets
    ]


def _render_level(
    model: Model,
    defn: TableDefinition,
    jkeys: list[str | None],
    plan: GroupPlan,
    columns: tuple[int, ...],
    groups: tuple[int, ...],
    rows: list[_Pair],
) -> dict[str, object]:
    """One JSON object: the plain `columns` plus one array per grouped column
    in `groups`, emitted in COLUMN ORDER so a grouped column's array sits at
    that column's own position rather than being pushed to the end.

    A plain column is read from `rows[0]` because its value is CONSTANT across
    the group by construction: it reads no grouped slot, so nothing that varies
    within the group can reach it.
    """
    group_set = set(groups)
    obj: dict[str, object] = {}
    for i in sorted([*columns, *groups]):
        key = jkeys[i]
        if key is None:  # hidden: evaluated, never emitted
            continue
        if i in group_set:
            obj[key] = _render_group(model, defn, jkeys, plan, i, rows)
        else:
            obj[key] = render_cell(model, rows[0][1][i], _mode_of(defn.columns[i]))
    return obj


def _render_group(
    model: Model,
    defn: TableDefinition,
    jkeys: list[str | None],
    plan: GroupPlan,
    g: int,
    rows: list[_Pair],
) -> list[object]:
    """The array for one grouped column: its rows re-partitioned by the value
    sitting in its own expand slot.

    A `None` slot is DROPPED rather than rendered: it is the `keep_empty` row
    an expand column emits when it reached nothing, and `[]` — not `[null]` —
    is the honest JSON for "no children".

    Unwrapping: when the group holds only the grouped column itself and nests
    nothing, the array carries that column's values directly. Wrapping them in
    single-key objects would be noise.
    """
    slot = plan.slot_of[g]
    parts: dict[object, list[_Pair]] = {}
    for rk, cells in rows:
        value = rk[slot]
        if value is None:
            continue
        parts.setdefault(value, []).append((rk, cells))

    members, children = plan.members[g], plan.children[g]
    if len(members) == 1 and not children:
        mode = _mode_of(defn.columns[g])
        return [render_cell(model, sub[0][1][g], mode) for sub in parts.values()]
    return [
        _render_level(model, defn, jkeys, plan, members, children, sub)
        for sub in parts.values()
    ]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS (36 tests)

- [ ] **Step 5: Lint and typecheck**

Run: `pixi run core-lint`
Expected: PASS (ruff, mypy, pyright)

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/core/table/json_export.py tests/table/test_json_export.py
git commit -m "feat(table): assemble the grouped JSON export document"
```

---

### Task 6: API — `format: "json"` on `POST /tables/export`

**Files:**
- Modify: `src/data_rover/api/schemas.py`, `src/data_rover/api/routes/tables.py`
- Test: `tests/api/test_table_export_json.py` (create)

**Interfaces:**
- Consumes: `render_json`, `base_slot_count`.
- Produces: `ExportTableIn(EvaluateTableIn)` with `format: Literal["xlsx", "json"] = "xlsx"`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_table_export_json.py`:

```python
"""POST /tables/export with format=json, and POST /tables/json-preview."""

import json

import pytest
from fastapi.testclient import TestClient

from data_rover.api.main import create_app

from .conftest import AUTH_HEADERS, papi, seed_default_project
from .test_artifacts_routes import _bootstrap_model


@pytest.fixture
def client() -> TestClient:
    seed_default_project()
    c = TestClient(create_app())
    c.headers.update(AUTH_HEADERS)
    return c


def _body(columns, **over):
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": columns,
        },
        "format": "json",
    }
    body.update(over)
    return body


def test_json_export_returns_an_array_of_objects(client):
    _bootstrap_model(client)
    body = _body(
        [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {"kind": "property", "source": {"kind": "row"}, "name": "mass", "header": "Mass"},
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert r.headers["content-disposition"].endswith('.json"')
    docs = json.loads(r.content)
    assert isinstance(docs, list)
    assert docs
    assert set(docs[0]) == {"Block", "Mass"}


def test_default_format_is_still_xlsx(client):
    _bootstrap_model(client)
    body = _body([{"kind": "element", "source": {"kind": "row"}}])
    del body["format"]
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


def test_json_export_honors_key_overrides(client):
    _bootstrap_model(client)
    body = _body(
        [
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "json_export": {"key": "block_name"},
            }
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    docs = json.loads(r.content)
    assert set(docs[0]) == {"block_name"}


def test_json_export_element_object_mode(client):
    _bootstrap_model(client)
    body = _body(
        [
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "json_export": {"value": "object"},
            }
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    docs = json.loads(r.content)
    assert set(docs[0]["Block"]) == {"id", "name", "type"}


def test_json_export_excludes_hidden_columns(client):
    _bootstrap_model(client)
    body = _body(
        [
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
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    docs = json.loads(r.content)
    assert set(docs[0]) == {"Block"}


def test_json_export_is_pretty_printed_utf8(client):
    _bootstrap_model(client)
    body = _body([{"kind": "element", "source": {"kind": "row"}, "header": "Block"}])
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert b"\n  " in r.content  # indent=2


def test_small_table_sets_no_truncation_header(client):
    """The truncation flag rides the SHARED preamble — this pins that the json
    branch does not drop the header, without needing a 50 000-row fixture."""
    _bootstrap_model(client)
    body = _body([{"kind": "element", "source": {"kind": "row"}, "header": "Block"}])
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert "X-Table-Truncated" not in r.headers


def test_uncomputed_script_cells_become_error_markers(client):
    """No script runner is configured in the test app, so every script cell
    comes back `pending` and must render `{"$error": ...}` — never null, and
    never a 500. Mirror the script-column definition used by
    `tests/api/test_tables_script_errors.py` if this shape drifts."""
    _bootstrap_model(client)
    body = _body(
        [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "script",
                "source": {"kind": "row"},
                "snippet": {"code": "def value(elements):\n    return 1\n"},
                "header": "Computed",
            },
        ]
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers.get("X-Table-Script-Errors") == "true"
    docs = json.loads(r.content)
    assert set(docs[0]["Computed"]) == {"$error"}


def test_export_stays_a_read_only_post():
    """Viewer access is decided by the allowlist, not by the format: authz
    classifies a POST as read-only purely by URL suffix. `format: "json"`
    must not have quietly turned the export into a write."""
    from data_rover.api.authz import _READ_ONLY_POST_SUFFIXES

    assert "/tables/export" in _READ_ONLY_POST_SUFFIXES
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_json.py -v`
Expected: FAIL — `format` is not a field on `EvaluateTableIn`, so the response is still xlsx and `content-type` assertion fails.

- [ ] **Step 3: Add `ExportTableIn` to `api/schemas.py`**

Directly below the existing `EvaluateTableIn` class:

```python
class ExportTableIn(EvaluateTableIn):
    """`/tables/export`'s payload: `EvaluateTableIn` plus the output format.

    A SUBCLASS rather than a new field on `EvaluateTableIn` so `/tables/evaluate`
    and `/tables/script-errors` — which have no notion of a format — keep their
    exact wire contract. `offset`/`limit` are inherited and ignored here: an
    export is always whole-table.
    """

    format: Literal["xlsx", "json"] = "xlsx"
```

- [ ] **Step 4: Branch the route**

In `src/data_rover/api/routes/tables.py`:

1. Add to the imports: `import json`, `from data_rover.core.table.evaluate import base_slot_count`, `from data_rover.core.table.json_export import render_json`, and `ExportTableIn` from `..schemas`.
2. Change `export_table`'s signature from `payload: EvaluateTableIn` to `payload: ExportTableIn`.
3. Replace the render-and-respond block at the end of the `try:` (the part starting `blob = build_workbook(` through the `return Response(...)`) with:

```python
        if payload.format == "json":
            # `render_json` indexes cells by DEFINITION column index, so it
            # gets the UNFILTERED rows — hidden columns are dropped inside it
            # by their `None` key, not by pre-slicing the row like the xlsx
            # path does.
            docs = render_json(
                model, defn, ordered, all_rows, base_slot_count(defn, ordered)
            )
            blob = json.dumps(docs, ensure_ascii=False, indent=2).encode("utf-8")
            media_type = "application/json"
            filename = f"{name}.json"
            # No JSON analogue of the xlsx trailing notice row: the `$error`
            # markers are in-band and the header below carries the summary.
        else:
            blob = build_workbook(
                model,
                headers,
                name,
                ([row[i] for i in visible] for row in all_rows),
                notice_provider=_notice,
                row_numbers=defn.show_row_numbers,
            )
            media_type = (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            )
            filename = f"{name}.xlsx"
        resp_headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        if truncated:
            resp_headers["X-Table-Truncated"] = "true"
        if _degraded():  # settled: every row has been consumed by now
            resp_headers["X-Table-Script-Errors"] = "true"
        return Response(content=blob, media_type=media_type, headers=resp_headers)
```

Note `_degraded()` still works for JSON: `render_json` consumes `all_rows` completely before it returns, so the flags it reads are settled by the time the headers are built — exactly as `build_workbook` guarantees for xlsx.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_json.py -v`
Expected: PASS (9 tests)

- [ ] **Step 6: Verify the xlsx path is unchanged**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py -q`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/tables.py \
        tests/api/test_table_export_json.py
git commit -m "feat(api): add format=json to POST /tables/export"
```

---

### Task 7: API — `POST /tables/json-preview`

**Files:**
- Modify: `src/data_rover/api/schemas.py`, `src/data_rover/api/routes/tables.py`, `src/data_rover/api/authz.py`
- Test: `tests/api/test_table_export_json.py` (append)

**Interfaces:**
- Consumes: `render_json`, `base_slot_count`, `EvaluateTableIn`.
- Produces: `JsonPreviewOut(sample: str, truncated: bool)`; route `POST /api/v1/projects/{project_id}/tables/json-preview`.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_table_export_json.py`:

```python
def test_preview_returns_rendered_sample(client):
    _bootstrap_model(client)
    body = {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [{"kind": "element", "source": {"kind": "row"}, "header": "Block"}],
        }
    }
    r = client.post(papi("/tables/json-preview"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    payload = r.json()
    assert payload["truncated"] is False
    docs = json.loads(payload["sample"])
    assert isinstance(docs, list)
    assert set(docs[0]) == {"Block"}


def _blocks_column_body():
    return {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": [{"kind": "element", "source": {"kind": "row"}, "header": "Block"}],
        }
    }


def _full_row_count(client) -> int:
    """How many objects the UNBOUNDED json export produces for this fixture —
    the preview assertions are stated relative to it, so they hold whatever
    `_bootstrap_model` happens to seed."""
    body = _blocks_column_body() | {"format": "json"}
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    return len(json.loads(r.content))


def test_preview_drops_the_last_possibly_partial_object(client, monkeypatch):
    """With the window smaller than the table, the final object may be cut
    mid-group, so it is dropped — every earlier one is complete."""
    from data_rover.api.routes import tables as tables_route

    _bootstrap_model(client)
    total = _full_row_count(client)
    assert total >= 3, "fixture too small: seed more Block elements first"
    monkeypatch.setattr(tables_route, "PREVIEW_MAX_ROWS", total - 1)
    r = client.post(papi("/tables/json-preview"), json=_blocks_column_body(), headers=AUTH_HEADERS)
    payload = r.json()
    assert payload["truncated"] is True
    # window = total - 1 objects (no grouping: one row per object), minus the
    # dropped last one.
    assert len(json.loads(payload["sample"])) == total - 2


def test_preview_keeps_a_lone_object_rather_than_showing_nothing(client, monkeypatch):
    """Dropping the only object would blank the pane, so it is kept and
    `truncated` carries the caveat instead."""
    from data_rover.api.routes import tables as tables_route

    _bootstrap_model(client)
    assert _full_row_count(client) >= 2, "fixture too small: seed more Block elements first"
    monkeypatch.setattr(tables_route, "PREVIEW_MAX_ROWS", 1)
    r = client.post(papi("/tables/json-preview"), json=_blocks_column_body(), headers=AUTH_HEADERS)
    payload = r.json()
    assert payload["truncated"] is True
    assert len(json.loads(payload["sample"])) == 1


def test_preview_is_read_only_and_reachable_by_a_viewer(client):
    """`/tables/json-preview` must be in authz._READ_ONLY_POST_SUFFIXES."""
    from data_rover.api.authz import _READ_ONLY_POST_SUFFIXES

    assert "/tables/json-preview" in _READ_ONLY_POST_SUFFIXES
```

If either `assert ... "fixture too small"` fires, create the extra `Block`
elements at the top of that test through `POST /model/ops` the way
`tests/api/test_tables_routes.py` seeds rows, then re-run.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_json.py -v -k preview`
Expected: FAIL with 404 (no such route) and an `ImportError`/assertion for the allowlist.

- [ ] **Step 3: Add `JsonPreviewOut` to `api/schemas.py`**

Below `ExportTableIn`:

```python
class JsonPreviewOut(BaseModel):
    """A bounded, already-rendered JSON sample for the export settings UI.

    `sample` is the rendered TEXT rather than parsed objects: the pane displays
    it verbatim, and re-serializing it client-side would let key order and
    formatting drift from what the real export produces.
    """

    sample: str
    truncated: bool
```

- [ ] **Step 4: Add the route**

In `src/data_rover/api/routes/tables.py`, after `export_table`:

```python
#: Rows the preview renders before it stops. Read as a module global at call
#: time (never captured in a default argument) so a test can lower it.
PREVIEW_MAX_ROWS = 200


@router.post("/tables/json-preview")
def json_preview(
    payload: EvaluateTableIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> JsonPreviewOut:
    """Read-only (viewer-callable; listed in authz._READ_ONLY_POST_SUFFIXES).

    Exists so the JSON-export settings UI can show a live sample WITHOUT
    reimplementing the grouping algorithm in TypeScript, where it would drift
    from `core/table/json_export.py`. Same renderer, bounded input.

    Bounded and CACHE-ONLY: it never kicks a script sweep and never answers
    202. A script cell that has not been computed simply renders its `$error`
    marker in the sample, which is the honest preview of what a user would get
    if they exported right now.

    The final top-level object is DROPPED when the window did not cover the
    whole table: grouping merges rows, so the last group is likely cut
    mid-way, while every earlier one is complete. Dropping it would leave the
    pane blank for a single group wider than the window, so in that one case
    the (approximate) object is kept and `truncated` says so.
    """
    metamodel, model = require_model(session)
    script_ctx = None
    acquired = False
    try:
        defn = _resolve_table(payload, project_id, db)
        sort = (
            SortSpec(column=payload.sort.column, direction=payload.sort.direction)
            if payload.sort is not None
            else None
        )
        if sort is not None and not (0 <= sort.column < len(defn.columns)):
            raise ValueError(
                f"sort column {sort.column} out of range "
                f"(table has {len(defn.columns)} columns)"
            )
        # Same uncapped cell limits as the export: a preview whose navigation
        # arrays were capped at 20 would not be a preview of the export.
        limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)
        script_ctx, acquired = open_script_context(
            runner,
            model,
            settings,
            needs_script=table_has_script(defn),
            cell_cache=session.script_cell_cache,
            rev=session.model_rev,
        )
        if script_ctx is not None:
            script_ctx.cache_only = True
        keys, _ = build_rows(metamodel, model, defn, limits, script=script_ctx)
        ordered = order_rows(
            metamodel, model, defn, keys, sort, limits, script=script_ctx
        )
        window = ordered[:PREVIEW_MAX_ROWS]
        truncated = len(ordered) > len(window)
        docs = render_json(
            model,
            defn,
            window,
            iter_export_rows(metamodel, model, defn, window, limits, script=script_ctx),
            base_slot_count(defn, window),
        )
        if truncated and len(docs) > 1:
            docs = docs[:-1]
        return JsonPreviewOut(
            sample=json.dumps(docs, ensure_ascii=False, indent=2),
            truncated=truncated,
        )
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    finally:
        close_script_context(script_ctx, acquired)
```

Add `JsonPreviewOut` to the `..schemas` import list at the top of the file.

- [ ] **Step 5: Allowlist the route**

In `src/data_rover/api/authz.py`, add `"/tables/json-preview",` to `_READ_ONLY_POST_SUFFIXES`, directly after `"/tables/export",`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_json.py -v`
Expected: PASS (13 tests)

- [ ] **Step 7: Full backend gate**

Run: `pixi run -e core-dev pytest -q` then `pixi run dr-tidy`
Expected: PASS both.

- [ ] **Step 8: Commit**

```bash
git add src/data_rover/api/schemas.py src/data_rover/api/routes/tables.py \
        src/data_rover/api/authz.py tests/api/test_table_export_json.py
git commit -m "feat(api): add POST /tables/json-preview for the export settings UI"
```

---

### Task 8: Frontend — types and column helpers

**Files:**
- Modify: `frontend/src/lib/api/types.ts`, `frontend/src/lib/table/columns.ts`
- Test: `frontend/src/lib/table/__tests__/columns.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: the backend schema from Task 1.
- Produces:
  - `JsonColumnOptionsSchema`, `type JsonColumnOptions` in `types.ts`; `json_export` on all four column schemas.
  - `setColumnJsonOptions(defn, index, patch: Partial<JsonColumnOptions>): TableDefinition`
  - `defaultJsonKeys(defn: TableDefinition): (string | null)[]`
  - `snakeCaseKey(s: string): string`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/table/__tests__/columns.test.ts` (create the file with the imports below if it does not exist):

```ts
import { describe, expect, it } from 'vitest';
import { defaultJsonKeys, setColumnJsonOptions, snakeCaseKey } from '../columns';
import type { TableDefinition } from '$lib/api/types';

function defn(...columns: unknown[]): TableDefinition {
	return {
		schema_version: 1,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns,
		default_cell_mode: 'collapse',
		show_row_numbers: false
	} as TableDefinition;
}

function el(over: Record<string, unknown> = {}) {
	return { kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', hidden: false, ...over };
}

describe('defaultJsonKeys', () => {
	it('mirrors the backend: header, then kind_index, deduped', () => {
		const d = defn(el({ header: 'Name' }), el({ header: '' }), el({ header: 'Name' }));
		expect(defaultJsonKeys(d)).toEqual(['Name', 'element_1', 'Name_2']);
	});

	it('prefers an explicit key', () => {
		const d = defn(el({ header: 'Name', json_export: { key: 'name', value: 'name', group: false } }));
		expect(defaultJsonKeys(d)).toEqual(['name']);
	});

	it('gives a hidden column no key and lets it consume no name', () => {
		const d = defn(el({ header: 'Mass', hidden: true }), el({ header: 'Mass' }));
		expect(defaultJsonKeys(d)).toEqual([null, 'Mass']);
	});
});

describe('snakeCaseKey', () => {
	it('lowercases and underscores', () => {
		expect(snakeCaseKey('Component Mass')).toBe('component_mass');
	});
	it('collapses punctuation and runs of separators', () => {
		expect(snakeCaseKey('  Mass (kg) ')).toBe('mass_kg');
	});
	it('splits camelCase', () => {
		expect(snakeCaseKey('grossMass')).toBe('gross_mass');
	});
	it('leaves an already-snake key alone', () => {
		expect(snakeCaseKey('mass_kg')).toBe('mass_kg');
	});
});

describe('setColumnJsonOptions', () => {
	it('creates the options object when absent and keeps other columns', () => {
		const d = defn(el({ header: 'A' }), el({ header: 'B' }));
		const next = setColumnJsonOptions(d, 1, { key: 'b' });
		expect(next.columns[1].json_export).toEqual({ key: 'b', value: 'name', group: false });
		expect(next.columns[0].json_export).toBeUndefined();
		expect(d.columns[1].json_export).toBeUndefined(); // input not mutated
	});

	it('merges into existing options', () => {
		const d = defn(el({ json_export: { key: 'a', value: 'id', group: false } }));
		const next = setColumnJsonOptions(d, 0, { group: true });
		expect(next.columns[0].json_export).toEqual({ key: 'a', value: 'id', group: true });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- columns'`
Expected: FAIL — `defaultJsonKeys`, `snakeCaseKey`, `setColumnJsonOptions` are not exported.

- [ ] **Step 3: Add the zod schema**

In `frontend/src/lib/api/types.ts`, above `ScriptColumnSchema`:

```ts
/** Per-column JSON-export settings. Mirrors core/table/schema.py's
 *  JsonColumnOptions. `group` is honored by the backend only on a VISIBLE
 *  EXPAND column; a stale flag elsewhere is ignored, not rejected. */
export const JsonColumnOptionsSchema = z.object({
	key: z.string().default(''),
	value: z.enum(['name', 'id', 'object']).default('name'),
	group: z.boolean().default(false)
});
export type JsonColumnOptions = z.infer<typeof JsonColumnOptionsSchema>;
```

Add this line to `ElementColumnSchema`, `PropertyColumnSchema`, `NavigationColumnSchema`, and `ScriptColumnSchema`, after each one's `hidden` field:

```ts
	json_export: JsonColumnOptionsSchema.nullish()
```

- [ ] **Step 4: Add the column helpers**

In `frontend/src/lib/table/columns.ts`, add the `JsonColumnOptions` type to the existing `$lib/api/types` import, then append:

```ts
const DEFAULT_JSON_OPTIONS: JsonColumnOptions = { key: '', value: 'name', group: false };

/**
 * The JSON key each column gets, mirroring `resolve_json_keys` in
 * `core/table/json_export.py`: explicit key, else header, else `kind_index`,
 * with later duplicates suffixed `_2`, `_3`. Hidden columns get `null` and
 * consume no name.
 *
 * DISPLAY ONLY — this is what the settings pane shows as a placeholder. The
 * authoritative keys are the backend's, and the preview pane renders through
 * the backend for exactly that reason.
 */
export function defaultJsonKeys(defn: TableDefinition): (string | null)[] {
	const used = new Set<string>();
	return defn.columns.map((col, i) => {
		if (col.hidden) return null;
		const base = col.json_export?.key || col.header || `${col.kind}_${i}`;
		let key = base;
		let n = 2;
		while (used.has(key)) key = `${base}_${n++}`;
		used.add(key);
		return key;
	});
}

/** "Component Mass" -> "component_mass". Used only by the settings pane's
 *  "snake_case all" button, which writes the result into each column's
 *  `json_export.key` — the backend has no notion of slugification. */
export function snakeCaseKey(s: string): string {
	return s
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[^a-zA-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase();
}

/** Merge a patch into one column's JSON-export options, materializing the
 *  options object if the column had none. Pure — returns a new definition. */
export function setColumnJsonOptions(
	defn: TableDefinition,
	index: number,
	patch: Partial<JsonColumnOptions>
): TableDefinition {
	const next = clone(defn);
	const current = defn.columns[index].json_export ?? DEFAULT_JSON_OPTIONS;
	next.columns[index] = {
		...defn.columns[index],
		json_export: { ...current, ...patch }
	};
	return next;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- columns'`
Expected: PASS (9 tests)

- [ ] **Step 6: Typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/table/columns.ts \
        frontend/src/lib/table/__tests__/columns.test.ts
git commit -m "feat(frontend): add JSON export column options and key helpers"
```

---

### Task 9: Frontend — API client and download plumbing

**Files:**
- Modify: `frontend/src/lib/api/tables.ts`, `frontend/src/lib/state/table-editor.svelte.ts`
- Test: `frontend/src/lib/api/__tests__/tables.test.ts` (append)

**Interfaces:**
- Consumes: Task 6 and Task 7 routes.
- Produces:
  - `exportTable(args: { definition?, artifactId?, sort?, format?: 'xlsx' | 'json' }, cfg?)`
  - `previewTableJson(args: { definition?, artifactId?, sort? }, cfg?): Promise<{ sample: string; truncated: boolean }>`
  - `downloadTable(tabId, opts?: { format?: 'xlsx' | 'json'; onProgress?; signal? })`

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/api/__tests__/tables.test.ts`, inside its existing
`describe` block so the file's MSW `server` and `BASE` are in scope. Add
`previewTableJson` to the file's existing import from `../tables`, and define
this definition constant next to the other module-level constants:

```ts
const DEFN = {
	schema_version: 1,
	row_source: { kind: 'scope', types: ['Block'], criteria: [] },
	columns: [{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: 'Block', hidden: false }],
	default_cell_mode: 'collapse',
	show_row_numbers: false
} as unknown as TableDefinition;
```

Then the tests:

```ts
	it('sends the requested format and returns the json filename', async () => {
		let seen: unknown = null;
		server.use(
			http.post(`${BASE}/tables/export`, async ({ request }) => {
				seen = await request.json();
				return new HttpResponse('[]', {
					headers: {
						'content-type': 'application/json',
						'content-disposition': 'attachment; filename="table.json"'
					}
				});
			})
		);
		const res = await exportTable({ definition: DEFN, format: 'json' });
		expect((seen as { format: string }).format).toBe('json');
		expect(res).toMatchObject({ kind: 'ready', filename: 'table.json' });
	});

	it('defaults the format to xlsx', async () => {
		let seen: unknown = null;
		server.use(
			http.post(`${BASE}/tables/export`, async ({ request }) => {
				seen = await request.json();
				return new HttpResponse('x', {
					headers: { 'content-disposition': 'attachment; filename="t.xlsx"' }
				});
			})
		);
		await exportTable({ definition: DEFN });
		expect((seen as { format: string }).format).toBe('xlsx');
	});

	it('fetches a json preview', async () => {
		server.use(
			http.post(`${BASE}/tables/json-preview`, () =>
				HttpResponse.json({ sample: '[]', truncated: true })
			)
		);
		await expect(previewTableJson({ definition: DEFN })).resolves.toEqual({
			sample: '[]',
			truncated: true
		});
	});
```

If that file already defines an equivalent definition constant, use it instead
of adding a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- api/__tests__/tables'`
Expected: FAIL — `previewTableJson` is not exported, and `format` is never sent.

- [ ] **Step 3: Update `api/tables.ts`**

Change `exportTable`:

```ts
/** Export the current definition (or saved artifact) as `.xlsx` or `.json`.
 * Resolves to `{ kind: 'ready' }` with the Blob once the backend has it, or
 * `{ kind: 'preparing' }` while the script-cache sweep is still filling in
 * cells for this table (backend 202 + Retry-After). The 202 protocol is
 * format-agnostic — the backend runs the identical preamble for both. */
export async function exportTable(
	args: {
		definition?: TableDefinition;
		artifactId?: string;
		sort?: TableSort;
		format?: 'xlsx' | 'json';
	},
	cfg?: ClientConfig
): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/tables/export',
		{
			method: 'POST',
			body: {
				definition: args.definition,
				artifact_id: args.artifactId,
				sort: args.sort,
				format: args.format ?? 'xlsx'
			}
		},
		cfg
	);
	if (res.status === 202) {
		const body = (await res.json()) as { done?: number; total?: number | null };
		return { kind: 'preparing', done: body.done ?? 0, total: body.total ?? null };
	}
	const disp = res.headers.get('content-disposition') ?? '';
	const m = /filename="([^"]+)"/.exec(disp);
	return { kind: 'ready', blob: await res.blob(), filename: m?.[1] ?? 'table.xlsx' };
}

/**
 * A bounded, already-rendered JSON sample for the export settings pane
 * (`POST /tables/json-preview`).
 *
 * The sample is rendered SERVER-SIDE through the very function the export
 * uses, so the pane can never disagree with the file the user downloads.
 * `truncated` means the sample covers only the head of the table.
 */
export async function previewTableJson(
	args: { definition?: TableDefinition; artifactId?: string; sort?: TableSort },
	cfg?: ClientConfig
): Promise<{ sample: string; truncated: boolean }> {
	return apiFetch(
		'/tables/json-preview',
		{
			method: 'POST',
			body: { definition: args.definition, artifact_id: args.artifactId, sort: args.sort }
		},
		cfg
	);
}
```

- [ ] **Step 4: Thread `format` through `downloadTable`**

In `frontend/src/lib/state/table-editor.svelte.ts`, change the signature and the two `exportTable` calls:

```ts
export async function downloadTable(
	tabId: string,
	opts?: {
		format?: 'xlsx' | 'json';
		onProgress?: (p: ExportProgress) => void;
		signal?: AbortSignal;
	}
): Promise<void> {
	const draft = _drafts.get(tabId);
	if (!draft) return;
	const sort = _sortFor(tabId, draft);
	const args = { ..._evaluateSource(draft), sort, format: opts?.format ?? 'xlsx' };
	let result = await exportTable(args);
	for (let attempt = 1; result.kind === 'preparing'; attempt++) {
		if (opts?.signal?.aborted) return;
		if (attempt > EXPORT_MAX_ATTEMPTS) {
			throw new Error('Export is still being prepared — try again shortly.');
		}
		opts?.onProgress?.({ done: result.done, total: result.total, attempt });
		await new Promise((r) => setTimeout(r, EXPORT_RETRY_MS));
		if (opts?.signal?.aborted) return;
		result = await exportTable(args);
	}
	const url = URL.createObjectURL(result.blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = result.filename;
	a.click();
	URL.revokeObjectURL(url);
}
```

Also update the docstring's first line to "Export the current definition (or saved artifact) as an `.xlsx` or `.json`".

- [ ] **Step 5: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- api/__tests__/tables'`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/tables.ts frontend/src/lib/state/table-editor.svelte.ts \
        frontend/src/lib/api/__tests__/tables.test.ts
git commit -m "feat(frontend): thread export format and add the json preview client"
```

---

### Task 10: Frontend — the Export format dropdown

**Files:**
- Modify: `frontend/src/lib/components/Table/TableView.svelte`
- Test: `frontend/src/lib/components/Table/__tests__/TableView.test.ts` (append)

**Interfaces:**
- Consumes: `downloadTable` from Task 9.
- Produces: `data-testid="table-export-button"` (now a dropdown trigger), `data-testid="table-export-xlsx"`, `data-testid="table-export-json"`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/components/Table/__tests__/TableView.test.ts`,
inside its existing `describe` block. Add these two imports at the top of the
file if they are not already there:

```ts
import * as tableState from '$lib/state/table-editor.svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
```

`TAB_ID` is that file's existing tab-id constant — reuse it rather than
introducing a new one, so the mocked draft/page stores the file already sets up
stay in play.

```ts
	it('offers both export formats and passes the chosen one through', async () => {
		const spy = vi.spyOn(tableState, 'downloadTable').mockResolvedValue(undefined);
		render(TableView, { props: { tabId: TAB_ID } });
		await fireEvent.click(await screen.findByTestId('table-export-button'));
		await fireEvent.click(await screen.findByTestId('table-export-json'));
		expect(spy).toHaveBeenCalledWith(TAB_ID, expect.objectContaining({ format: 'json' }));
	});

	it('exports xlsx when that item is chosen', async () => {
		const spy = vi.spyOn(tableState, 'downloadTable').mockResolvedValue(undefined);
		render(TableView, { props: { tabId: TAB_ID } });
		await fireEvent.click(await screen.findByTestId('table-export-button'));
		await fireEvent.click(await screen.findByTestId('table-export-xlsx'));
		expect(spy).toHaveBeenCalledWith(TAB_ID, expect.objectContaining({ format: 'xlsx' }));
	});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- TableView'`
Expected: FAIL — no `table-export-json` element exists.

- [ ] **Step 3: Implement the dropdown**

In `frontend/src/lib/components/Table/TableView.svelte`:

1. Add `import * as DropdownMenu from '$lib/components/ui/dropdown-menu';` to the imports.
2. Change `exportTable()` to take the format:

```ts
	async function exportTable(format: 'xlsx' | 'json'): Promise<void> {
		if (exporting) return; // one export at a time — the trigger is disabled too
		saveError = null;
		exporting = true;
		exportAbort = new AbortController();
		try {
			await downloadTable(tabId, {
				format,
				onProgress: (p) => (exportProgress = p),
				signal: exportAbort.signal
			});
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exporting = false;
			exportProgress = null;
			exportAbort = null;
		}
	}
```

3. Replace the existing export `<button>` block with:

```svelte
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						data-testid="table-export-button"
						class="flex items-center gap-1.5 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-60"
						disabled={exporting}
						title={exporting
							? 'Waiting for this table’s script values to finish computing'
							: undefined}
					>
						<!-- A disabled trigger with static text is the whole "the export
						     did nothing" complaint: the spinner is what says the retry
						     loop is alive while the backend answers 202. -->
						{#if exporting}
							<span
								class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
							></span>
						{/if}
						{#if exportProgress}
							Preparing… {exportProgress.done}/{exportProgress.total ?? '…'}
						{:else if exporting}
							Exporting…
						{:else}
							Export ▾
						{/if}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-44">
						<DropdownMenu.Item
							data-testid="table-export-xlsx"
							onSelect={() => void exportTable('xlsx')}
						>
							Excel (.xlsx)
						</DropdownMenu.Item>
						<DropdownMenu.Item
							data-testid="table-export-json"
							onSelect={() => void exportTable('json')}
						>
							JSON (.json)
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- TableView'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table/TableView.svelte \
        frontend/src/lib/components/Table/__tests__/TableView.test.ts
git commit -m "feat(frontend): offer xlsx and json from the table Export button"
```

---

### Task 11: Frontend — the JSON export settings tab

**Files:**
- Create: `frontend/src/lib/components/Table/JsonExportEditor.svelte`
- Create: `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts`
- Modify: `frontend/src/lib/components/Table/TableView.svelte`

**Interfaces:**
- Consumes: `defaultJsonKeys`, `snakeCaseKey`, `setColumnJsonOptions` (Task 8); `previewTableJson` (Task 9); `getTableDraft`, `updateTableDefinition` (existing state).
- Produces: `JsonExportEditor` taking `{ tabId: string }`; test ids `json-key-<index>`, `json-value-<index>`, `json-group-<index>`, `json-snake-all`, `json-preview`, `json-preview-truncated`, plus `settings-tab-columns` / `settings-tab-json` on the tab strip.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts`:

```ts
import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import JsonExportEditor from '../JsonExportEditor.svelte';
import * as tableState from '$lib/state/table-editor.svelte';
import * as tablesApi from '$lib/api/tables';
import type { TableDefinition } from '$lib/api/types';

const TAB_ID = 'tab-1';

function defn(): TableDefinition {
	return {
		schema_version: 1,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{ kind: 'property', source: { kind: 'row', chain_index: 0 }, name: 'name', mode: 'collapse', keep_empty: true, header: 'Name', hidden: false },
			{ kind: 'navigation', source: { kind: 'row', chain_index: 0 }, navigation: {}, mode: 'expand', keep_empty: true, sort_mode: 'value', cell_cap: 20, header: 'Component', hidden: false },
			{ kind: 'property', source: { kind: 'row', chain_index: 0 }, name: 'mass', mode: 'collapse', keep_empty: true, header: 'Hidden', hidden: true }
		],
		default_cell_mode: 'collapse',
		show_row_numbers: false
	} as TableDefinition;
}

let current: TableDefinition;

beforeEach(() => {
	current = defn();
	vi.spyOn(tableState, 'getTableDraft').mockImplementation(
		() => ({ definition: current, name: 't', dirty: false, artifactId: null }) as never
	);
	vi.spyOn(tableState, 'updateTableDefinition').mockImplementation((_id, d) => {
		current = d;
	});
	vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
});

describe('JsonExportEditor', () => {
	it('shows the derived key as a placeholder and skips hidden columns', async () => {
		render(JsonExportEditor, { props: { tabId: TAB_ID } });
		expect((await screen.findByTestId('json-key-0')).getAttribute('placeholder')).toBe('Name');
		expect(screen.queryByTestId('json-key-2')).toBeNull();
	});

	it('writes an edited key into the definition', async () => {
		render(JsonExportEditor, { props: { tabId: TAB_ID } });
		await fireEvent.input(await screen.findByTestId('json-key-0'), {
			target: { value: 'name' }
		});
		expect(current.columns[0].json_export?.key).toBe('name');
	});

	it('offers the group checkbox only on an expand column', async () => {
		render(JsonExportEditor, { props: { tabId: TAB_ID } });
		expect(await screen.findByTestId('json-group-1')).toBeTruthy();
		expect(screen.queryByTestId('json-group-0')).toBeNull();
	});

	it('toggles grouping', async () => {
		render(JsonExportEditor, { props: { tabId: TAB_ID } });
		await fireEvent.click(await screen.findByTestId('json-group-1'));
		expect(current.columns[1].json_export?.group).toBe(true);
	});

	it('offers the value select only on element-producing columns', async () => {
		render(JsonExportEditor, { props: { tabId: TAB_ID } });
		expect(await screen.findByTestId('json-value-1')).toBeTruthy();
		expect(screen.queryByTestId('json-value-0')).toBeNull();
	});

	it('snake_cases every visible column at once', async () => {
		render(JsonExportEditor, { props: { tabId: TAB_ID } });
		await fireEvent.click(await screen.findByTestId('json-snake-all'));
		expect(current.columns[0].json_export?.key).toBe('name');
		expect(current.columns[1].json_export?.key).toBe('component');
		expect(current.columns[2].json_export).toBeUndefined(); // hidden: untouched
	});

	it('renders the server-side preview', async () => {
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({
			sample: '[\n  {"Name": "Root"}\n]',
			truncated: true
		});
		render(JsonExportEditor, { props: { tabId: TAB_ID } });
		expect((await screen.findByTestId('json-preview')).textContent).toContain('"Name": "Root"');
		expect(await screen.findByTestId('json-preview-truncated')).toBeTruthy();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- JsonExportEditor'`
Expected: FAIL — the component file does not exist.

- [ ] **Step 3: Create the component**

Create `frontend/src/lib/components/Table/JsonExportEditor.svelte`:

```svelte
<script lang="ts">
	// The "JSON export" settings tab: one row per VISIBLE column (key, element
	// rendering, group), plus a live sample.
	//
	// The sample is fetched from `POST /tables/json-preview` rather than built
	// here on purpose: grouping is a non-trivial algorithm over the evaluator's
	// row keys, and a second implementation in TypeScript would drift from
	// `core/table/json_export.py` — the pane would then confidently show
	// something the download does not produce.
	import { getTableDraft, updateTableDefinition } from '$lib/state';
	import { defaultJsonKeys, setColumnJsonOptions, snakeCaseKey } from '$lib/table/columns';
	import { previewTableJson } from '$lib/api/tables';
	import type { Column, TableDefinition } from '$lib/api/types';

	let { tabId }: { tabId: string } = $props();

	const draft = $derived(getTableDraft(tabId));
	const defn = $derived(draft?.definition);
	const keys = $derived(defn ? defaultJsonKeys(defn) : []);

	/** A column whose cells can hold element references — the only place the
	 *  name/id/object choice means anything. A property column never does. */
	function producesElements(col: Column): boolean {
		return col.kind === 'element' || col.kind === 'navigation' || col.kind === 'script';
	}

	/** `group` is honored by the backend only on a visible expand column, so
	 *  the checkbox exists only where it would do something. */
	function canGroup(col: Column): boolean {
		return 'mode' in col && col.mode === 'expand';
	}

	function patch(index: number, p: Parameters<typeof setColumnJsonOptions>[2]): void {
		if (!defn) return;
		updateTableDefinition(tabId, setColumnJsonOptions(defn, index, p));
	}

	function snakeAll(): void {
		if (!defn) return;
		let next: TableDefinition = defn;
		const derived = defaultJsonKeys(defn);
		derived.forEach((k, i) => {
			if (k === null) return; // hidden: no key to rewrite
			next = setColumnJsonOptions(next, i, { key: snakeCaseKey(k) });
		});
		updateTableDefinition(tabId, next);
	}

	// Preview follows the definition. Debounced so typing a key does not fire a
	// whole-table build per keystroke; the last write wins via the token guard.
	let sample = $state('');
	let truncated = $state(false);
	let previewError = $state<string | null>(null);
	let token = 0;
	$effect(() => {
		const d = defn;
		if (!d) return;
		const mine = ++token;
		const timer = setTimeout(() => {
			void previewTableJson({ definition: d })
				.then((r) => {
					if (mine !== token) return; // a newer edit is in flight
					sample = r.sample;
					truncated = r.truncated;
					previewError = null;
				})
				.catch((e: unknown) => {
					if (mine !== token) return;
					previewError = e instanceof Error ? e.message : 'Preview failed';
				});
		}, 300);
		return () => clearTimeout(timer);
	});
</script>

{#if defn}
	<div class="flex flex-col gap-3 p-1">
		<div class="flex items-center gap-2">
			<p class="flex-1 text-xs text-muted-foreground">
				One JSON object per row. Grouping an expanded column rolls its rows back into an array.
			</p>
			<button
				type="button"
				data-testid="json-snake-all"
				class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
				onclick={snakeAll}
			>
				snake_case all
			</button>
		</div>

		<table class="w-full text-xs">
			<thead class="text-muted-foreground">
				<tr>
					<th class="py-1 text-left font-normal">Column</th>
					<th class="py-1 text-left font-normal">Key</th>
					<th class="py-1 text-left font-normal">Value</th>
					<th class="py-1 text-left font-normal">Group</th>
				</tr>
			</thead>
			<tbody>
				{#each defn.columns as col, i (i)}
					{#if !col.hidden}
						<tr class="border-t border-border">
							<td class="py-1 pr-2 text-muted-foreground">{col.header || col.kind}</td>
							<td class="py-1 pr-2">
								<input
									data-testid={`json-key-${i}`}
									class="w-full rounded border border-input bg-card px-2 py-1"
									placeholder={keys[i] ?? ''}
									value={col.json_export?.key ?? ''}
									oninput={(e) => patch(i, { key: e.currentTarget.value })}
								/>
							</td>
							<td class="py-1 pr-2">
								{#if producesElements(col)}
									<select
										data-testid={`json-value-${i}`}
										class="rounded border border-input bg-card px-1 py-1"
										value={col.json_export?.value ?? 'name'}
										onchange={(e) =>
											patch(i, {
												value: e.currentTarget.value as 'name' | 'id' | 'object'
											})}
									>
										<option value="name">name</option>
										<option value="id">id</option>
										<option value="object">object</option>
									</select>
								{:else}
									<span class="text-muted-foreground/60">–</span>
								{/if}
							</td>
							<td class="py-1">
								{#if canGroup(col)}
									<input
										type="checkbox"
										data-testid={`json-group-${i}`}
										checked={col.json_export?.group ?? false}
										onchange={(e) => patch(i, { group: e.currentTarget.checked })}
									/>
								{:else}
									<span class="text-muted-foreground/60">–</span>
								{/if}
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>

		<div class="flex flex-col gap-1">
			<div class="flex items-center gap-2">
				<span class="text-xs text-muted-foreground">Preview</span>
				{#if truncated}
					<span data-testid="json-preview-truncated" class="text-[11px] text-muted-foreground/70">
						first rows only
					</span>
				{/if}
			</div>
			{#if previewError}
				<p class="text-xs text-destructive">{previewError}</p>
			{:else}
				<pre
					data-testid="json-preview"
					class="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 text-[11px]">{sample}</pre>
			{/if}
		</div>
	</div>
{/if}
```

- [ ] **Step 4: Add the tab strip to the Settings dialog**

In `frontend/src/lib/components/Table/TableView.svelte`:

1. Import the component: `import JsonExportEditor from './JsonExportEditor.svelte';`
2. Add state next to the other dialog state: `let settingsTab = $state<'columns' | 'json'>('columns');`
3. In `openSettings`, reset it so a column-focused open always lands on Columns — add `settingsTab = 'columns';` next to the existing `settingsFocus = focus;` line.
4. Replace the dialog body `<div class="min-h-0 flex-1 overflow-y-auto pr-1"> <ColumnManager ... /> </div>` with:

```svelte
				<div class="flex shrink-0 items-center gap-1 border-b border-border pb-1">
					<button
						type="button"
						data-testid="settings-tab-columns"
						aria-selected={settingsTab === 'columns'}
						class="rounded px-2 py-1 text-xs transition-colors aria-selected:bg-muted aria-selected:text-foreground text-muted-foreground hover:bg-muted/60"
						onclick={() => (settingsTab = 'columns')}
					>
						Columns
					</button>
					<button
						type="button"
						data-testid="settings-tab-json"
						aria-selected={settingsTab === 'json'}
						class="rounded px-2 py-1 text-xs transition-colors aria-selected:bg-muted aria-selected:text-foreground text-muted-foreground hover:bg-muted/60"
						onclick={() => (settingsTab = 'json')}
					>
						JSON export
					</button>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto pr-1">
					{#if settingsTab === 'columns'}
						<ColumnManager {tabId} focusIndex={settingsFocus} />
					{:else}
						<JsonExportEditor {tabId} />
					{/if}
				</div>
```

- [ ] **Step 5: Add a tab-strip test**

Append to `frontend/src/lib/components/Table/__tests__/TableView.test.ts`:

```ts
	it('switches the settings dialog between the columns and json tabs', async () => {
		render(TableView, { props: { tabId: TAB_ID } });
		await fireEvent.click(await screen.findByTestId('table-settings-button'));
		expect(await screen.findByTestId('settings-tab-columns')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await fireEvent.click(await screen.findByTestId('settings-tab-json'));
		expect(await screen.findByTestId('json-snake-all')).toBeTruthy();
	});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npm test -- JsonExportEditor TableView'`
Expected: PASS

- [ ] **Step 7: Typecheck**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/components/Table/JsonExportEditor.svelte \
        frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts \
        frontend/src/lib/components/Table/TableView.svelte \
        frontend/src/lib/components/Table/__tests__/TableView.test.ts
git commit -m "feat(frontend): add the JSON export settings tab with a live preview"
```

---

### Task 12: Documentation and the full gate

**Files:**
- Modify: `CLAUDE.md`, `frontend/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Document the backend in `CLAUDE.md`**

In the "Code execution (snippets)" section, add a new bullet immediately after the one beginning "**Embedded evaluation (M2/M3 — `ScriptColumn`/`ScriptStep`)**" (it is the last bullet of that section, and it already discusses `/tables/export`):

```markdown
- **Table export formats** — `POST /tables/export` takes `format: "xlsx" | "json"` (default `xlsx`) and branches only at its final render step, so the 202/completeness-probe preamble is shared. JSON rendering lives in `core/table/json_export.py` (pure; core needs no dependency for it, unlike the xlsx writer in `api/table_export.py`). Per-column settings ride on the column itself as `json_export: JsonColumnOptions | None` (`key` / `value` / `group`) so reorder/insert/remove need no index remapping. `group` rolls an `expand` column's rows back into an array, keyed off the `RowKey` expand slot — never off value comparison — and nests any column that transitively sources it; it is honored only on a VISIBLE EXPAND column and tolerantly ignored elsewhere. Failed and uncomputed cells render `{"$error": ...}` rather than `null` so a consumer can tell failure from emptiness. `POST /tables/json-preview` renders a bounded sample through the same function for the settings UI.
```

- [ ] **Step 2: Document the frontend in `frontend/README.md`**

Add to whichever section covers the table workspace tab:

```markdown
### Table JSON export

The Export button is a dropdown (Excel `.xlsx` / JSON `.json`); both formats go
through the same `downloadTable` retry loop, because the backend's 202 +
`Retry-After` protocol is format-agnostic.

JSON settings live per column (`json_export: {key, value, group}`) and are edited
in the "JSON export" tab of the table Settings dialog
(`components/Table/JsonExportEditor.svelte`). `defaultJsonKeys` in
`lib/table/columns.ts` mirrors the backend's key derivation, but ONLY to fill
input placeholders — the sample pane fetches `POST /tables/json-preview` so the
grouping algorithm is never reimplemented in TypeScript.
```

- [ ] **Step 3: Run the full gate**

```bash
pixi run -e core-dev pytest -q
pixi run -e frontend bash -c 'cd frontend && npm test'
pixi run -e frontend bash -c 'cd frontend && npm run check'
pixi run dr-tidy
```

Expected: all four PASS. `dr-tidy` reformats — re-run the test suites if it touched anything.

- [ ] **Step 4: Manual smoke test**

Start the backend (`pixi run backend-start`) and frontend (`pixi run frontend-start`), open a table with an expand column, and confirm: Export ▾ offers both formats; the JSON file downloads and parses; Settings → JSON export shows a live sample; ticking Group on the expand column changes the sample to a nested array; "snake_case all" rewrites every key.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md frontend/README.md
git commit -m "docs: document the table JSON export"
```

---

## Notes for the implementer

**The grouping rule is the whole feature.** If you find yourself comparing cell
*values* to decide what belongs in a group, stop — the answer is always in the
row key's expand slots. `_expand_slot_of(defn, base_slots, k)` gives column `k`'s
slot; two rows belong to the same group exactly when every non-grouped slot
matches.

**Do not touch the export route's preamble.** The block from `_resolve_table`
down to the fall-through comment after the re-probe encodes a decision table
that took real debugging to get right (see its inline comments). Task 6 changes
only what happens *after* `all_rows` is in hand.

**Hidden columns are evaluated but not emitted.** They can be the source of a
visible column, so dropping them from evaluation would shift `ColumnRef` indices
and the expand-slot arithmetic. `render_json` therefore receives the *unfiltered*
rows and skips hidden columns by their `None` key — unlike the xlsx path, which
pre-slices each row.
