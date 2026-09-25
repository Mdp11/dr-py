# Table Export Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the immediate `Export ▾` download with a modal that lets the user include/exclude, reorder, and rename columns for the exported file (plus the JSON-only key/value/group settings), without touching the grid.

**Architecture:** Export settings are additive, tri-state-defaulted fields on the saved `TableDefinition` (per-column `export`, plus `export_order` / `export_row_number` on the definition). A new pure core module, `core/table/export_layout.py`, turns a definition into an output layout; the export route feeds that layout to the xlsx writer and the JSON renderer at **render time only**, leaving evaluation, row order, and every script cache key untouched. The frontend grows one `ExportDialog.svelte` that edits those fields on the draft definition.

**Tech Stack:** Python 3.14 / pydantic v2 / FastAPI / xlsxwriter (backend, run through `pixi`); SvelteKit 5 runes / zod / Tailwind / bits-ui / vitest (frontend).

## Global Constraints

- **Everything runs through pixi.** There is no global `python` or `node`. Backend tests: `pixi run -e core-dev pytest <path>`. Frontend tests: `pixi run frontend-test`. Lint/format/typecheck: `pixi run dr-tidy` (ruff + mypy + pyright + frontend). All three Python checkers must pass.
- **Spec:** `docs/superpowers/specs/2026-07-28-table-export-settings-design.md`. Reference it in new module docstrings, as the sibling modules do.
- **No migration.** `ColumnExportOptions.include` is `bool | None` (None = follow `hidden`) and `export_order` empty means definition order. A definition with no export settings must produce **the same output it does today** — same columns, same order, same headers, same row numbers. (Asserted structurally, not as a byte comparison: xlsx bytes are not reproducible across runs.) `SCHEMA_VERSION` does **not** change.
- **Render-only rule.** The export-effective definition (`export_definition`) is passed to `build_workbook` / `render_json` / `build_group_plan` **only**. `build_rows_ex`, `order_rows`, `iter_export_rows`, and the script context always receive the ORIGINAL definition. Violating this makes the script cell cache depend on export presentation.
- **Two separate renames.** xlsx uses `ColumnExportOptions.header`; JSON uses the existing `json_export.key`. `export_definition` must NOT fold the xlsx header override into the copy — `resolve_json_keys` falls back to `col.header` and would leak it into JSON keys.
- **Row-number sentinel** is the module constant `ROW_NUMBER_SLOT = -1` from `core/table/export_layout.py` (frontend mirror: `ROW_NUMBER_SLOT` in `frontend/src/lib/table/export-layout.ts`). Never write a bare `-1` in source; a literal `-1` inside a JSON wire payload in a test is fine, since the constant is not reachable there.
- **Docstring style.** This codebase carries dense docstrings explaining *why* an invariant exists. Match it; the docstrings quoted in this plan are the deliverable, not decoration.
- **Commit after every task** with a conventional-commit subject.

---

## File Structure

**Backend — create**

- `src/data_rover/core/table/export_layout.py` — the one place that answers "which columns land in the exported file, in what order, under what names". Pure over a `TableDefinition`; no I/O, no API imports.
- `tests/table/test_export_layout.py` — unit tests for the above.

**Backend — modify**

- `src/data_rover/core/table/schema.py` — add `ColumnExportOptions`, `RowNumberExportOptions`; add `export` to the four column models and `export_order` / `export_row_number` to `TableDefinition`.
- `src/data_rover/core/table/json_export.py` — `render_json` / `_render_level` gain `order` and `row_number`.
- `src/data_rover/api/table_export.py` — `build_workbook`'s `row_numbers: bool` becomes `row_number_col: int | None`.
- `src/data_rover/api/routes/tables.py` — `export_table` and `json_preview` consume the layout.
- `tests/table/test_json_export.py`, `tests/api/test_table_export.py`, `tests/api/test_table_export_json.py` — new cases.

**Frontend — create**

- `frontend/src/lib/table/export-layout.ts` — the client mirror of the normalizer (display only, like `defaultJsonKeys`).
- `frontend/src/lib/table/__tests__/export-layout.test.ts`
- `frontend/src/lib/components/Table/ExportDialog.svelte` — the modal. Absorbs `JsonExportEditor.svelte`.
- `frontend/src/lib/components/Table/__tests__/ExportDialog.test.ts`

**Frontend — modify**

- `frontend/src/lib/api/types.ts` — zod schemas for the new fields.
- `frontend/src/lib/table/columns.ts` — `setColumnExportOptions`, `setRowNumberExportOptions`, `moveExportEntry`, and `export_order` remapping inside `addColumn` / `removeColumn` / `cloneColumn` / `moveColumn`.
- `frontend/src/lib/table/column-dnd.svelte.ts` — optional `validate` hook.
- `frontend/src/lib/components/Table/TableView.svelte` — dropdown opens the dialog; the Settings dialog's JSON tab is removed.
- `frontend/src/lib/table/__tests__/columns.test.ts`, `frontend/src/lib/table/__tests__/column-dnd.test.ts`

**Frontend — delete**

- `frontend/src/lib/components/Table/JsonExportEditor.svelte`
- `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts` (replaced by `ExportDialog.test.ts`)

---

### Task 1: Schema fields + the export layout

**Files:**
- Modify: `src/data_rover/core/table/schema.py` (add two models near `JsonColumnOptions` at line 101; add one field to each of the four column classes; two fields to `TableDefinition` at line 209)
- Create: `src/data_rover/core/table/export_layout.py`
- Test: `tests/table/test_export_layout.py`

**Interfaces:**
- Consumes: `TableDefinition`, `TABLE_ADAPTER` from `core/table/schema.py`.
- Produces:
  - `ColumnExportOptions(include: bool | None = None, header: str = "")`
  - `RowNumberExportOptions(include: bool = True, header: str = "", key: str = "")`
  - `TableDefinition.export_order: list[int]`, `TableDefinition.export_row_number: RowNumberExportOptions | None`
  - `ROW_NUMBER_SLOT: int = -1`
  - `normalized_order(defn: TableDefinition) -> tuple[int, ...]`
  - `ExportLayout(order: tuple[int, ...], rank: tuple[int, ...], row_number_pos: int | None, row_number_header: str, row_number_key: str)`
  - `export_layout(defn: TableDefinition) -> ExportLayout`
  - `export_definition(defn: TableDefinition) -> TableDefinition`
  - `export_header(defn: TableDefinition, index: int) -> str`

- [ ] **Step 1: Write the failing tests**

Create `tests/table/test_export_layout.py`:

```python
"""Export layout: which columns land in an exported file, in what order.

Every assertion here is about PRESENTATION. The definition's own column order
is structural (backward-only ColumnRef, positional expand slots) and is never
permuted — these tests exist to prove the layout is the only thing that moves.
"""

from data_rover.core.table.export_layout import (
    ROW_NUMBER_SLOT,
    export_definition,
    export_header,
    export_layout,
    normalized_order,
)
from data_rover.core.table.schema import TABLE_ADAPTER


def _defn(**over):
    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }
    doc.update(over)
    return TABLE_ADAPTER.validate_python(doc)


def test_defaults_are_definition_order_with_no_row_number():
    layout = export_layout(_defn())
    assert layout.order == (0, 1)
    assert layout.rank == (0, 1)
    assert layout.row_number_pos is None


def test_column_export_options_default_to_none():
    assert _defn().columns[0].export is None


def test_hidden_column_is_excluded_by_default():
    defn = _defn(
        columns=[
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
    assert export_layout(defn).order == (0,)


def test_hidden_column_can_be_opted_into_the_export():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "hidden": True,
                "export": {"include": True},
            },
        ]
    )
    assert export_layout(defn).order == (0, 1)
    assert export_definition(defn).columns[1].hidden is False


def test_visible_column_can_be_opted_out_of_the_export():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "export": {"include": False},
            },
        ]
    )
    assert export_layout(defn).order == (0,)
    assert export_definition(defn).columns[1].hidden is True


def test_export_order_permutes_the_output_only():
    defn = _defn(export_order=[1, 0])
    layout = export_layout(defn)
    assert layout.order == (1, 0)
    assert layout.rank == (1, 0)
    # the definition itself is untouched
    assert [c.header for c in defn.columns] == ["Block", "Mass"]


def test_normalized_order_drops_garbage_and_appends_the_rest():
    # 7 is out of range, the second 1 is a duplicate, -1 has no row-number
    # column to stand for; column 0 was never listed and must come back.
    defn = _defn(export_order=[7, 1, 1, ROW_NUMBER_SLOT])
    assert normalized_order(defn) == (1, 0)


def test_row_number_entry_leads_when_unlisted():
    defn = _defn(show_row_numbers=True)
    layout = export_layout(defn)
    assert normalized_order(defn) == (ROW_NUMBER_SLOT, 0, 1)
    assert layout.row_number_pos == 0
    assert layout.order == (0, 1)
    assert layout.rank == (1, 2)


def test_row_number_entry_sits_where_the_order_puts_it():
    defn = _defn(show_row_numbers=True, export_order=[0, ROW_NUMBER_SLOT, 1])
    layout = export_layout(defn)
    assert layout.row_number_pos == 1
    assert layout.rank == (0, 2)


def test_row_number_entry_can_be_excluded():
    defn = _defn(show_row_numbers=True, export_row_number={"include": False})
    layout = export_layout(defn)
    assert layout.row_number_pos is None
    assert layout.rank == (0, 1)


def test_row_number_names_fall_back_to_the_defaults():
    layout = export_layout(_defn(show_row_numbers=True))
    assert layout.row_number_header == "#"
    assert layout.row_number_key == "row_number"


def test_row_number_names_can_be_overridden():
    defn = _defn(
        show_row_numbers=True,
        export_row_number={"header": "No.", "key": "idx"},
    )
    layout = export_layout(defn)
    assert layout.row_number_header == "No."
    assert layout.row_number_key == "idx"


def test_excluded_columns_rank_past_every_included_one():
    defn = _defn(
        columns=[
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
                "export": {"include": False},
            },
        ]
    )
    layout = export_layout(defn)
    assert layout.rank[1] > max(layout.rank[i] for i in layout.order)


def test_export_header_prefers_the_override_then_header_then_kind():
    defn = _defn(
        columns=[
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "export": {"header": "Assembly"},
            },
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
        ]
    )
    assert export_header(defn, 0) == "Assembly"
    assert export_header(defn, 1) == "property"


def test_export_definition_leaves_headers_alone():
    # The xlsx header override must never reach `resolve_json_keys`, which
    # falls back to `col.header` — the two renames are separate by design.
    defn = _defn(
        columns=[
            {
                "kind": "element",
                "source": {"kind": "row"},
                "header": "Block",
                "export": {"header": "Assembly"},
            },
            {"kind": "property", "source": {"kind": "row"}, "name": "mass"},
        ]
    )
    assert export_definition(defn).columns[0].header == "Block"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_export_layout.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.core.table.export_layout'`

- [ ] **Step 3: Add the schema fields**

In `src/data_rover/core/table/schema.py`, directly **after** the `JsonColumnOptions` class (which ends at line 128):

```python
class ColumnExportOptions(BaseModel):
    """Per-column export overrides (spec:
    docs/superpowers/specs/2026-07-28-table-export-settings-design.md).

    On the COLUMN rather than in an index-keyed map on `TableDefinition`, for
    the same reason `JsonColumnOptions` is: column indices move under reorder,
    insert, and remove, and settings attached to the column travel with it for
    free.

    Presentation-only, like `hidden` and `json_export`: never consulted during
    evaluation.
    """

    #: `None` = follow `hidden`, which is what makes every pre-existing
    #: definition export byte-identically. `True` on a hidden column exports it
    #: WITHOUT unhiding it in the grid; `False` on a visible one keeps it on
    #: screen and out of the file.
    include: bool | None = None
    #: xlsx header override; "" keeps today's `header or kind`. JSON renames
    #: through `json_export.key` instead and ignores this — one rename box per
    #: format, never two on one row.
    header: str = ""


class RowNumberExportOptions(BaseModel):
    """Export overrides for the row-number pseudo-column.

    Lives on the definition rather than on a column because there is no
    `Column` to hang it off: the row-number column is synthesized by the
    renderers from `show_row_numbers`.
    """

    include: bool = True
    #: "" -> "#" (xlsx).
    header: str = ""
    #: "" -> "row_number" (JSON).
    key: str = ""
```

Add to **each** of `ElementColumn`, `PropertyColumn`, `NavigationColumn`, `ScriptColumn`, immediately after their `json_export` field:

```python
    #: Export overrides (inclusion, xlsx header). `None` means "all defaults",
    #: which keeps saved payloads clean for the overwhelming majority.
    export: ColumnExportOptions | None = None
```

Add to `TableDefinition`, after `show_row_numbers` (line 217):

```python
    #: Output order for the export, as definition column indices, with
    #: `export_layout.ROW_NUMBER_SLOT` (-1) standing for the row-number
    #: pseudo-column. `[]` = definition order. NOT an evaluation order:
    #: column order is structural (backward-only `ColumnRef`, positional
    #: expand slots) and is never permuted — this reorders the OUTPUT.
    #: Normalized rather than validated (see `export_layout.normalized_order`):
    #: a stale list left behind by a column insert or remove must degrade to a
    #: sensible order, not 422 the whole export.
    export_order: list[int] = Field(default_factory=list)
    export_row_number: RowNumberExportOptions | None = None
```

- [ ] **Step 4: Write `export_layout.py`**

Create `src/data_rover/core/table/export_layout.py`:

```python
"""Which columns an export contains, in what order, under what names.

Presentation only, and deliberately a separate module from `schema.py`: this
is the ONE place that answers the question, so the xlsx writer, the JSON
renderer, and the settings UI's client-side mirror cannot drift apart.

The load-bearing idea is that an export never permutes the definition. Column
order there is structural — a `ColumnRef` may only point backwards and expand
slots are positional — so `export_order` describes an OUTPUT order and the
renderers walk the definition through it.

Spec: docs/superpowers/specs/2026-07-28-table-export-settings-design.md
"""

from __future__ import annotations

from dataclasses import dataclass

from .schema import TableDefinition

#: `export_order`'s stand-in for the row-number pseudo-column, which has no
#: definition index of its own. Negative so it can never collide with one.
ROW_NUMBER_SLOT = -1

DEFAULT_ROW_NUMBER_HEADER = "#"
DEFAULT_ROW_NUMBER_KEY = "row_number"


@dataclass(frozen=True)
class ExportLayout:
    """Where every column lands in one exported file.

    `order` and `rank` are two views of the same permutation because the two
    renderers need opposite lookups: the xlsx writer walks output positions and
    needs the definition index at each (`order`), while `json_export` walks
    definition indices and needs each one's output position (`rank`).
    """

    #: Definition indices, in export order, INCLUDED ones only.
    order: tuple[int, ...]
    #: Output position per DEFINITION column index, positionally aligned with
    #: `defn.columns`. An excluded column ranks past every included one rather
    #: than raising, so a stray reference sorts last instead of exploding.
    rank: tuple[int, ...]
    #: Output position of the row-number pseudo-column (0 = first), or `None`
    #: when `show_row_numbers` is off or it was excluded. In the SAME position
    #: space as `rank`.
    row_number_pos: int | None
    #: Already defaulted — callers never re-apply the `or "#"` fallback.
    row_number_header: str
    row_number_key: str


def _included(defn: TableDefinition) -> list[bool]:
    """Per definition column, whether the export contains it. `include=None`
    follows `hidden`, which is the whole no-migration guarantee."""
    out: list[bool] = []
    for col in defn.columns:
        opts = col.export
        if opts is None or opts.include is None:
            out.append(not col.hidden)
        else:
            out.append(opts.include)
    return out


def normalized_order(defn: TableDefinition) -> tuple[int, ...]:
    """`export_order` made safe, INCLUDING excluded entries.

    Drops out-of-range and duplicate entries, drops `ROW_NUMBER_SLOT` when
    `show_row_numbers` is off, then appends every definition column the list
    forgot. When row numbers are on and the slot is absent it leads — that is
    where the "#" column has always sat.

    Normalized, never validated: `export_order` is a presentation setting, and
    a stale list left behind by a column insert or remove must not be able to
    block an export.
    """
    n = len(defn.columns)
    seen: set[int] = set()
    out: list[int] = []
    for i in defn.export_order:
        if i == ROW_NUMBER_SLOT:
            if not defn.show_row_numbers or i in seen:
                continue
        elif not (0 <= i < n) or i in seen:
            continue
        seen.add(i)
        out.append(i)
    if defn.show_row_numbers and ROW_NUMBER_SLOT not in seen:
        out.insert(0, ROW_NUMBER_SLOT)
    out.extend(i for i in range(n) if i not in seen)
    return tuple(out)


def export_layout(defn: TableDefinition) -> ExportLayout:
    """The definition's export settings resolved into output positions."""
    included = _included(defn)
    rn = defn.export_row_number
    rn_included = defn.show_row_numbers and (rn is None or rn.include)

    order: list[int] = []
    # Sentinel for an excluded column. Positions run 0..len(columns), so
    # len(columns) + 1 is past every one of them.
    rank = [len(defn.columns) + 1] * len(defn.columns)
    row_number_pos: int | None = None
    pos = 0
    for i in normalized_order(defn):
        if i == ROW_NUMBER_SLOT:
            if not rn_included:
                continue
            row_number_pos = pos
        else:
            if not included[i]:
                continue
            rank[i] = pos
            order.append(i)
        pos += 1

    return ExportLayout(
        order=tuple(order),
        rank=tuple(rank),
        row_number_pos=row_number_pos,
        row_number_header=(rn.header if rn is not None else "")
        or DEFAULT_ROW_NUMBER_HEADER,
        row_number_key=(rn.key if rn is not None else "") or DEFAULT_ROW_NUMBER_KEY,
    )


def export_definition(defn: TableDefinition) -> TableDefinition:
    """A copy of `defn` whose `hidden` flags say what the EXPORT includes.

    Reusing `hidden` is the point. `resolve_json_keys`, `_honors_group`, and
    `build_group_plan` already skip hidden columns, and the group plan derives
    its whole nesting structure from them; an export-effective copy inherits
    all of that instead of threading a second include-set through three
    functions that would then have to agree forever.

    Header overrides are deliberately NOT applied here — see `export_header`.
    `resolve_json_keys` falls back to `col.header`, so folding the xlsx header
    override into this copy would leak it into JSON keys, and the two renames
    are separate by design.

    RENDER ONLY. Evaluation keeps the ORIGINAL definition: `hidden` is
    presentation, but this copy is not what the user wrote, and feeding it to
    `build_rows_ex`/`order_rows`/`iter_export_rows`/the script context would
    make cached cells depend on export settings.
    """
    included = _included(defn)
    columns = [
        col if col.hidden == (not inc) else col.model_copy(update={"hidden": not inc})
        for col, inc in zip(defn.columns, included, strict=True)
    ]
    return defn.model_copy(update={"columns": columns})


def export_header(defn: TableDefinition, index: int) -> str:
    """The xlsx header for one column: its export override, else its grid
    header, else its kind — the last two being exactly today's fallback."""
    col = defn.columns[index]
    opts = col.export
    return (opts.header if opts is not None else "") or col.header or col.kind
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_export_layout.py -v`
Expected: PASS (14 tests)

- [ ] **Step 6: Verify nothing else regressed**

Run: `pixi run -e core-dev pytest tests/table tests/api/test_table_export.py tests/api/test_table_export_json.py -q`
Expected: PASS — the new fields are additive with defaults, so every existing table test is unaffected.

- [ ] **Step 7: Lint and commit**

```bash
pixi run core-lint
git add src/data_rover/core/table/schema.py src/data_rover/core/table/export_layout.py tests/table/test_export_layout.py
git commit -m "feat(table): export layout — per-column export overrides and output order"
```

---

### Task 2: JSON renderer honors export order and row numbers

**Files:**
- Modify: `src/data_rover/core/table/json_export.py` (`render_json` at line 284, `_render_level` at line 327, `_render_group` at line 368)
- Test: `tests/table/test_json_export.py` (append)

**Interfaces:**
- Consumes: `ROW_NUMBER_SLOT` from `core/table/export_layout.py`; `ExportLayout.rank` / `.row_number_pos` / `.row_number_key` (Task 1).
- Produces: `render_json(model, defn, row_keys, row_iter, base_slots, *, order: Sequence[int] | None = None, row_number: tuple[int, str] | None = None) -> list[dict[str, object]]`. `order` is a **rank list indexed by definition column index** (i.e. `ExportLayout.rank`), not the order list. `row_number` is `(output_position, key)`.

- [ ] **Step 1: Write the failing tests**

First extend the file's existing `_render` helper (`tests/table/test_json_export.py:714`) so every existing caller keeps working:

```python
def _render(mm, model, doc, *, order=None, row_number=None):
    defn = TABLE_ADAPTER.validate_python(doc)
    build = build_rows_ex(mm, model, defn)
    return render_json(
        model,
        defn,
        build.keys,
        iter_export_rows(mm, model, defn, build.keys),
        build.base_slots,
        order=order,
        row_number=row_number,
    )
```

Then append these tests to the same file. They reuse `_parts_mm`, `_parts_model`, and `_hop_nav`, which are already defined there:

```python
def _two_col_doc() -> dict:
    return {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "name",
                "header": "Name",
            },
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }


def test_render_json_honors_export_order():
    # Key ORDER in the object is the observable: JSON objects preserve
    # insertion order and consumers read it.
    mm = _parts_mm()
    docs = _render(mm, _parts_model(mm), _two_col_doc(), order=[1, 0])
    assert list(docs[0].keys()) == ["Mass", "Name"]


def test_render_json_without_order_is_unchanged():
    mm = _parts_mm()
    model = _parts_model(mm)
    assert _render(mm, model, _two_col_doc()) == _render(
        mm, model, _two_col_doc(), order=[0, 1]
    )


def test_render_json_emits_the_row_number_at_its_position():
    # Column 0 at output position 0, the row number at 1, column 1 at 2.
    mm = _parts_mm()
    docs = _render(
        mm,
        _parts_model(mm),
        _two_col_doc(),
        order=[0, 2],
        row_number=(1, "row_number"),
    )
    assert list(docs[0].keys()) == ["Name", "row_number", "Mass"]
    assert [d["row_number"] for d in docs] == list(range(1, len(docs) + 1))


def test_render_json_omits_the_row_number_inside_groups():
    # A grouped column's array entries are not rows, so a row number there
    # would have no referent.
    mm = _parts_mm()
    docs = _render(
        mm,
        _parts_model(mm),
        {
            "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
            "columns": [
                {
                    "kind": "property",
                    "source": {"kind": "row"},
                    "name": "name",
                    "header": "Name",
                },
                _hop_nav("expand", group=True),
                {
                    "kind": "property",
                    "source": {"kind": "column", "index": 1},
                    "name": "mass",
                    "header": "Component Mass",
                },
            ],
        },
        order=[1, 2, 3],
        row_number=(0, "row_number"),
    )
    root = next(d for d in docs if d.get("Name") == "Root")
    # top level has it, first, and numbering runs 1..n over the objects
    assert list(root.keys())[0] == "row_number"
    assert sorted(d["row_number"] for d in docs) == list(range(1, len(docs) + 1))
    # the group entries do NOT
    assert root["Component"] == [
        {"Component": "Part 1", "Component Mass": 12},
        {"Component": "Part 2", "Component Mass": 9},
    ]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -k "export_order or row_number" -v`
Expected: FAIL — `TypeError: render_json() got an unexpected keyword argument 'order'`

- [ ] **Step 3: Thread `order` and `row_number` through the renderer**

In `src/data_rover/core/table/json_export.py`:

Add to the imports:

```python
from collections.abc import Iterable, Sequence

from .export_layout import ROW_NUMBER_SLOT
```

Replace `render_json`'s signature and its return statement:

```python
def render_json(
    model: Model,
    defn: TableDefinition,
    row_keys: list[RowKey],
    row_iter: Iterable[list[Cell]],
    base_slots: int,
    *,
    order: Sequence[int] | None = None,
    row_number: tuple[int, str] | None = None,
) -> list[dict[str, object]]:
```

Extend its docstring with:

```
    `order` is a RANK LIST indexed by definition column index — that is,
    `ExportLayout.rank`, not the order list itself — so the lookup in the
    render loop is a subscript rather than a search. `None` keeps definition
    order.

    `row_number` is `(output_position, key)` and is emitted in TOP-LEVEL
    objects only: inside a grouped array the entries are not rows, so a row
    number there would have no referent. The number is the object's 1-based
    position in the returned list, which follows the requested sort.
```

and replace the return with:

```python
    return [
        _render_level(
            model,
            defn,
            keys,
            plan,
            plan.top_columns,
            plan.top_groups,
            b,
            order=order,
            row_number=(row_number[0], row_number[1], n) if row_number else None,
        )
        for n, b in enumerate(buckets, start=1)
    ]
```

Rewrite `_render_level`'s signature and body loop (docstring keeps its existing text; append the new paragraph below):

```python
def _render_level(
    model: Model,
    defn: TableDefinition,
    keys: JsonKeys,
    plan: GroupPlan,
    columns: tuple[int, ...],
    groups: tuple[int, ...],
    rows: list[_Pair],
    *,
    order: Sequence[int] | None = None,
    row_number: tuple[int, str, int] | None = None,
) -> dict[str, object]:
```

Append to its docstring:

```
    Emission order is the EXPORT order when `order` is given, definition order
    otherwise. `row_number` is `(position, key, number)` and is passed only for
    a top-level object — `_render_group` never forwards it.
```

Body:

```python
    group_set = set(groups)
    # (position, definition index) so the sort is total and stable. With no
    # `order` the position IS the definition index; ROW_NUMBER_SLOT's -1 then
    # breaks a tie toward the row number, which is where it belongs.
    entries: list[tuple[int, int]] = [
        (order[i] if order is not None else i, i) for i in (*columns, *groups)
    ]
    if row_number is not None:
        entries.append((row_number[0], ROW_NUMBER_SLOT))

    obj: dict[str, object] = {}
    for _, i in sorted(entries):
        if i == ROW_NUMBER_SLOT:
            assert row_number is not None
            obj[row_number[1]] = row_number[2]
        elif i in group_set:
            key = keys.level[i]
            if key is None:  # hidden: evaluated, never emitted
                continue
            obj[key] = _render_group(
                model, defn, keys, plan, i, rows, order=order
            )
        else:
            # A grouped column reached here is rendering its own value inside
            # its own entries, which is what `item` names.
            key = keys.item[i] if i in plan.grouped else keys.level[i]
            if key is None:  # hidden: evaluated, never emitted
                continue
            obj[key] = render_cell(model, rows[0][1][i], _mode_of(defn.columns[i]))
    return obj
```

Give `_render_group` the same pass-through — add `*, order: Sequence[int] | None = None` to its signature and forward it in its `_render_level` call:

```python
    return [
        _render_level(
            model, defn, keys, plan, members, children, sub, order=order
        )
        for sub in parts.values()
    ]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS — including every pre-existing test, since `order=None` reproduces `sorted([*columns, *groups])` exactly.

- [ ] **Step 5: Lint and commit**

```bash
pixi run core-lint
git add src/data_rover/core/table/json_export.py tests/table/test_json_export.py
git commit -m "feat(table): render_json honors export order and row numbers"
```

---

### Task 3: xlsx writer takes a row-number position

**Files:**
- Modify: `src/data_rover/api/table_export.py:87-162`
- Test: `tests/api/test_table_export.py` (append a direct unit test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `build_workbook(model, headers, sheet_name, row_iter, *, notice_provider=None, row_number_col: int | None = None) -> bytes`. **`headers` now includes the row-number header at `row_number_col`**, and each row from `row_iter` carries `len(headers) - 1` cells when `row_number_col` is not `None`. The old `row_numbers: bool` parameter is gone.

- [ ] **Step 1: Write the failing test**

Append to `tests/api/test_table_export.py`:

```python
def test_build_workbook_places_row_numbers_at_a_middle_column():
    # Regression guard for the reorderable row-number entry: the old API could
    # only PREPEND, so a row number anywhere but column A was unreachable.
    from data_rover.api.table_export import build_workbook
    from data_rover.core.metamodel.schema import Metamodel
    from data_rover.core.model.model import Model
    from data_rover.core.table.cells import ValueCell

    def v(text: str) -> ValueCell:
        return ValueCell(present=True, value=text, element_id=None, editable=False)

    blob = build_workbook(
        Model(Metamodel()),
        ["A", "#", "B"],
        "Sheet",
        [[v("a1"), v("b1")], [v("a2"), v("b2")]],
        row_number_col=1,
    )
    ws = load_workbook(io.BytesIO(blob)).active
    assert ws is not None
    assert [c.value for c in ws[1]] == ["A", "#", "B"]
    assert [c.value for c in ws[2]] == ["a1", 1, "b1"]
    assert [c.value for c in ws[3]] == ["a2", 2, "b2"]
    # the autofilter still spans every column, row number included
    assert ws.auto_filter.ref == "A1:C3"
```

`ValueCell` is a plain dataclass with four required fields, which is why `v()` exists rather than four positional literals per row.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py::test_build_workbook_places_row_numbers_at_a_middle_column -v`
Expected: FAIL — `TypeError: build_workbook() got an unexpected keyword argument 'row_number_col'`

- [ ] **Step 3: Change the writer**

In `src/data_rover/api/table_export.py`, replace the `row_numbers: bool = False` parameter with:

```python
    row_number_col: int | None = None,
```

Replace the `row_numbers` paragraph of the docstring with:

```
    `row_number_col`, if given, is the OUTPUT COLUMN INDEX at which a 1-based
    row number is written. It is a position rather than a prepend flag because
    the export settings let the user drag the row-number entry anywhere in the
    column list. `headers` must already carry that column's header at this
    index, and each row from `row_iter` therefore carries one FEWER cell than
    `headers` has entries. Numbering follows export row order, which follows
    the requested sort.
```

Replace lines 131-145 with:

```python
    for col, h in enumerate(headers):
        ws.write(0, col, h, header_fmt)
    ws.freeze_panes(1, 0)

    r = 0
    for r, row in enumerate(row_iter, start=1):
        cells = iter(row)
        for col in range(len(headers)):
            if col == row_number_col:
                ws.write_number(r, col, r, cell_fmt)
            else:
                ws.write(r, col, _cell_text(model, next(cells)), cell_fmt)

    if headers:
        ws.autofilter(0, 0, r, len(headers) - 1)
```

In the notice block at line 156, update the stale comment (`offset` no longer exists):

```python
            # Column 0 regardless of where the row-number column landed: a
            # notice is not a data row, so it always starts at the sheet's
            # left edge.
            ws.write(r + 1, 0, text)
```

- [ ] **Step 4: Update the one existing caller so the suite runs**

In `src/data_rover/api/routes/tables.py`, change `row_numbers=defn.show_row_numbers` to `row_number_col=0 if defn.show_row_numbers else None` and prepend the header:

```python
        headers = [defn.columns[i].header or defn.columns[i].kind for i in visible]
        if defn.show_row_numbers:
            headers.insert(0, "#")
```

This is a temporary shim — Task 4 replaces the whole block. It exists so this task's commit leaves the suite green.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py -v`
Expected: PASS, including the existing row-number tests (search them out with `-k row_number` and confirm they still assert a leading "#" column).

- [ ] **Step 6: Lint and commit**

```bash
pixi run backend-lint
git add src/data_rover/api/table_export.py src/data_rover/api/routes/tables.py tests/api/test_table_export.py
git commit -m "refactor(table): build_workbook takes a row-number column position"
```

---

### Task 4: Wire the export and preview routes to the layout

**Files:**
- Modify: `src/data_rover/api/routes/tables.py` (`export_table` at line 502, especially 726-801; `json_preview` at line 821, especially 890-896)
- Test: `tests/api/test_table_export.py`, `tests/api/test_table_export_json.py` (append)

**Interfaces:**
- Consumes: `export_definition`, `export_header`, `export_layout` (Task 1); `render_json(..., order=, row_number=)` (Task 2); `build_workbook(..., row_number_col=)` (Task 3).
- Produces: no wire-schema change. `ExportTableIn` and `EvaluateTableIn` are untouched.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_table_export.py`:

```python
def _two_col_body(**defn_over):
    defn = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [
            {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }
    defn.update(defn_over)
    return {"definition": defn}


def test_export_xlsx_honors_export_order_and_header_override(client):
    _bootstrap_model(client)
    body = _two_col_body(export_order=[1, 0])
    body["definition"]["columns"][0]["export"] = {"header": "Assembly"}
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    ws = load_workbook(io.BytesIO(r.content)).active
    assert [c.value for c in ws[1]] == ["Mass", "Assembly"]


def test_export_xlsx_excludes_an_opted_out_column(client):
    _bootstrap_model(client)
    body = _two_col_body()
    body["definition"]["columns"][1]["export"] = {"include": False}
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    ws = load_workbook(io.BytesIO(r.content)).active
    assert [c.value for c in ws[1]] == ["Block"]


def test_export_xlsx_includes_an_opted_in_hidden_column(client):
    _bootstrap_model(client)
    body = _two_col_body()
    body["definition"]["columns"][1]["hidden"] = True
    body["definition"]["columns"][1]["export"] = {"include": True}
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    ws = load_workbook(io.BytesIO(r.content)).active
    assert [c.value for c in ws[1]] == ["Block", "Mass"]


def test_export_xlsx_row_number_column_can_be_moved_and_renamed(client):
    _bootstrap_model(client)
    body = _two_col_body(
        show_row_numbers=True,
        export_order=[0, -1, 1],
        export_row_number={"header": "No."},
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    ws = load_workbook(io.BytesIO(r.content)).active
    assert [c.value for c in ws[1]] == ["Block", "No.", "Mass"]
    assert ws.cell(row=2, column=2).value == 1


def test_export_xlsx_row_number_column_can_be_excluded(client):
    _bootstrap_model(client)
    body = _two_col_body(show_row_numbers=True, export_row_number={"include": False})
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    ws = load_workbook(io.BytesIO(r.content)).active
    assert [c.value for c in ws[1]] == ["Block", "Mass"]


def test_export_xlsx_unchanged_without_export_settings(client):
    # The no-migration guarantee, asserted rather than assumed: a definition
    # that carries no export settings must produce the same sheet it did
    # before this feature existed. Structural, not a byte comparison — xlsx
    # bytes are not reproducible across runs.
    _bootstrap_model(client)
    body = _two_col_body(show_row_numbers=True)
    first = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    ws = load_workbook(io.BytesIO(first.content)).active
    assert [c.value for c in ws[1]] == ["#", "Block", "Mass"]
    assert ws.cell(row=2, column=1).value == 1
```

Append to `tests/api/test_table_export_json.py` (mirror its existing body-building helper rather than the xlsx one above):

```python
def test_export_json_honors_export_order(client):
    _bootstrap_model(client)
    body = _json_body(export_order=[1, 0])
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    docs = r.json()
    assert list(docs[0].keys()) == ["Mass", "Block"]


def test_export_json_excludes_an_opted_out_column(client):
    _bootstrap_model(client)
    body = _json_body()
    body["definition"]["columns"][1]["export"] = {"include": False}
    docs = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS).json()
    assert "Mass" not in docs[0]


def test_export_json_emits_row_numbers_when_the_grid_flag_is_on(client):
    # Deliberate behaviour change (spec, "Behaviour change worth stating"):
    # JSON has never carried row numbers, and now follows show_row_numbers.
    _bootstrap_model(client)
    body = _json_body(show_row_numbers=True)
    docs = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS).json()
    assert list(docs[0].keys())[0] == "row_number"
    assert [d["row_number"] for d in docs] == list(range(1, len(docs) + 1))


def test_export_json_ignores_the_xlsx_header_override(client):
    # The two renames are separate: an xlsx header override must never become
    # a JSON key.
    _bootstrap_model(client)
    body = _json_body()
    body["definition"]["columns"][0]["export"] = {"header": "Assembly"}
    docs = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS).json()
    assert "Block" in docs[0]
    assert "Assembly" not in docs[0]


def test_json_preview_honors_export_settings(client):
    _bootstrap_model(client)
    body = _json_body(export_order=[1, 0])
    r = client.post(papi("/tables/json-preview"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    sample = json.loads(r.json()["sample"])
    assert list(sample[0].keys()) == ["Mass", "Block"]
```

Add `_json_body(**defn_over)` to that file the same shape as `_two_col_body` above, plus `"format": "json"` on the payload, unless an equivalent helper already exists there — if it does, extend it with `**defn_over` rather than adding a second one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py tests/api/test_table_export_json.py -k "export_order or opted or row_number_column or preview_honors or ignores_the_xlsx" -v`
Expected: FAIL — headers come back in definition order, opted-in hidden columns are missing, JSON has no `row_number`.

- [ ] **Step 3: Wire `export_table`**

In `src/data_rover/api/routes/tables.py`, add to the core-table imports:

```python
from data_rover.core.table.export_layout import (
    export_definition,
    export_header,
    export_layout,
)
```

Replace the `visible`/`headers`/`all_rows` block — the one opening with the comment `# Hidden columns are evaluated (a visible column may reference them)`, plus the `headers.insert(0, "#")` shim Task 3 added just below it — with:

```python
        # Export settings are PRESENTATION: the layout says what the file
        # contains and in what order, and `export_definition` restates
        # inclusion as `hidden` so `json_export`'s existing hidden-column and
        # group-nesting logic is reused rather than reimplemented. Both are
        # for the RENDER only — `iter_export_rows` below keeps the ORIGINAL
        # `defn`, so cell values, row order, and every script cache key are
        # exactly what they would be without any of this.
        layout = export_layout(defn)
        eff = export_definition(defn)
        headers = [export_header(defn, i) for i in layout.order]
        if layout.row_number_pos is not None:
            headers.insert(layout.row_number_pos, layout.row_number_header)
        all_rows = iter_export_rows(
            metamodel, model, defn, ordered, limits, script=script_ctx
        )
```

Replace the two render branches — the `if payload.format == "json": … else: …` block that ends with `filename = f"{name}.xlsx"`:

```python
        if payload.format == "json":
            # `render_json` indexes cells by DEFINITION column index, so it
            # gets the UNFILTERED rows — excluded columns are dropped inside it
            # by their `None` key, not by pre-slicing the row like the xlsx
            # path does.
            docs = render_json(
                model,
                eff,
                ordered,
                all_rows,
                build.base_slots,
                order=layout.rank,
                row_number=(layout.row_number_pos, layout.row_number_key)
                if layout.row_number_pos is not None
                else None,
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
                ([row[i] for i in layout.order] for row in all_rows),
                notice_provider=_notice,
                row_number_col=layout.row_number_pos,
            )
            media_type = (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            )
            filename = f"{name}.xlsx"
```

- [ ] **Step 4: Wire `json_preview`**

Replace the `docs = render_json(…)` call inside `json_preview` with:

```python
        layout = export_layout(defn)
        docs = render_json(
            model,
            export_definition(defn),
            window,
            iter_export_rows(metamodel, model, defn, window, limits, script=script_ctx),
            build.base_slots,
            order=layout.rank,
            row_number=(layout.row_number_pos, layout.row_number_key)
            if layout.row_number_pos is not None
            else None,
        )
```

Note the asymmetry that must be preserved: `export_definition(defn)` goes to `render_json`, the ORIGINAL `defn` goes to `iter_export_rows`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py tests/api/test_table_export_json.py -v`
Expected: PASS

- [ ] **Step 6: Run the whole backend suite**

Run: `pixi run core-test`
Expected: PASS

- [ ] **Step 7: Lint and commit**

```bash
pixi run dr-tidy
git add src/data_rover/api/routes/tables.py tests/api/test_table_export.py tests/api/test_table_export_json.py
git commit -m "feat(table): export and json-preview routes honor export settings"
```

---

### Task 5: Frontend types, layout mirror, and column helpers

**Files:**
- Modify: `frontend/src/lib/api/types.ts:718-810`
- Create: `frontend/src/lib/table/export-layout.ts`
- Create: `frontend/src/lib/table/__tests__/export-layout.test.ts`
- Modify: `frontend/src/lib/table/columns.ts` (`addColumn:99`, `removeColumn:119`, `cloneColumn:155`, `moveColumn:170`; new helpers after `setColumnJsonOptions:341`)
- Test: `frontend/src/lib/table/__tests__/columns.test.ts` (append)

**Interfaces:**
- Consumes: `TableDefinition`, `Column` from `$lib/api/types`.
- Produces:
  - `ColumnExportOptions = { include: boolean | null; header: string }`, `RowNumberExportOptions = { include: boolean; header: string; key: string }` (exported types + zod schemas `ColumnExportOptionsSchema`, `RowNumberExportOptionsSchema`)
  - `ROW_NUMBER_SLOT = -1`, `ExportEntry = { index: number; included: boolean }`, `exportEntries(defn: TableDefinition): ExportEntry[]` (from `$lib/table/export-layout`)
  - `setColumnExportOptions(defn, index, patch: Partial<ColumnExportOptions>): TableDefinition`
  - `setRowNumberExportOptions(defn, patch: Partial<RowNumberExportOptions>): TableDefinition`
  - `moveExportEntry(defn, from: number, to: number): TableDefinition` — `from`/`to` are **positions in the export list**, not definition indices.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/table/__tests__/export-layout.test.ts`:

```ts
// Mirror of `core/table/export_layout.py`'s normalizer. DISPLAY ONLY — the
// authoritative layout is the backend's; this exists so the export dialog can
// render the list (including EXCLUDED entries, which the backend's own layout
// drops) without a round trip.
import { describe, expect, it } from 'vitest';
import type { TableDefinition } from '$lib/api/types';
import { ROW_NUMBER_SLOT, exportEntries } from '../export-layout';

function defn(over: Partial<TableDefinition> = {}): TableDefinition {
	return {
		schema_version: 1,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: 'Block',
				hidden: false
			},
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'collapse',
				keep_empty: true,
				header: 'Mass',
				hidden: false
			}
		],
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		export_order: [],
		export_row_number: null,
		...over
	} as TableDefinition;
}

describe('exportEntries', () => {
	it('defaults to definition order, all included', () => {
		expect(exportEntries(defn())).toEqual([
			{ index: 0, included: true },
			{ index: 1, included: true }
		]);
	});

	it('keeps an excluded entry in the list so the dialog can show it', () => {
		const d = defn();
		d.columns[1].hidden = true;
		expect(exportEntries(d)).toEqual([
			{ index: 0, included: true },
			{ index: 1, included: false }
		]);
	});

	it('lets a hidden column be opted back in', () => {
		const d = defn();
		d.columns[1].hidden = true;
		d.columns[1].export = { include: true, header: '' };
		expect(exportEntries(d)[1].included).toBe(true);
	});

	it('drops garbage and appends forgotten columns', () => {
		expect(exportEntries(defn({ export_order: [7, 1, 1] })).map((e) => e.index)).toEqual([1, 0]);
	});

	it('leads with the row-number entry when it is unlisted', () => {
		const e = exportEntries(defn({ show_row_numbers: true }));
		expect(e.map((x) => x.index)).toEqual([ROW_NUMBER_SLOT, 0, 1]);
	});

	it('omits the row-number entry when the grid flag is off', () => {
		const e = exportEntries(defn({ export_order: [ROW_NUMBER_SLOT, 0, 1] }));
		expect(e.map((x) => x.index)).toEqual([0, 1]);
	});

	it('marks an excluded row-number entry', () => {
		const e = exportEntries(
			defn({
				show_row_numbers: true,
				export_row_number: { include: false, header: '', key: '' }
			})
		);
		expect(e[0]).toEqual({ index: ROW_NUMBER_SLOT, included: false });
	});
});
```

Append to `frontend/src/lib/table/__tests__/columns.test.ts` (reuse that file's existing `defn()`-style fixture builder rather than adding a new one):

```ts
describe('export_order bookkeeping', () => {
	it('removeColumn drops the entry and shifts the ones above it', () => {
		const d = { ...base(), export_order: [2, 0, 1] };
		expect(removeColumn(d, 0).export_order).toEqual([1, 0]);
	});

	it('moveColumn remaps entries to the new definition indices', () => {
		const d = { ...base(), export_order: [2, 1, 0] };
		// definition column 0 moves to the end: old 0->2, old 1->0, old 2->1
		expect(moveColumn(d, 0, 2).export_order).toEqual([1, 0, 2]);
	});

	it('addColumn appends the new index when an order exists', () => {
		const d = { ...base(), export_order: [1, 0] };
		expect(addColumn(d, newPropertyColumn()).export_order).toEqual([1, 0, 2]);
	});

	it('leaves an empty order empty — that already means definition order', () => {
		expect(addColumn(base(), newPropertyColumn()).export_order).toEqual([]);
	});

	it('cloneColumn inserts the copy right after its original', () => {
		const d = { ...base(), export_order: [1, 0] };
		expect(cloneColumn(d, 0).export_order).toEqual([2, 0, 1]);
	});

	it('moveExportEntry writes a full order, materializing the natural one', () => {
		const d = { ...base(), show_row_numbers: true };
		// export list is [-1, 0, 1]; drag the row number to the end
		expect(moveExportEntry(d, 0, 2).export_order).toEqual([0, 1, -1]);
	});

	it('setColumnExportOptions merges into a column with no options yet', () => {
		const next = setColumnExportOptions(base(), 1, { include: false });
		expect(next.columns[1].export).toEqual({ include: false, header: '' });
	});

	it('setRowNumberExportOptions materializes the defaults', () => {
		expect(setRowNumberExportOptions(base(), { header: 'No.' }).export_row_number).toEqual({
			include: true,
			header: 'No.',
			key: ''
		});
	});
});
```

`base()` here is that file's two-column definition fixture — if it is named differently, use the existing name.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run frontend-test -- --run src/lib/table/__tests__/export-layout.test.ts src/lib/table/__tests__/columns.test.ts`
Expected: FAIL — `Failed to resolve import "../export-layout"`, and `moveExportEntry is not defined`.

- [ ] **Step 3: Add the zod schemas**

In `frontend/src/lib/api/types.ts`, after `JsonColumnOptionsSchema` (line 729):

```ts
/** Per-column export overrides. Mirrors core/table/schema.py's
 *  ColumnExportOptions. `include: null` means "follow `hidden`", which is what
 *  keeps every pre-existing table exporting unchanged. `header` renames the
 *  column for XLSX only — JSON renames through `json_export.key`. */
export const ColumnExportOptionsSchema = z.object({
	include: z.boolean().nullish(),
	header: z.string().default('')
});
export type ColumnExportOptions = z.infer<typeof ColumnExportOptionsSchema>;

/** Export overrides for the row-number pseudo-column. On the definition, not a
 *  column, because there is no Column to hang it off. Blank names fall back to
 *  "#" (xlsx) and "row_number" (JSON). */
export const RowNumberExportOptionsSchema = z.object({
	include: z.boolean().default(true),
	header: z.string().default(''),
	key: z.string().default('')
});
export type RowNumberExportOptions = z.infer<typeof RowNumberExportOptionsSchema>;
```

Add `export: ColumnExportOptionsSchema.nullish()` to **all four** of `ElementColumnSchema`, `PropertyColumnSchema`, `NavigationColumnSchema`, `ScriptColumnSchema`, immediately after their `json_export` line.

Add to `TableDefinitionSchema` after `show_row_numbers`:

```ts
	export_order: z.array(z.number().int()).default([]),
	export_row_number: RowNumberExportOptionsSchema.nullish()
```

- [ ] **Step 4: Write the layout mirror**

Create `frontend/src/lib/table/export-layout.ts`:

```ts
/**
 * Client mirror of `core/table/export_layout.py`'s normalizer.
 *
 * DISPLAY ONLY, exactly like `defaultJsonKeys`: the authoritative layout is
 * the backend's, and the JSON preview pane renders through the backend for
 * that reason. This exists because the export dialog must list the EXCLUDED
 * entries too — so the user can opt one back in — and the backend's own
 * `ExportLayout` has already dropped them.
 */
import type { TableDefinition } from '$lib/api/types';

/** `export_order`'s stand-in for the row-number pseudo-column, which has no
 *  definition index of its own. Mirrors the Python constant of the same name. */
export const ROW_NUMBER_SLOT = -1;

export interface ExportEntry {
	/** Definition column index, or `ROW_NUMBER_SLOT`. */
	index: number;
	included: boolean;
}

/** Whether the export contains this definition column. `include == null`
 *  follows `hidden` — the no-migration default. */
export function columnIncluded(defn: TableDefinition, index: number): boolean {
	const opts = defn.columns[index].export;
	if (!opts || opts.include == null) return !defn.columns[index].hidden;
	return opts.include;
}

/** Every export entry in output order, INCLUDED OR NOT. Drops out-of-range and
 *  duplicate `export_order` entries, drops the row-number slot when the grid
 *  flag is off, and appends any definition column the list forgot. */
export function exportEntries(defn: TableDefinition): ExportEntry[] {
	const n = defn.columns.length;
	const seen = new Set<number>();
	const order: number[] = [];
	for (const i of defn.export_order ?? []) {
		if (i === ROW_NUMBER_SLOT) {
			if (!defn.show_row_numbers || seen.has(i)) continue;
		} else if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) {
			continue;
		}
		seen.add(i);
		order.push(i);
	}
	if (defn.show_row_numbers && !seen.has(ROW_NUMBER_SLOT)) order.unshift(ROW_NUMBER_SLOT);
	for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);

	return order.map((index) => ({
		index,
		included:
			index === ROW_NUMBER_SLOT
				? (defn.export_row_number?.include ?? true)
				: columnIncluded(defn, index)
	}));
}
```

- [ ] **Step 5: Add the column helpers and the `export_order` bookkeeping**

In `frontend/src/lib/table/columns.ts`, add to the type import list: `ColumnExportOptions`, `RowNumberExportOptions`. Add `import { ROW_NUMBER_SLOT, exportEntries } from './export-layout';`.

Add near `DEFAULT_JSON_OPTIONS`:

```ts
const DEFAULT_EXPORT_OPTIONS: ColumnExportOptions = { include: null, header: '' };
const DEFAULT_ROW_NUMBER_OPTIONS: RowNumberExportOptions = {
	include: true,
	header: '',
	key: ''
};
```

Add this private helper next to `clone`:

```ts
/** `export_order` holds DEFINITION indices, so every structural column edit
 * has to move them — a stale list would silently reorder the export, which
 * the backend's normalizer cannot detect (its entries are all still in range).
 * An EMPTY order is left empty throughout: it already means "definition
 * order", which stays correct across every one of these edits. */
function remapExportOrder(order: number[], f: (i: number) => number | null): number[] {
	if (order.length === 0) return order;
	const out: number[] = [];
	for (const i of order) {
		if (i === ROW_NUMBER_SLOT) {
			out.push(i);
			continue;
		}
		const next = f(i);
		if (next !== null) out.push(next);
	}
	return out;
}
```

Wire it into the four mutators:

```ts
// addColumn — the appended column takes the next index
next.export_order = remapExportOrder(defn.export_order ?? [], (i) => i);
if (next.export_order.length) next.export_order = [...next.export_order, defn.columns.length];

// removeColumn — drop it, shift the ones above down
next.export_order = remapExportOrder(defn.export_order ?? [], (i) =>
	i === index ? null : i > index ? i - 1 : i
);

// cloneColumn — the copy lands at index + 1, so shift and then insert.
// `.slice()` because remapExportOrder returns its INPUT unchanged when empty,
// and the splice below must never reach the original definition's array.
{
	const shifted = remapExportOrder(
		defn.export_order ?? [],
		(i) => (i > index ? i + 1 : i)
	).slice();
	const at = shifted.indexOf(index);
	if (at >= 0) shifted.splice(at + 1, 0, index + 1);
	next.export_order = shifted;
}

// moveColumn — reuse the oldToNew map the function already builds
next.export_order = remapExportOrder(defn.export_order ?? [], (i) => oldToNew.get(i) ?? null);
```

Place each assignment on `next` before the function returns. In `moveColumn` it must come **after** `oldToNew` is built.

Add the three public helpers after `setColumnJsonOptions`:

```ts
/** Merge a patch into one column's export options, materializing the options
 *  object if the column had none. Pure — returns a new definition. */
export function setColumnExportOptions(
	defn: TableDefinition,
	index: number,
	patch: Partial<ColumnExportOptions>
): TableDefinition {
	const next = clone(defn);
	const current = defn.columns[index].export ?? DEFAULT_EXPORT_OPTIONS;
	next.columns[index] = { ...defn.columns[index], export: { ...current, ...patch } };
	return next;
}

/** Merge a patch into the row-number pseudo-column's export options. */
export function setRowNumberExportOptions(
	defn: TableDefinition,
	patch: Partial<RowNumberExportOptions>
): TableDefinition {
	const current = defn.export_row_number ?? DEFAULT_ROW_NUMBER_OPTIONS;
	return { ...clone(defn), export_row_number: { ...current, ...patch } };
}

/** Reorder the EXPORT list. `from`/`to` are positions in `exportEntries`, not
 *  definition indices — the export list has its own coordinate space, and the
 *  row-number entry has no definition index at all. Always writes a FULL
 *  order, materializing the natural one first, so the result no longer depends
 *  on the empty-means-natural fallback. */
export function moveExportEntry(
	defn: TableDefinition,
	from: number,
	to: number
): TableDefinition {
	const order = exportEntries(defn).map((e) => e.index);
	if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) {
		return clone(defn);
	}
	order.splice(to, 0, order.splice(from, 1)[0]);
	return { ...clone(defn), export_order: order };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pixi run frontend-test -- --run src/lib/table/__tests__/export-layout.test.ts src/lib/table/__tests__/columns.test.ts`
Expected: PASS

- [ ] **Step 7: Typecheck and commit**

```bash
pixi run frontend-check
git add frontend/src/lib/api/types.ts frontend/src/lib/table/export-layout.ts frontend/src/lib/table/columns.ts frontend/src/lib/table/__tests__/export-layout.test.ts frontend/src/lib/table/__tests__/columns.test.ts
git commit -m "feat(table): client export-layout mirror and export-order bookkeeping"
```

---

### Task 6: `createColumnDrag` accepts a custom validator

**Files:**
- Modify: `frontend/src/lib/table/column-dnd.svelte.ts:48-55, 216-228`
- Test: `frontend/src/lib/table/__tests__/column-dnd.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createColumnDrag(opts)` where `opts.getDefinition` is now **optional** and `opts.validate?: (from: number, to: number) => boolean` overrides the default `moveColumn`-based check.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/table/__tests__/column-dnd.test.ts`, following that file's existing pointer-event driving helpers:

```ts
it('uses a custom validator instead of moveColumn when given one', () => {
	// The export list reorders OUTPUT positions, which have none of
	// moveColumn's backward-reference constraints — and its entries include
	// the row-number slot, which has no definition column at all.
	const drops: Array<[number, number]> = [];
	const drag = createColumnDrag({
		attr: 'data-export-drop',
		axis: 'y',
		validate: () => true,
		onDrop: (from, to) => drops.push([from, to])
	});
	// drive a drag from slot 0 to slot 1 exactly as the existing tests do
	dragFromTo(drag, 0, 1);
	expect(drops).toEqual([[0, 1]]);
});
```

`dragFromTo` is whatever helper the existing tests in that file use to simulate the pointerdown/move/up sequence with the layoutless `elementFromPoint` stub — reuse it rather than writing a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pixi run frontend-test -- --run src/lib/table/__tests__/column-dnd.test.ts`
Expected: FAIL — TypeScript rejects the missing `getDefinition`, and at runtime `opts.getDefinition()` throws.

- [ ] **Step 3: Make the validator pluggable**

In `frontend/src/lib/table/column-dnd.svelte.ts`, change the options type:

```ts
export function createColumnDrag(opts: {
	attr: string;
	/** Drag axis: 'x' for the horizontal header strip, 'y' for the settings
	 * list. Defaults to 'x'. */
	axis?: 'x' | 'y';
	/** Only needed by the DEFAULT validator. */
	getDefinition?: () => TableDefinition | undefined;
	/** Whether a drop is offered. Defaults to "moveColumn would succeed",
	 * which is right for the two hosts that reorder DEFINITION columns
	 * (backward-only ColumnRef). The export list reorders OUTPUT positions,
	 * which carry no such constraint and include a slot with no definition
	 * column at all, so it supplies its own. */
	validate?: (from: number, to: number) => boolean;
	onDrop: (from: number, to: number) => void;
}): ColumnDragState {
```

Replace the validity block in `onPointerMove` (lines 216-228):

```ts
			if (over === null || from === over) {
				valid = false;
				computeOffsets();
				return;
			}
			if (opts.validate) {
				valid = opts.validate(from, over);
			} else {
				const defn = opts.getDefinition?.();
				if (!defn) {
					valid = false;
				} else {
					try {
						moveColumn(defn, from, over);
						valid = true;
					} catch {
						valid = false;
					}
				}
			}
			computeOffsets();
```

Update the function's doc comment to mention the `validate` escape hatch.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run frontend-test -- --run src/lib/table/__tests__/column-dnd.test.ts src/lib/components/Table/__tests__/ColumnManager.reorder.test.ts`
Expected: PASS — `ColumnManager` passes no `validate`, so it keeps the `moveColumn` check.

- [ ] **Step 5: Typecheck and commit**

```bash
pixi run frontend-check
git add frontend/src/lib/table/column-dnd.svelte.ts frontend/src/lib/table/__tests__/column-dnd.test.ts
git commit -m "refactor(table): column drag accepts a custom drop validator"
```

---

### Task 7: The export dialog

**Files:**
- Create: `frontend/src/lib/components/Table/ExportDialog.svelte`
- Create: `frontend/src/lib/components/Table/__tests__/ExportDialog.test.ts`
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (dropdown at 425-464; `settingsTab` at 180; the tab strip at 689-715; the confirm copy at 766)
- Delete: `frontend/src/lib/components/Table/JsonExportEditor.svelte`, `frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts`

**Interfaces:**
- Consumes: `exportEntries`, `ROW_NUMBER_SLOT` (Task 5); `setColumnExportOptions`, `setRowNumberExportOptions`, `moveExportEntry`, `setColumnJsonOptions`, `defaultJsonKeys`, `snakeCaseKey` (Task 5 + existing); `createColumnDrag({ validate })` (Task 6); `downloadTable`, `getTableDraft`, `getTableSort`, `updateTableDefinition` from `$lib/state`; `previewTableJson` from `$lib/api/tables`.
- Produces: `ExportDialog.svelte` with props `{ tabId: string; open: boolean; format: 'xlsx' | 'json'; onClose: () => void }` (`open` and `format` are `$bindable`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Table/__tests__/ExportDialog.test.ts`. Copy the deleted `JsonExportEditor.test.ts`'s preamble verbatim — its header comment, the `mount`/`flushSync`/`unmount` convention, the `EMPTY_PAGE` constant, the `defn()` fixture, and the `vi.spyOn(tablesApi, 'previewTableJson')` / `getTablePage` stubs — then replace its test bodies with these. Assertions go through `getTableDraft(TAB_ID)!.definition`, exactly as the old file did and for the same reason: the component imports from the `$lib/state` barrel, so spying on `table-editor.svelte.ts` would silently no-op.

```ts
const TAB_ID = 'tbl:draft:export-dialog-test';

async function open(format: 'xlsx' | 'json' = 'xlsx', over: Partial<TableDefinition> = {}) {
	await ensureTableDraft(TAB_ID);
	updateTableDefinition(TAB_ID, { ...defn(), ...over });
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(ExportDialog, {
		target,
		props: { tabId: TAB_ID, open: true, format, onClose: () => {} }
	});
	flushSync();
	return { target, component };
}

const current = () => getTableDraft(TAB_ID)!.definition;
const byTestId = (t: HTMLElement | Document, id: string) =>
	(t as HTMLElement).querySelector(`[data-testid="${id}"]`) as HTMLElement;

it('lists every column, grid-hidden ones included', async () => {
	const d = defn();
	d.columns[1].hidden = true;
	const { target } = await open('xlsx', d);
	expect(byTestId(document, 'export-name-0')).toBeTruthy();
	expect(byTestId(document, 'export-name-1')).toBeTruthy();
	unmount(target as never);
});

it('the eye toggle writes export.include and leaves hidden alone', async () => {
	await open('xlsx');
	byTestId(document, 'export-include-1').click();
	flushSync();
	expect(current().columns[1].export?.include).toBe(false);
	expect(current().columns[1].hidden).toBe(false);
});

it('renaming in xlsx mode writes export.header, not header', async () => {
	await open('xlsx');
	const input = byTestId(document, 'export-name-0') as HTMLInputElement;
	input.value = 'Assembly';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	expect(current().columns[0].export?.header).toBe('Assembly');
	expect(current().columns[0].header).toBe('Name');
});

it('renaming in json mode writes json_export.key, not export.header', async () => {
	await open('json');
	const input = byTestId(document, 'export-name-0') as HTMLInputElement;
	input.value = 'assembly';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	expect(current().columns[0].json_export?.key).toBe('assembly');
	expect(current().columns[0].export?.header ?? '').toBe('');
});

it('shows the row-number entry only when show_row_numbers is on', async () => {
	await open('xlsx');
	expect(document.body.textContent).not.toContain('Row number');
	updateTableDefinition(TAB_ID, { ...current(), show_row_numbers: true });
	flushSync();
	expect(document.body.textContent).toContain('Row number');
});

it('shows the json extras only in json mode', async () => {
	// column 1 of the fixture is an expand navigation column, so `group` is
	// honored there — that is the row the extras must appear on.
	await open('xlsx');
	expect(byTestId(document, 'json-group-1')).toBeNull();
	await open('json');
	expect(byTestId(document, 'json-group-1')).toBeTruthy();
	expect(byTestId(document, 'json-value-1')).toBeTruthy();
});

it('Cancel restores the definition captured when the dialog opened', async () => {
	await open('xlsx');
	const before = JSON.stringify(current());
	byTestId(document, 'export-include-1').click();
	flushSync();
	expect(JSON.stringify(current())).not.toBe(before);
	byTestId(document, 'export-cancel').click();
	flushSync();
	expect(JSON.stringify(current())).toBe(before);
});

it('Export downloads in the selected format', async () => {
	const spy = vi.spyOn(state, 'downloadTable').mockResolvedValue(undefined);
	await open('json');
	byTestId(document, 'export-confirm').click();
	flushSync();
	expect(spy).toHaveBeenCalledWith(TAB_ID, expect.objectContaining({ format: 'json' }));
});
```

For the last test, import the barrel as a namespace (`import * as state from '$lib/state';`) and have the component call `downloadTable` through that same barrel, so the spy intercepts it. If `mockResolvedValue` on a barrel re-export does not take under this project's vite config, fall back to asserting on `vi.spyOn(tablesApi, 'exportTable')` instead — that is the module `downloadTable` itself calls.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run frontend-test -- --run src/lib/components/Table/__tests__/ExportDialog.test.ts`
Expected: FAIL — `Failed to resolve import "../ExportDialog.svelte"`

- [ ] **Step 3: Write `ExportDialog.svelte`**

Create `frontend/src/lib/components/Table/ExportDialog.svelte`. Structure:

**Script.** Header comment first:

```
	// The export settings modal: one unified column list that adapts to the
	// selected format, plus (for JSON) the live sample.
	//
	// Everything here is an EXPORT OVERRIDE — it changes the file and never
	// the grid. Inclusion, order, and the row-number entry are shared across
	// formats; the rename is not (xlsx writes `export.header`, JSON writes
	// `json_export.key`), which is why the name input below is bound to two
	// different fields.
	//
	// No evaluation-suspension machinery (`suspendTableEvaluation` and
	// friends), unlike the Settings dialog: nothing in here affects
	// evaluation, so a mid-edit re-evaluation is harmless.
	//
	// The sample is fetched from `POST /tables/json-preview` rather than built
	// here on purpose: grouping is a non-trivial algorithm over the evaluator's
	// row keys, and a second implementation in TypeScript would drift from
	// `core/table/json_export.py` — the pane would then confidently show
	// something the download does not produce.
```

Then:

- Props: `let { tabId, open = $bindable(), format = $bindable(), onClose }: {...} = $props();`
- `const draft = $derived(getTableDraft(tabId)); const defn = $derived(draft?.definition);`
- `const entries = $derived(defn ? exportEntries(defn) : []);`
- `const keys = $derived(defn ? defaultJsonKeys(defn) : []);`
- A `$effect` that snapshots `defn` (via `$state.snapshot`) the first time `open` flips true, into a plain `let snapshot: TableDefinition | null`; cleared on close. `cancel()` calls `updateTableDefinition(tabId, snapshot)` when it is non-null, then `onClose()`.
- `patchExport(i, p)`, `patchJson(i, p)`, `patchRowNumber(p)` wrappers over the Task 5 helpers + `updateTableDefinition`.
- `toggleInclude(entry)` — for `ROW_NUMBER_SLOT` calls `setRowNumberExportOptions(defn, { include: !entry.included })`, otherwise `setColumnExportOptions(defn, entry.index, { include: !entry.included })`.
- `nameOf(entry)` / `setName(entry, v)` — switch on `format`.
- The drag: `createColumnDrag({ attr: 'data-export-drop', axis: 'y', validate: () => true, onDrop: (from, to) => updateTableDefinition(tabId, moveExportEntry(defn, from, to)) })`. **The `data-export-drop` attribute carries the export-list POSITION, not the definition index** — that is the coordinate space `moveExportEntry` takes.
- `snakeAll()` — copy the body from the deleted `JsonExportEditor.svelte:41-57` verbatim.
- The preview `$effect` — copy from `JsonExportEditor.svelte:68-91` verbatim, but gate it on `format === 'json'` so an xlsx export never fires a preview build.
- `runExport()` — `await downloadTable(tabId, { format })` inside try/finally, then `onClose()`.

**Markup.** A `Dialog.Root bind:open` / `Dialog.Content` (`data-testid="table-export-dialog"`) containing:

1. `Dialog.Title` — "Export table".
2. A format segmented control: two `aria-pressed` buttons, `data-testid="export-format-xlsx"` / `export-format-json`, styled like the Settings tab strip at `TableView.svelte:689-708`.
3. The column list — `{#each entries as entry, pos (entry.index)}` with `data-export-drop={pos}`, `style="transform:translateY({drag.offsetOf(pos)}px)"`, and per row:
   - a grip `span` (`data-testid="export-drag-{pos}"`) wired to the four pointer handlers, copied from `ColumnManager.svelte:266-277`;
   - the eye button (`data-testid="export-include-{pos}"`, `Eye`/`EyeOff` from `@lucide/svelte`, `aria-label` "Include in export"/"Exclude from export");
   - a label for the entry: `entry.index === ROW_NUMBER_SLOT ? 'Row number' : (defn.columns[entry.index].header || defn.columns[entry.index].kind)`;
   - the name input (`data-testid="export-name-{pos}"`) with `placeholder` = the grid header (xlsx) or `keys[entry.index]` (json);
   - `{#if format === 'json' && entry.index !== ROW_NUMBER_SLOT}` the item-key input (`json-item-key-{entry.index}`, only when grouped), the value `select` (`json-value-{entry.index}`, only when `producesElements`), and the group checkbox (`json-group-{entry.index}`, only when `canGroup`) — all three copied from `JsonExportEditor.svelte:141-187`, including `producesElements` and `canGroup`;
   - `class:opacity-50={!entry.included}` on the row.
4. `{#if format === 'json'}` the `snake_case all` button and the preview `<pre data-testid="json-preview">` block — copied from `JsonExportEditor.svelte:100-108` and `194-210`.
5. Footer: `Cancel` (`data-testid="export-cancel"`, calls `cancel()`) and `Export` (`data-testid="export-confirm"`, calls `runExport()`, disabled while an export is in flight).

- [ ] **Step 4: Wire it into `TableView.svelte`**

- Replace the `JsonExportEditor` import with `ExportDialog`.
- Add `let exportOpen = $state(false); let exportFormat = $state<'xlsx' | 'json'>('xlsx');`
- Change both dropdown items to open the dialog instead of downloading (keeping their existing `data-testid`s):

```svelte
						<DropdownMenu.Item
							data-testid="table-export-xlsx"
							onSelect={() => {
								exportFormat = 'xlsx';
								exportOpen = true;
							}}
						>
							Excel (.xlsx)
						</DropdownMenu.Item>
```

and the same for `table-export-json` with `'json'`.

- Render the dialog beside the settings dialog:

```svelte
	<ExportDialog
		{tabId}
		bind:open={exportOpen}
		bind:format={exportFormat}
		onClose={() => (exportOpen = false)}
	/>
```

- Keep `exportTable`, `exporting`, `exportProgress`, `exportAbort` and the trigger's spinner/progress text exactly as they are — the dialog calls `downloadTable` through the same store function, and the chrome button is still where progress is reported. `ExportDialog` calls `downloadTable` directly, so pass no callback.
- Delete `settingsTab`, the whole tab strip (`TableView.svelte:689-708`), and collapse the settings body to `<ColumnManager {tabId} focusIndex={settingsFocus} />`.
- Update the discard-confirmation copy at line 766: drop `, and JSON export settings` — those settings no longer live in that dialog.

- [ ] **Step 5: Delete the old editor**

```bash
git rm frontend/src/lib/components/Table/JsonExportEditor.svelte frontend/src/lib/components/Table/__tests__/JsonExportEditor.test.ts
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pixi run frontend-test`
Expected: PASS. `TableView.test.ts` will need updating if it asserts on `settings-tab-json` — search it for that id and for `table-export-xlsx` (the menu item now opens a dialog rather than downloading, so any test asserting an immediate `downloadTable` call must click through `export-confirm`).

- [ ] **Step 7: Full verification**

```bash
pixi run dr-test
pixi run frontend-check
pixi run dr-tidy
```
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add -A frontend/src/lib
git commit -m "feat(table): export settings dialog replaces the immediate download"
```

---

## Manual verification

After Task 7, with `pixi run backend-start` and `pixi run frontend-start`:

1. Open a table with at least one hidden column and one expand column.
2. `Export ▾` → **Excel**. The dialog lists every column, the hidden one dimmed with its eye off. Drag a column, rename one, opt the hidden one in, hit **Export**. Confirm the workbook matches.
3. Reopen, switch to **JSON** in place. The order and inclusion carry over; the name field now shows JSON keys; item-key/value/group appear; the preview reflects every change.
4. Turn on **Show row numbers** in Settings, reopen the export dialog: a "Row number" entry is in the list, first. Drag it to the middle, export both formats, confirm placement.
5. Change something, hit **Cancel**, reopen: the changes are gone.
6. Change something, hit **Export**, then **Save**: reopening the table keeps the settings.
