# Exporter v2 Phase 2 — Formats & Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CSV and JSONL export formats to both `POST /tables/export` and `POST /exports/run`, and `JsonDocumentOptions` (array-vs-keyed-object shape, pretty-vs-compact, error-cell policy) to exporter entries.

**Architecture:** The shared engine `api/table_export_engine.run_table_export` grows two format branches and one optional `json_doc` parameter; everything renderable stays in pure core modules (`core/table/csv_export.py` new, `core/table/json_export.py` extended, cell display text extracted from the xlsx writer into `core/table/cell_text.py` so xlsx and CSV cannot drift). The frontend widens its format enums and gives the entry-layout dialog the `json_doc` controls.

**Tech Stack:** Python 3.14 / FastAPI / pydantic v2 (backend), SvelteKit + Svelte 5 runes + zod (frontend), pixi for every command.

**Spec:** `docs/superpowers/specs/2026-08-19-custom-export-v2-design.md` §6 (formats), §7 (`JsonDocumentOptions`), §13 (error handling), §15 (testing). Phase list in §16 — this is Phase 2 of 5.

## Global Constraints

- Everything runs through pixi: `pixi run core-test`, `pixi run -e core-dev pytest <path> -v`, `pixi run frontend-test` (vitest, cwd=frontend), `pixi run frontend-check`, `pixi run dr-tidy` (format+lint+mypy+pyright — all must pass), `pixi run dr-test`.
- Work on branch `feat/exporter-v2-phase2` off `main`.
- **No-migration guarantee:** every artifact payload that validates today must validate unchanged and export byte-identically until a user opts into a new option. All new fields have defaults; `json_doc: None` behaves exactly like today's JSON export (array, `indent=2`).
- **Never block Save:** all new strictness (`key_column` out of range/missing, duplicate keys, `on_error: "fail"`) is a 422 at *export* time naming the offending entry. Nothing added here validates at artifact save/commit time.
- **RENDER ONLY boundary:** none of this touches evaluation — cell values, row order and script cache keys stay computed off the original definition. `json_doc` is presentation, passed as an engine parameter, never stored on `TableDefinition`.
- CSV is machine-consumer output: UTF-8, **no BOM**, stdlib `csv` `excel` dialect (RFC-4180 quoting, CRLF rows), no trailing notice row.
- JSONL: one compact object per line, `\n`-terminated, `ensure_ascii=False`. `json_doc.shape`/`pretty` are **ignored with tolerance** on jsonl; `on_error` applies. Split works for jsonl (same partition logic as json). CSV: **no split, no `json_doc`** (both tolerantly ignored, like `json_split` already is on xlsx).
- `json_doc` on an xlsx/csv entry is tolerated-and-ignored (spec §13 lists only `transform` — Phase 4 — as a format-mismatch 422).
- Docstring style: this codebase carries dense docstrings explaining *why* invariants exist. Match it.
- Python: modern 3.14 idioms (PEP 604 unions, no `typing.Optional`).

---

### Task 1: Extract cell display text into core (`cell_text`)

The spec (§6) requires CSV cell text to come from "a display-formatting helper **extracted from the xlsx writer** into core, so the two formats cannot drift". This task is that extraction — a pure move, byte-identical behavior.

**Files:**
- Create: `src/data_rover/core/table/cell_text.py`
- Modify: `src/data_rover/api/table_export.py` (delete `_display`/`_cell_text`, import the core function)
- Test: `tests/table/test_cell_text.py` (new)

**Interfaces:**
- Consumes: `core/table/cells.py` dataclasses, `core/model/naming.display_name`.
- Produces: `data_rover.core.table.cell_text.cell_text(model: Model, cell: Cell) -> object` — used by Task 2's CSV renderer and by `api/table_export.py`.

- [ ] **Step 1: Write the failing test**

Create `tests/table/test_cell_text.py`:

```python
"""Display-text rendering shared by the xlsx writer and the CSV renderer."""

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.table.cell_text import cell_text
from data_rover.core.table.cells import (
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)


def _model() -> tuple[Model, str]:
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="name", datatype="string")]
            )
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "Root")
    return model, el.id


def test_element_cell_renders_display_name():
    model, eid = _model()
    assert cell_text(model, ElementCell(element_id=eid)) == "Root"
    assert cell_text(model, ElementCell(element_id=None)) == ""


def test_value_cell_passes_native_values_and_blanks_absence():
    model, _ = _model()
    assert cell_text(model, ValueCell(present=True, value=12, element_id=None, editable=False)) == 12
    assert cell_text(model, ValueCell(present=True, value=0, element_id=None, editable=False)) == 0
    assert cell_text(model, ValueCell(present=False, value=None, element_id=None, editable=False)) == ""
    assert cell_text(model, ValueCell(present=True, value=None, element_id=None, editable=False)) == ""


def test_values_and_elements_cells_join_with_semicolons():
    model, eid = _model()
    assert cell_text(model, ValuesCell(present=True, values=[1, "a"], total=2, truncated=False)) == "1; a"
    assert cell_text(model, ElementsCell(element_ids=[eid, eid], total=2, truncated=False)) == "Root; Root"


def test_error_and_pending_cells_render_error_text():
    model, _ = _model()
    assert cell_text(model, ErrorCell(message="boom")) == "#ERROR: boom"
    assert cell_text(model, PendingCell()) == "#ERROR: not computed"
```

(Adjust `PendingCell()` construction if its dataclass has required fields — check `core/table/cells.py:103` and pass whatever defaults it needs.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run -e core-dev pytest tests/table/test_cell_text.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'data_rover.core.table.cell_text'`

- [ ] **Step 3: Create the core module and delegate the xlsx writer to it**

Create `src/data_rover/core/table/cell_text.py` by MOVING `_display` and `_cell_text` from `src/data_rover/api/table_export.py:65-86` verbatim (rename `_cell_text` → `cell_text`, keep `_display` private):

```python
"""Display-text rendering for exported cells, shared by the xlsx writer
(`api/table_export.py`) and the CSV renderer (`core/table/csv_export.py`) so
the two formats cannot drift (spec §6 of the Exporter v2 design). Moved
verbatim out of the xlsx writer — plain cell-to-text is core's business;
only the xlsx machinery around it needs the API layer.
"""

from __future__ import annotations

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import (
    Cell,
    ElementCell,
    ElementsCell,
    ErrorCell,
    PendingCell,
    ValueCell,
    ValuesCell,
)


def _display(model: Model, eid: str) -> str:
    # shared case-insensitive `name` lookup — same label the grid displays
    return display_name(model.elements[eid])


def cell_text(model: Model, cell: Cell) -> object:
    """Map one core cell dataclass to the display value it should render as."""
    if isinstance(cell, ElementCell):
        return _display(model, cell.element_id) if cell.element_id else ""
    if isinstance(cell, ValueCell):
        return "" if not cell.present or cell.value is None else cell.value
    if isinstance(cell, ValuesCell):
        return "; ".join(str(v) for v in cell.values)
    if isinstance(cell, ErrorCell):
        return f"#ERROR: {cell.message}"
    if isinstance(cell, PendingCell):
        # Only reachable when exporting after a FAILED sweep: a completed
        # sweep leaves no pending cells, so this path is a last-resort
        # rendering rather than an expected export outcome.
        return "#ERROR: not computed"
    assert isinstance(cell, ElementsCell)
    return "; ".join(_display(model, e) for e in cell.element_ids)
```

In `src/data_rover/api/table_export.py`: delete `_display` and `_cell_text` (and the now-unused cell dataclass imports), add `from data_rover.core.table.cell_text import cell_text`, and change the one call site (`_cell_text(model, next(cells))` in `build_workbook`) to `cell_text(model, next(cells))`.

- [ ] **Step 4: Run tests to verify they pass, plus the xlsx suite**

Run: `pixi run -e core-dev pytest tests/table/test_cell_text.py tests/api/test_table_export.py -v`
Expected: PASS (the xlsx tests prove the move changed nothing).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/cell_text.py src/data_rover/api/table_export.py tests/table/test_cell_text.py
git commit -m "refactor(core): extract cell display text from the xlsx writer into core/table/cell_text"
```

---

### Task 2: CSV renderer (`core/table/csv_export.py`)

**Files:**
- Create: `src/data_rover/core/table/csv_export.py`
- Test: `tests/table/test_csv_export.py` (new)

**Interfaces:**
- Consumes: Task 1's `cell_text(model, cell)`.
- Produces: `data_rover.core.table.csv_export.render_csv(model: Model, headers: list[str], row_iter: Iterable[list[Cell]], *, row_number_col: int | None = None) -> bytes` — called by Task 6's engine branch with exactly the arguments the xlsx branch passes `build_workbook` (pre-sliced rows, headers already carrying the row-number header).

- [ ] **Step 1: Write the failing tests**

Create `tests/table/test_csv_export.py`:

```python
"""CSV renderer: layout mirroring of the xlsx writer, RFC-4180 quoting,
error-cell text, and the row-number pseudo-column (spec §6)."""

import csv
import io

import pytest

from data_rover.core.metamodel.schema import ElementType, Metamodel, PropertyDef
from data_rover.core.model.model import Model
from data_rover.core.table.cells import ElementCell, ErrorCell, ValueCell
from data_rover.core.table.csv_export import render_csv


def _model() -> tuple[Model, str]:
    mm = Metamodel(
        elements=[
            ElementType(
                name="Block", properties=[PropertyDef(name="name", datatype="string")]
            )
        ]
    )
    model = Model(mm)
    el = model.create_element("Block")
    model.set_property(el, "name", "Root")
    return model, el.id


def _value(v: object) -> ValueCell:
    return ValueCell(present=True, value=v, element_id=None, editable=False)


def _parse(blob: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(blob.decode("utf-8"))))


def test_header_row_then_data_rows_utf8_no_bom():
    model, eid = _model()
    blob = render_csv(
        model,
        ["Block", "Mass"],
        [[ElementCell(element_id=eid), _value(12)]],
    )
    assert not blob.startswith(b"\xef\xbb\xbf")  # machine consumers: no BOM
    assert _parse(blob) == [["Block", "Mass"], ["Root", "12"]]


def test_rfc4180_quoting_of_commas_quotes_and_newlines():
    model, _ = _model()
    blob = render_csv(
        model,
        ["A", "B", "C"],
        [[_value('say "hi"'), _value("a,b"), _value("l1\nl2")]],
    )
    # csv.reader round-trips the quoting, proving it was correct
    assert _parse(blob) == [["A", "B", "C"], ['say "hi"', "a,b", "l1\nl2"]]
    # excel dialect terminates rows CRLF (RFC 4180)
    assert blob.endswith(b"\r\n")


def test_error_cells_render_error_text_like_xlsx():
    model, _ = _model()
    blob = render_csv(model, ["A"], [[ErrorCell(message="boom")]])
    assert _parse(blob)[1] == ["#ERROR: boom"]


def test_row_number_column_is_written_at_its_position():
    model, eid = _model()
    blob = render_csv(
        model,
        ["#", "Block"],
        [[ElementCell(element_id=eid)], [ElementCell(element_id=eid)]],
        row_number_col=0,
    )
    assert _parse(blob) == [["#", "Block"], ["1", "Root"], ["2", "Root"]]


def test_row_length_mismatch_and_bad_row_number_col_raise_value_error():
    model, _ = _model()
    with pytest.raises(ValueError):
        render_csv(model, ["A", "B"], [[_value(1)]])
    with pytest.raises(ValueError):
        render_csv(model, ["A"], [], row_number_col=5)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_csv_export.py -v`
Expected: FAIL with `ModuleNotFoundError` for `csv_export`.

- [ ] **Step 3: Implement the renderer**

Create `src/data_rover/core/table/csv_export.py`:

```python
"""CSV renderer for table export. Pure over (model, headers, rows) — the CSV
sibling of `api/table_export.py`'s xlsx writer, sharing its cell display text
through `core/table/cell_text.py` so the two formats cannot drift (spec §6).

Machine-consumer stance: UTF-8, NO BOM (Excel is what the xlsx format is
for), stdlib `excel` dialect (RFC-4180 quoting, CRLF row terminator). No
trailing notice row — to a CSV parser a notice would be one more data row;
degradation is signalled by `#ERROR:` cell text and the response headers.

Spec: docs/superpowers/specs/2026-08-19-custom-export-v2-design.md §6
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable

from data_rover.core.model.model import Model

from .cell_text import cell_text
from .cells import Cell


def render_csv(
    model: Model,
    headers: list[str],
    row_iter: Iterable[list[Cell]],
    *,
    row_number_col: int | None = None,
) -> bytes:
    """Mirror of `build_workbook`'s row contract, minus workbook chrome:
    `headers` already carries the row-number column's header when
    `row_number_col` is given, and each row from `row_iter` then carries one
    FEWER cell than `headers` has entries. Both a `row_number_col` outside
    `headers`' range and a row length mismatch raise `ValueError` — callers
    (`table_export_engine` via the routes) map it to a 422, exactly like the
    xlsx writer's identical checks."""
    if row_number_col is not None and not 0 <= row_number_col < len(headers):
        raise ValueError(
            f"row_number_col={row_number_col} is out of range for "
            f"{len(headers)} header(s)"
        )
    expected_len = len(headers) - (1 if row_number_col is not None else 0)
    buf = io.StringIO()
    writer = csv.writer(buf, dialect="excel")
    writer.writerow(headers)
    for r, row in enumerate(row_iter, start=1):
        if len(row) != expected_len:
            raise ValueError(
                f"row {r} has {len(row)} cell(s), expected {expected_len} "
                f"for {len(headers)} header(s) with row_number_col="
                f"{row_number_col!r}"
            )
        cells = iter(row)
        out: list[object] = []
        for col in range(len(headers)):
            out.append(r if col == row_number_col else cell_text(model, next(cells)))
        writer.writerow(out)
    return buf.getvalue().encode("utf-8")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pixi run -e core-dev pytest tests/table/test_csv_export.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/csv_export.py tests/table/test_csv_export.py
git commit -m "feat(core): CSV table-export renderer"
```

---

### Task 3: JSONL serializer + error-marker probe (`core/table/json_export.py`)

**Files:**
- Modify: `src/data_rover/core/table/json_export.py` (add `import json` and two functions)
- Test: `tests/table/test_json_export.py` (append)

**Interfaces:**
- Produces: `json_export.jsonl_bytes(docs: list[dict[str, object]]) -> bytes` and `json_export.contains_error_marker(value: object) -> bool` — both consumed by Task 6's engine.

- [ ] **Step 1: Write the failing tests** (append to `tests/table/test_json_export.py`; add `jsonl_bytes, contains_error_marker` to its `json_export` import block)

```python
# ---- JSONL serialization + on_error probe (Exporter v2 Phase 2) -----------


def test_jsonl_is_one_compact_object_per_line_newline_terminated():
    blob = jsonl_bytes([{"a": 1, "b": [1, 2]}, {"a": "é"}])
    assert blob == b'{"a":1,"b":[1,2]}\n' + '{"a":"é"}\n'.encode()


def test_jsonl_of_nothing_is_empty_bytes():
    assert jsonl_bytes([]) == b""


def test_error_marker_found_at_any_depth():
    assert contains_error_marker({"$error": "boom"})
    assert contains_error_marker({"a": [{"b": {"$error": "x"}}]})
    assert contains_error_marker([1, {"nested": [{"$error": "x"}]}])
    assert not contains_error_marker({"a": [1, "x", None, {"b": 2}]})
    assert not contains_error_marker("plain")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -k "jsonl or error_marker" -v`
Expected: FAIL with ImportError/NameError.

- [ ] **Step 3: Implement** (in `json_export.py`, after `render_cell`; add `import json` at the top)

```python
def jsonl_bytes(docs: list[dict[str, object]]) -> bytes:
    """One compact object per line, `\\n`-terminated (spec §6). A stream of
    objects is inherently compact and array-like, which is why
    `json_doc.shape`/`pretty` are ignored with tolerance for this format —
    only `on_error` (see `contains_error_marker`) applies."""
    return b"".join(
        json.dumps(d, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        + b"\n"
        for d in docs
    )


def contains_error_marker(value: object) -> bool:
    """True when a rendered document carries any `{"$error": ...}` marker at
    any depth — the `on_error: "fail"` probe (spec §7). Walks exactly the
    shapes `render_json` emits (dicts, lists, scalars). A user column whose
    resolved JSON key is literally `$error` would trip this too — accepted:
    strictness may over-fire on a pathological name, never under-fire."""
    if isinstance(value, dict):
        return "$error" in value or any(
            contains_error_marker(v) for v in value.values()
        )
    if isinstance(value, list):
        return any(contains_error_marker(v) for v in value)
    return False
```

- [ ] **Step 4: Run the module's whole test file**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -v`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/json_export.py tests/table/test_json_export.py
git commit -m "feat(core): JSONL serializer and \$error-marker probe for table export"
```

---

### Task 4: Document keys for object shape (`render_json_ex`)

The object shape (`{key: row_doc, ...}`) needs one string key per top-level document. Keys are read from the **cells** (not the rendered doc), so a hidden `key_column` works — "it is data, not presentation of the member list" (spec §7). To avoid duplicating `render_json`'s bucketing (grouping merges rows into one document), the key derivation lives inside a new `render_json_ex` that `render_json` delegates to.

**Files:**
- Modify: `src/data_rover/core/table/json_export.py`
- Test: `tests/table/test_json_export.py` (append)

**Interfaces:**
- Produces: `render_json_ex(model, defn, row_keys, row_iter, base_slots, *, order=None, row_number=None, key_column: int | None = None) -> tuple[list[dict[str, object]], list[str] | None]`. Second element is `None` unless `key_column` was given; then it is one string key per returned doc, positionally aligned. Raises `ValueError` on: `key_column` out of range; a key that renders `None`/`""`/non-scalar; a duplicate key. `render_json` keeps its exact signature and delegates.

- [ ] **Step 1: Write the failing tests** (append to `tests/table/test_json_export.py`; import `render_json_ex`; `pytest` is already imported there — if not, add it)

```python
# ---- Object-shape document keys (Exporter v2 Phase 2, spec §7) -------------


def _keys_doc(key_header_hidden: bool = False) -> dict:
    return {
        "row_source": {"kind": "scope", "types": ["Block"], "criteria": []},
        "columns": [
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "name",
                "header": "Name",
                "hidden": key_header_hidden,
            },
            {
                "kind": "property",
                "source": {"kind": "row"},
                "name": "mass",
                "header": "Mass",
            },
        ],
    }


def _render_ex(mm, model, doc, **kw):
    defn = TABLE_ADAPTER.validate_python(doc)
    build = build_rows_ex(mm, model, defn)
    return render_json_ex(
        model,
        defn,
        build.keys,
        iter_export_rows(mm, model, defn, build.keys),
        build.base_slots,
        **kw,
    )


def test_doc_keys_render_one_string_key_per_document():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs, keys = _render_ex(mm, model, _keys_doc(), key_column=0)
    assert keys == ["Root", "Part 1", "Part 2", "Lonely"]
    assert len(docs) == len(keys)


def test_doc_keys_work_for_a_hidden_key_column():
    # Hidden = evaluated but never emitted; the key reads the CELL, not the
    # rendered doc, so include/hidden state is irrelevant (spec §7).
    mm = _parts_mm()
    model = _parts_model(mm)
    docs, keys = _render_ex(mm, model, _keys_doc(key_header_hidden=True), key_column=0)
    assert keys == ["Root", "Part 1", "Part 2", "Lonely"]
    assert all("Name" not in d for d in docs)


def test_doc_keys_none_when_no_key_column_requested():
    mm = _parts_mm()
    model = _parts_model(mm)
    docs, keys = _render_ex(mm, model, _keys_doc())
    assert keys is None
    assert docs  # array path untouched


def test_doc_key_out_of_range_raises():
    mm = _parts_mm()
    model = _parts_model(mm)
    with pytest.raises(ValueError, match="key_column"):
        _render_ex(mm, model, _keys_doc(), key_column=9)


def test_doc_key_empty_value_raises():
    mm = _parts_mm()
    model = _parts_model(mm)
    # mass is unset on Root and Lonely -> renders null -> empty key
    with pytest.raises(ValueError, match="empty"):
        _render_ex(mm, model, _keys_doc(), key_column=1)


def test_doc_key_duplicates_raise():
    mm = _parts_mm()
    model = _parts_model(mm)
    dup = model.create_element("Block")
    model.set_property(dup, "name", "Root")  # second "Root"
    with pytest.raises(ValueError, match="duplicate"):
        _render_ex(mm, model, _keys_doc(), key_column=0)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_json_export.py -k "doc_key" -v`
Expected: FAIL with ImportError (`render_json_ex`).

- [ ] **Step 3: Implement**

In `json_export.py`, rename the existing `render_json` body into `render_json_ex` with the widened signature and return type; then re-add `render_json` as a thin delegate. The only new logic sits between bucket construction and the final list comprehension:

```python
def render_json_ex(
    model: Model,
    defn: TableDefinition,
    row_keys: list[RowKey],
    row_iter: Iterable[list[Cell]],
    base_slots: int,
    *,
    order: Sequence[int] | None = None,
    row_number: tuple[int, str] | None = None,
    key_column: int | None = None,
) -> tuple[list[dict[str, object]], list[str] | None]:
    """`render_json` plus optional per-document keys for the object shape
    (spec §7): with `key_column` given, the second element carries ONE string
    key per returned document, positionally aligned.

    The key is read from the bucket's FIRST row's CELL at `key_column` —
    never from the rendered doc — so a hidden key column works (it is data,
    not presentation of the member list). A plain key column is constant
    across a grouped bucket by the same argument `_render_level` makes for
    plain columns; a key column that VARIES within a bucket (it reads a
    grouped slot) contributes whatever the bucket's first row carried, and
    the duplicate-key guard is what keeps that honest.

    Strict by decision, all `ValueError` (the routes' 422 mapping):
    `key_column` out of range; a key rendering `None`/`""`/non-scalar (an
    error cell renders a dict and lands here too); a duplicate key —
    filenames dedupe, data keys never do (spec §7)."""
    # ... existing render_json body up to and including the `buckets` block ...

    doc_keys: list[str] | None = None
    if key_column is not None:
        if not 0 <= key_column < len(defn.columns):
            raise ValueError(
                f"json_doc.key_column {key_column} out of range "
                f"(table has {len(defn.columns)} columns)"
            )
        mode = _mode_of(defn.columns[key_column])
        doc_keys = []
        seen: set[str] = set()
        for b in buckets:
            rendered = render_cell(model, b[0][1][key_column], mode)
            if rendered is None or rendered == "" or not isinstance(
                rendered, str | int | float | bool
            ):
                raise ValueError(
                    "json_doc.key_column renders an empty or non-scalar key "
                    f"for document {len(doc_keys) + 1}"
                )
            key = str(rendered)
            if key in seen:
                raise ValueError(f"json_doc: duplicate document key {key!r}")
            seen.add(key)
            doc_keys.append(key)

    return (
        [  # ... existing final list comprehension, unchanged ...
        ],
        doc_keys,
    )


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
    """The whole table as a list of JSON objects. See `render_json_ex` for
    the object-shape key variant; everything else about the contract lives
    there now (this is a delegate kept for the many key-less call sites)."""
    docs, _ = render_json_ex(
        model, defn, row_keys, row_iter, base_slots,
        order=order, row_number=row_number,
    )
    return docs
```

Move the original `render_json` docstring content (bucketing, streaming, `order`, `row_number` semantics) onto `render_json_ex` — it describes the body, which now lives there.

- [ ] **Step 4: Run the full core suite**

Run: `pixi run -e core-dev pytest tests/table/ -v`
Expected: PASS — the delegate keeps every existing `render_json` caller and test green.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/json_export.py tests/table/test_json_export.py
git commit -m "feat(core): render_json_ex derives per-document keys for the object shape"
```

---

### Task 5: Schema widening — `ExportFormat`, `JsonDocumentOptions`, `json_doc`

**Files:**
- Modify: `src/data_rover/core/table/exporter.py`
- Modify: `src/data_rover/api/schemas.py:1325-1334` (`ExportTableIn`)
- Test: `tests/table/test_exporter.py` (append)

**Interfaces:**
- Produces: `data_rover.core.table.exporter.ExportFormat` (type alias `Literal["xlsx", "json", "csv", "jsonl"]`), `JsonDocumentOptions(shape, key_column, pretty, on_error)`, `ExporterEntry.format: ExportFormat`, `ExporterEntry.json_doc: JsonDocumentOptions | None`, `ExportTableIn.format: ExportFormat`. Consumed by Tasks 6–7.

- [ ] **Step 1: Write the failing tests** (append to `tests/table/test_exporter.py`; import `EXPORTER_ADAPTER, JsonDocumentOptions` — check the file's existing imports first)

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/table/test_exporter.py -v`
Expected: FAIL (ImportError for `JsonDocumentOptions`, and `csv` rejected by the 2-value Literal).

- [ ] **Step 3: Implement**

In `src/data_rover/core/table/exporter.py`:

```python
#: The four wire formats an export can ship as. One vocabulary for
#: `ExporterEntry.format` and the standalone route's `ExportTableIn.format`
#: (spec §6: extending both is nearly free — the engine branch is shared).
type ExportFormat = Literal["xlsx", "json", "csv", "jsonl"]


class JsonDocumentOptions(BaseModel):
    """Document shaping for the `json` branch (spec §7): applied after
    `render_json`, before serialization. Exporter-entry-only by decision —
    `TableDefinition` never grows this. On `jsonl`, `shape`/`pretty` are
    ignored with tolerance; `on_error` applies. On `xlsx`/`csv` the whole
    object is tolerated-and-ignored (presentation settings never block)."""

    shape: Literal["array", "object"] = "array"
    #: Definition column index whose rendered value keys each member when
    #: shape == "object". Strict at EXPORT time (missing/out-of-range/empty/
    #: duplicate -> 422 naming the entry); never blocks Save.
    key_column: int | None = None
    pretty: bool = True  # indent=2 vs compact separators
    #: "fail": any cell that would ship as {"$error": ...} turns the export
    #: into a 422 — a script consumer can demand a clean document or nothing.
    #: The default "emit" keeps the degraded-not-failed stance.
    on_error: Literal["emit", "fail"] = "emit"
```

On `ExporterEntry`: change `format: Literal["xlsx", "json"] = "xlsx"` to `format: ExportFormat = "xlsx"` and add `json_doc: JsonDocumentOptions | None = None` after `json_split`.

In `src/data_rover/api/schemas.py`: import `ExportFormat` from `data_rover.core.table.exporter` (extend the existing import if one exists, otherwise add it) and change `ExportTableIn.format` to `format: ExportFormat = "xlsx"`.

- [ ] **Step 4: Run the core + API schema tests**

Run: `pixi run -e core-dev pytest tests/table/test_exporter.py tests/api/test_exports_route.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/exporter.py src/data_rover/api/schemas.py tests/table/test_exporter.py
git commit -m "feat(api): widen export format to csv/jsonl and add JsonDocumentOptions"
```

---

### Task 6: Engine branches + standalone `/tables/export` CSV/JSONL

**Files:**
- Modify: `src/data_rover/api/table_export_engine.py`
- Modify: `src/data_rover/api/routes/tables.py:536-546` (media type by extension)
- Test: `tests/api/test_table_export_formats.py` (new)

**Interfaces:**
- Consumes: `render_csv` (Task 2), `jsonl_bytes`/`contains_error_marker` (Task 3), `render_json_ex` (Task 4), `JsonDocumentOptions`/`ExportFormat` (Task 5).
- Produces: `run_table_export(..., format: str, ..., json_doc: JsonDocumentOptions | None = None)` handling all four formats, and module constant `MEDIA_TYPES: dict[str, str]` mapping extension → content type — Task 7 replaces `routes/exports.py`'s private `_MEDIA_TYPES` with it.

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_table_export_formats.py`:

```python
"""POST /tables/export with format=csv / format=jsonl (Exporter v2 Phase 2).

The standalone route gets the new formats but NOT `json_doc` — document
shaping stays exporter-entry-only (spec §6)."""

import csv
import io
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


COLUMNS = [
    {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
    {"kind": "property", "source": {"kind": "row"}, "name": "mass", "header": "Mass"},
]


def _body(fmt, **defn_over):
    defn = {"row_source": {"kind": "scope", "types": ["Block"]}, "columns": COLUMNS}
    defn.update(defn_over)
    return {"definition": defn, "format": fmt}


def test_csv_export_ships_text_csv_with_header_row(client):
    _bootstrap_model(client)
    r = client.post(papi("/tables/export"), json=_body("csv"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"].endswith('.csv"')
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8"))))
    assert rows[0] == ["Block", "Mass"]
    assert len(rows) == 4  # header + root, p1, p2
    assert not r.content.startswith(b"\xef\xbb\xbf")


def test_csv_honors_row_numbers_and_export_layout(client):
    _bootstrap_model(client)
    r = client.post(
        papi("/tables/export"),
        json=_body("csv", show_row_numbers=True, export_order=[-1, 0, 1]),
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 200
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8"))))
    assert rows[1][0] == "1"  # row-number pseudo-column at slot 0


def test_jsonl_export_is_one_object_per_line(client):
    _bootstrap_model(client)
    r = client.post(papi("/tables/export"), json=_body("jsonl"), headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")
    assert r.headers["content-disposition"].endswith('.jsonl"')
    lines = r.content.decode("utf-8").splitlines()
    docs = [json.loads(ln) for ln in lines]
    assert len(docs) == 3
    assert set(docs[0]) == {"Block", "Mass"}
    assert b"\n  " not in r.content  # compact, never indented


def test_jsonl_split_zips_one_jsonl_per_base_element(client):
    import zipfile

    _bootstrap_model(client)
    body = _body(
        "jsonl",
        json_split={"enabled": True, "filename_template": "${name}"},
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert len(names) == 3
    assert all(n.endswith(".jsonl") for n in names)


def test_csv_ignores_json_split_with_tolerance(client):
    _bootstrap_model(client)
    body = _body(
        "csv",
        json_split={"enabled": True, "filename_template": "${name}"},
    )
    r = client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")  # single file, no zip
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_formats.py -v`
Expected: FAIL — csv/jsonl currently fall into the xlsx `else` branch (wrong content type).

- [ ] **Step 3: Implement the engine branches**

In `src/data_rover/api/table_export_engine.py`:

1. Imports: add `render_csv` (from `data_rover.core.table.csv_export`), `contains_error_marker, jsonl_bytes, render_json_ex` (replace the bare `render_json` import), `JsonDocumentOptions` (from `data_rover.core.table.exporter`).

2. Module constant, replacing nothing here yet (Task 7 rewires `exports.py`):

```python
#: Content type per shipped file extension. One map for the standalone
#: route's single-file response, `/exports/run`'s bare mode, and anything
#: else that needs to name a format's media type — extending a format means
#: extending THIS, once.
MEDIA_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "json": "application/json",
    "csv": "text/csv; charset=utf-8",
    "jsonl": "application/x-ndjson",
}
```

3. `run_table_export` signature: `format: str,  # "xlsx" | "json" | "csv" | "jsonl"` and a new keyword parameter `json_doc: JsonDocumentOptions | None = None` (document: entry-level document shaping, spec §7 — `None` for the standalone route and for xlsx/csv/legacy payloads; shape/pretty consulted on `json` only, `on_error` on `json` and `jsonl`).

4. Split gate becomes format-family-aware:

```python
    split = render_defn.json_split
    split_on = format in ("json", "jsonl") and split is not None and split.enabled
```

5. Replace the `if format == "json": ... else: (xlsx)` tail with a four-way branch. The JSON-family branch generalizes the existing json code:

```python
        if format in ("json", "jsonl"):
            eff = export_definition(render_defn)
            rn = (
                (layout.row_number_pos, layout.row_number_key)
                if layout.row_number_pos is not None
                else None
            )
            # Object-shape key column: json only (jsonl ignores shape with
            # tolerance, spec §6). Checked BEFORE rendering — the range half
            # is knowable now, and `render_json_ex` re-checks it anyway.
            key_col: int | None = None
            if format == "json" and json_doc is not None and json_doc.shape == "object":
                if json_doc.key_column is None:
                    raise ValueError(
                        f"{name}: json_doc.shape 'object' requires key_column"
                    )
                if not 0 <= json_doc.key_column < len(defn.columns):
                    raise ValueError(
                        f"{name}: json_doc.key_column {json_doc.key_column} out "
                        f"of range (table has {len(defn.columns)} columns)"
                    )
                key_col = json_doc.key_column

            def _check_on_error(docs: list[dict[str, object]]) -> None:
                # Spec §7: under "fail" a machine consumer gets a clean
                # document or nothing — scanned per FILE, after render,
                # before serialization. ValueError -> the routes' 422.
                if (
                    json_doc is not None
                    and json_doc.on_error == "fail"
                    and any(contains_error_marker(d) for d in docs)
                ):
                    raise ValueError(
                        f"{name}: export contains error cells and "
                        "json_doc.on_error is 'fail'"
                    )

            def _serialize(
                docs: list[dict[str, object]], doc_keys: list[str] | None
            ) -> bytes:
                if format == "jsonl":
                    return jsonl_bytes(docs)
                payload: object = (
                    dict(zip(doc_keys, docs, strict=True))
                    if doc_keys is not None
                    else docs
                )
                if json_doc is not None and not json_doc.pretty:
                    return json.dumps(
                        payload, ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")
                return json.dumps(payload, ensure_ascii=False, indent=2).encode(
                    "utf-8"
                )

            if split_on:
                assert split is not None  # split_on implies this
                parts = split_partitions(ordered, all_rows)
                labels = [partition_label(model, b) for b, _ in parts]
                stems = render_filenames(
                    split.filename_template, labels, extra=template_vars
                )
                files = []
                for stem, (_, pairs) in zip(stems, parts, strict=True):
                    part_docs, part_keys = render_json_ex(
                        model,
                        eff,
                        [rk for rk, _ in pairs],
                        (cells for _, cells in pairs),
                        build.base_slots,
                        order=layout.rank,
                        row_number=rn,
                        key_column=key_col,
                    )
                    _check_on_error(part_docs)
                    files.append((f"{stem}.{format}", _serialize(part_docs, part_keys)))
                return ExportFiles(
                    files=files,
                    truncated=truncated,
                    degraded=_degraded(),
                    archive=True,
                )
            docs, doc_keys = render_json_ex(
                model,
                eff,
                ordered,
                all_rows,
                build.base_slots,
                order=layout.rank,
                row_number=rn,
                key_column=key_col,
            )
            _check_on_error(docs)
            blob = _serialize(docs, doc_keys)
            filename = f"{name}.{format}"
        elif format == "csv":
            # Same layout slicing as the xlsx branch (headers already carry
            # the row-number header at its position); cell text shared via
            # core/table/cell_text so the two formats cannot drift (spec §6).
            # No split, no json_doc — both tolerantly ignored, like
            # json_split already is on xlsx.
            blob = render_csv(
                model,
                headers,
                ([row[i] for i in layout.order] for row in all_rows),
                row_number_col=layout.row_number_pos,
            )
            filename = f"{name}.csv"
        else:
            # ... existing xlsx branch, unchanged ...
```

Preserve the existing comments of the json branch (the `export_definition` rationale, the split-sits-above-the-renderer note) — move them onto the corresponding lines of the new code rather than deleting them. The existing docstring's `format` description ("xlsx" | "json") must be extended to name all four formats and the `json_doc` parameter.

Note `_check_on_error` also fires on the pre-shape docs for the object shape — same content, keys are additive.

6. In `src/data_rover/api/routes/tables.py`, replace the media-type if/else (lines ~540-546) with the shared map:

```python
        else:
            filename, blob = result.files[0]
            media_type = MEDIA_TYPES.get(
                filename.rpartition(".")[2], "application/octet-stream"
            )
```

Import `MEDIA_TYPES` from `..table_export_engine` (extend the existing import block at `routes/tables.py:72-78`).

- [ ] **Step 4: Run the new tests plus every existing export test**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_formats.py tests/api/test_table_export.py tests/api/test_table_export_json.py tests/api/test_table_export_split.py tests/api/test_exports_route.py -v`
Expected: PASS — existing xlsx/json/split behavior byte-identical.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/table_export_engine.py src/data_rover/api/routes/tables.py tests/api/test_table_export_formats.py
git commit -m "feat(api): csv/jsonl branches and json_doc shaping in the table-export engine"
```

---

### Task 7: `/exports/run` wiring — entry formats, `json_doc`, bare media types

**Files:**
- Modify: `src/data_rover/api/routes/exports.py`
- Test: `tests/api/test_exports_route.py` (append)

**Interfaces:**
- Consumes: Task 6's `run_table_export(json_doc=...)` and `MEDIA_TYPES`.
- Produces: `/exports/run` honoring `entry.format in {csv, jsonl}` and `entry.json_doc`; bare mode ships `text/csv; charset=utf-8` / `application/x-ndjson`.

- [ ] **Step 1: Write the failing tests** (append to `tests/api/test_exports_route.py`; reuse its `_mk_table`, `_mk_export`, `_run`, `_names` helpers and `_bootstrap_model`)

```python
# ---- Phase 2: csv/jsonl entries + json_doc --------------------------------


def test_csv_and_jsonl_entries_land_in_the_zip(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {"source": {"ref": t}, "name": "as-csv", "format": "csv"},
            {"source": {"ref": t}, "name": "as-jsonl", "format": "jsonl"},
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    assert sorted(_names(r)) == ["as-csv.csv", "as-jsonl.jsonl"]


def test_json_doc_object_shape_keys_documents_by_column(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "keyed",
                "format": "json",
                # column 0 is the element column -> display name keys
                "json_doc": {"shape": "object", "key_column": 0, "pretty": False},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    blob = zipfile.ZipFile(io.BytesIO(r.content)).read("keyed.json")
    doc = json.loads(blob)
    assert isinstance(doc, dict)
    assert set(doc) == {"root", "p1", "p2"}
    assert b"\n  " not in blob  # pretty=false -> compact


def test_json_doc_object_without_key_column_422s_naming_the_entry(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "broken",
                "format": "json",
                "json_doc": {"shape": "object"},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 422
    assert "broken" in r.json()["detail"]
    assert "key_column" in r.json()["detail"]


def test_json_doc_key_column_out_of_range_422s(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "broken",
                "format": "json",
                "json_doc": {"shape": "object", "key_column": 99},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 422
    assert "out of range" in r.json()["detail"]


def test_json_doc_on_xlsx_entry_is_tolerated_and_ignored(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "sheet",
                "format": "xlsx",
                "json_doc": {"shape": "object", "key_column": 99},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    assert _names(r) == ["sheet.xlsx"]


def test_bare_mode_ships_csv_and_jsonl_media_types(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    for fmt, ctype in [("csv", "text/csv"), ("jsonl", "application/x-ndjson")]:
        x = _mk_export(
            client,
            [{"source": {"ref": t}, "name": f"solo-{fmt}", "format": fmt}],
            name=f"bare-{fmt}",
            output={"mode": "bare"},
        )
        r = _run(client, x)
        assert r.status_code == 200
        assert r.headers["content-type"].startswith(ctype)
        assert r.headers["content-disposition"].endswith(f'solo-{fmt}.{fmt}"')


def test_jsonl_entry_split_files_nest_under_the_entry_folder(client):
    _bootstrap_model(client)
    t = _mk_table(client, "parts")
    x = _mk_export(
        client,
        [
            {
                "source": {"ref": t},
                "name": "per-el",
                "format": "jsonl",
                "json_split": {"enabled": True, "filename_template": "${name}"},
            }
        ],
    )
    r = _run(client, x)
    assert r.status_code == 200
    names = _names(r)
    assert all(n.startswith("per-el/") and n.endswith(".jsonl") for n in names)
    assert len(names) == 3
```

`on_error: "fail"` end-to-end needs an error cell, which this fixture model cannot produce cheaply — the core-level `contains_error_marker`/engine tests cover the policy; add a comment in the test file saying so rather than a contrived test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -k "csv or jsonl or json_doc" -v`
Expected: FAIL — `json_doc` is not forwarded to the engine yet, and jsonl split templates are not validated/gated.

- [ ] **Step 3: Implement**

In `src/data_rover/api/routes/exports.py`:

1. Delete the local `_MEDIA_TYPES` dict; import `MEDIA_TYPES` from `..table_export_engine` (extend the existing import) and use it in the bare-mode branch (`MEDIA_TYPES.get(ext, "application/octet-stream")`).
2. In the up-front validation pass, widen the split-template gate:

```python
            if entry.format in ("json", "jsonl") and split is not None and split.enabled:
```

3. In the run loop, pass the entry's shaping through:

```python
                    run_table_export(
                        ...
                        format=entry.format,
                        sort=None,
                        template_vars=ctx,
                        json_doc=entry.json_doc,
                    ),
```

(The engine tolerates `json_doc` on xlsx/csv by never consulting it outside the json/jsonl branch — nothing to gate here.)

- [ ] **Step 4: Run the exports suite**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -v`
Expected: PASS (all — including the pre-existing dedupe/folder/manifest/bare tests).

- [ ] **Step 5: Run the whole backend suite and commit**

Run: `pixi run core-test`
Expected: PASS.

```bash
git add src/data_rover/api/routes/exports.py tests/api/test_exports_route.py
git commit -m "feat(api): /exports/run honors csv/jsonl entry formats and json_doc"
```

---

### Task 8: Frontend types + API clients

**Files:**
- Modify: `frontend/src/lib/api/types.ts:983-994` (entry schema) and nearby
- Modify: `frontend/src/lib/api/tables.ts:59-90` (`exportTable`)
- Modify: `frontend/src/lib/state/table-editor.svelte.ts:1622-1633` (`downloadTable`)
- Test: `frontend/src/lib/table/__tests__/exporter.test.ts` (append)

**Interfaces:**
- Produces (in `$lib/api/types`): `EXPORT_FORMATS = ['xlsx', 'json', 'csv', 'jsonl'] as const`, `type ExportFormat`, `JsonDocumentOptionsSchema`/`type JsonDocumentOptions`, `ExporterEntrySchema.format: z.enum(EXPORT_FORMATS)`, `ExporterEntrySchema.json_doc: JsonDocumentOptionsSchema.nullish()`. Tasks 9–10 import `EXPORT_FORMATS`/`ExportFormat`/`JsonDocumentOptions`.

- [ ] **Step 1: Write the failing test** (append to `frontend/src/lib/table/__tests__/exporter.test.ts`, importing `ExporterEntrySchema` from `$lib/api/types`)

```ts
describe('phase 2 wire schema', () => {
	it('parses all four formats and json_doc, defaulting json_doc off', () => {
		for (const format of ['xlsx', 'json', 'csv', 'jsonl']) {
			const e = ExporterEntrySchema.parse({ source: { ref: 't1' }, format });
			expect(e.format).toBe(format);
		}
		const e = ExporterEntrySchema.parse({
			source: { ref: 't1' },
			format: 'json',
			json_doc: { shape: 'object', key_column: 1, pretty: false, on_error: 'fail' }
		});
		expect(e.json_doc).toEqual({
			shape: 'object',
			key_column: 1,
			pretty: false,
			on_error: 'fail'
		});
		expect(ExporterEntrySchema.parse({ source: { ref: 't1' } }).json_doc).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pixi run frontend-test -- src/lib/table/__tests__/exporter.test.ts`
Expected: FAIL (`csv` rejected by the 2-value enum). If the arg passthrough doesn't filter, run the full `pixi run frontend-test` and check this file's cases.

- [ ] **Step 3: Implement**

In `frontend/src/lib/api/types.ts`, just above `ExporterEntrySchema`:

```ts
/** The four wire formats an export can ship as — mirror of
 *  core/table/exporter.py::ExportFormat. */
export const EXPORT_FORMATS = ['xlsx', 'json', 'csv', 'jsonl'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Document shaping for JSON exports (spec §7) — exporter-entry-only.
 *  `shape`/`pretty` apply to `json`; `on_error` to `json` and `jsonl`;
 *  ignored elsewhere. All strictness (missing/out-of-range/duplicate keys,
 *  on_error 'fail') is a 422 from POST /exports/run — never validated
 *  client-side, never blocks Save. */
export const JsonDocumentOptionsSchema = z.object({
	shape: z.enum(['array', 'object']).default('array'),
	key_column: z.number().int().nullish(),
	pretty: z.boolean().default(true),
	on_error: z.enum(['emit', 'fail']).default('emit')
});
export type JsonDocumentOptions = z.infer<typeof JsonDocumentOptionsSchema>;
```

Then on `ExporterEntrySchema`: `format: z.enum(EXPORT_FORMATS).default('xlsx')` and add `json_doc: JsonDocumentOptionsSchema.nullish()` after `json_split`.

In `frontend/src/lib/api/tables.ts`: import `type ExportFormat` and change `format?: 'xlsx' | 'json'` to `format?: ExportFormat` (the doc comment saying ".xlsx or .json" should now say "in any `ExportFormat`").

In `frontend/src/lib/state/table-editor.svelte.ts` (`downloadTable`, line ~1625): same widening, `format?: ExportFormat`.

- [ ] **Step 4: Run frontend tests + typecheck**

Run: `pixi run frontend-test` then `pixi run frontend-check`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/tables.ts frontend/src/lib/state/table-editor.svelte.ts frontend/src/lib/table/__tests__/exporter.test.ts
git commit -m "feat(frontend): four-format wire schema and JsonDocumentOptions"
```

---

### Task 9: Standalone export UI — menu, dialog, settings panel

**Files:**
- Modify: `frontend/src/lib/components/Table/TableView.svelte` (`exportFormat` type, menu items, `exportTable` signature)
- Modify: `frontend/src/lib/components/Table/ExportDialog.svelte` (format toggle ×4, prop types, split gate)
- Modify: `frontend/src/lib/components/Export/ExportSettingsPanel.svelte` (json-family gating)
- Test: `frontend/src/lib/components/Table/__tests__/ExportDialog.test.ts` (append)

**Interfaces:**
- Consumes: `EXPORT_FORMATS`/`ExportFormat` from Task 8.
- Produces: `ExportSettingsPanel`'s `format` prop is `ExportFormat`; a `jsonFamily` derived replaces every `format === 'json'` gate in the panel (Task 10's dialog relies on this working for `'jsonl'`).

- [ ] **Step 1: Write the failing tests** (append to `ExportDialog.test.ts`, following its existing render/setup pattern — read the file's existing tests first and reuse their mount helper and store seeding verbatim)

Two cases:

```ts
it('offers all four formats and switches to CSV', async () => {
	// mount the dialog open on format 'xlsx' exactly like the existing tests
	// ...
	expect(screen.getByTestId('export-format-csv')).toBeInTheDocument();
	expect(screen.getByTestId('export-format-jsonl')).toBeInTheDocument();
	await fireEvent.click(screen.getByTestId('export-format-csv'));
	expect(screen.getByTestId('export-format-csv').getAttribute('aria-pressed')).toBe('true');
});

it('keeps the JSON-only sections for jsonl (json family)', async () => {
	// mount open, click the jsonl toggle
	// the split section / JSON preview markers the existing json-format tests
	// assert on must be present for jsonl too — reuse those exact queries
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- src/lib/components/Table/__tests__/ExportDialog.test.ts`
Expected: FAIL (`export-format-csv` not found).

- [ ] **Step 3: Implement**

`ExportDialog.svelte`:
- Import `EXPORT_FORMATS, type ExportFormat` from `$lib/api/types`.
- Prop types: `format: ExportFormat`, `onExport: (format: ExportFormat) => Promise<void>`.
- Replace the two hardcoded toggle buttons with an `{#each}`:

```svelte
{#each EXPORT_FORMATS as fmt (fmt)}
	<button
		type="button"
		data-testid="export-format-{fmt}"
		aria-pressed={format === fmt}
		class="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:text-foreground"
		onclick={() => (format = fmt)}
	>
		{FORMAT_LABELS[fmt]}
	</button>
{/each}
```

with `const FORMAT_LABELS: Record<ExportFormat, string> = { xlsx: 'Excel (.xlsx)', json: 'JSON (.json)', csv: 'CSV (.csv)', jsonl: 'JSON Lines (.jsonl)' };` in the script block. (Testids `export-format-xlsx`/`export-format-json` come out unchanged — existing tests keep passing.)
- `splitTemplateInvalid`: `format === 'json'` becomes `(format === 'json' || format === 'jsonl')`.

`ExportSettingsPanel.svelte`:
- Prop type: `format: ExportFormat` (import the type).
- Add `const jsonFamily = $derived(format === 'json' || format === 'jsonl');` and replace **every** `format === 'json'` / `format !== 'json'` check in the file (script and markup — there are ~10, found by grep) with `jsonFamily` / `!jsonFamily`. Rationale comment to add at the derived: JSONL renders through the same `render_json` document list, so JSON key naming, value modes, grouping, split and the preview all apply to it; CSV renders through the xlsx layout path, so it takes the xlsx-side behavior everywhere by falling into the `!jsonFamily` arm.

`TableView.svelte`:
- `exportFormat` state and `exportTable(format)` parameter: `ExportFormat`.
- Add two `DropdownMenu.Item`s after the JSON one, same shape, testids `table-export-csv` / `table-export-jsonl`, labels `CSV (.csv)` / `JSON Lines (.jsonl)`, setting `exportFormat = 'csv'` / `'jsonl'` and `exportOpen = true`.

- [ ] **Step 4: Run frontend tests + typecheck**

Run: `pixi run frontend-test` and `pixi run frontend-check`
Expected: PASS / 0 errors. (The full run matters here: TableView/panel tests exercise the widened props.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Table/TableView.svelte frontend/src/lib/components/Table/ExportDialog.svelte frontend/src/lib/components/Export/ExportSettingsPanel.svelte frontend/src/lib/components/Table/__tests__/ExportDialog.test.ts
git commit -m "feat(frontend): CSV/JSONL in the standalone table-export UI"
```

---

### Task 10: Exporter UI — entry-row formats + `json_doc` in the layout dialog

**Files:**
- Modify: `frontend/src/lib/components/Export/ExporterTab.svelte:360-381` (entry-row format buttons)
- Modify: `frontend/src/lib/components/Export/EntryLayoutDialog.svelte` (format toggle ×4, `json_doc` controls, save patch)
- Test: `frontend/src/lib/components/Export/__tests__/EntryLayoutDialog.test.ts` and `.../ExporterTab.test.ts` (append)

**Interfaces:**
- Consumes: `EXPORT_FORMATS`/`ExportFormat`/`JsonDocumentOptions` from Task 8; the panel's json-family behavior from Task 9.
- Produces: `EntryLayoutDialog`'s `onSave` patch now carries `json_doc` alongside `format` and the layout overrides.

- [ ] **Step 1: Write the failing tests**

Append to `EntryLayoutDialog.test.ts` (reuse its existing mount helper/props pattern — read the file first):

```ts
it('offers four formats and saves json_doc for the object shape', async () => {
	// mount with an entry of format 'json' as the existing tests do,
	// capturing onSave into a vi.fn()
	await fireEvent.click(screen.getByTestId('entry-layout-format-jsonl'));
	await fireEvent.click(screen.getByTestId('entry-layout-format-json'));
	await fireEvent.change(screen.getByTestId('entry-json-doc-shape'), {
		target: { value: 'object' }
	});
	await fireEvent.change(screen.getByTestId('entry-json-doc-key-column'), {
		target: { value: '0' }
	});
	await fireEvent.click(screen.getByTestId('entry-layout-save'));
	const patch = onSave.mock.calls[0][0];
	expect(patch.format).toBe('json');
	expect(patch.json_doc).toMatchObject({ shape: 'object', key_column: 0 });
});

it('shows only the on-error control for jsonl', async () => {
	// mount, switch to jsonl
	await fireEvent.click(screen.getByTestId('entry-layout-format-jsonl'));
	expect(screen.queryByTestId('entry-json-doc-shape')).toBeNull();
	expect(screen.getByTestId('entry-json-doc-on-error')).toBeInTheDocument();
});
```

Append to `ExporterTab.test.ts`: one test asserting an entry row renders `export-entry-0-format-csv` and `export-entry-0-format-jsonl` buttons and that clicking csv updates the staged entry (follow the file's existing format-toggle test if one exists, otherwise its update-entry pattern).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run frontend-test -- src/lib/components/Export/__tests__`
Expected: FAIL (missing testids).

- [ ] **Step 3: Implement**

`ExporterTab.svelte`: replace the two entry-row format buttons with an `{#each EXPORT_FORMATS as fmt (fmt)}` loop producing the same button markup with `data-testid="export-entry-{i}-format-{fmt}"`, label `{fmt}`, `aria-pressed={entry.format === fmt}`, `onclick={() => updateExporterEntry(tabId, i, { format: fmt })}`. Import `EXPORT_FORMATS` from `$lib/api/types`.

`EntryLayoutDialog.svelte`:
- Format toggle: same `{#each EXPORT_FORMATS}` treatment as Task 9's dialog, testids `entry-layout-format-{fmt}` (existing two ids unchanged), labels from the same `FORMAT_LABELS` map (duplicate the small const — it's four strings; a shared module is not worth the coupling).
- `format` state: `$state<ExportFormat>(...)`; `splitTemplateInvalid` gate widened to the json family (same as Task 9).
- `json_doc` state + patch helper:

```ts
let jsonDoc = $state<JsonDocumentOptions | null>(untrack(() => entry.json_doc ?? null));

const JSON_DOC_DEFAULTS: JsonDocumentOptions = {
	shape: 'array',
	key_column: null,
	pretty: true,
	on_error: 'emit'
};
function patchDoc(p: Partial<JsonDocumentOptions>): void {
	jsonDoc = { ...JSON_DOC_DEFAULTS, ...jsonDoc, ...p };
}
```

- Save: `onSave({ format, json_doc: jsonDoc, ...overridesFromDefinition(effective) });`
- Markup, inserted between the format toggle row and the panel, gated `{#if format === 'json' || format === 'jsonl'}`:

```svelte
<div class="flex shrink-0 flex-wrap items-center gap-3 text-xs" data-testid="entry-json-doc">
	{#if format === 'json'}
		<label class="flex items-center gap-1">
			Document
			<select
				data-testid="entry-json-doc-shape"
				class="rounded border border-input bg-card px-1.5 py-0.5"
				value={jsonDoc?.shape ?? 'array'}
				onchange={(e) => patchDoc({ shape: e.currentTarget.value as 'array' | 'object' })}
			>
				<option value="array">Array</option>
				<option value="object">Keyed object</option>
			</select>
		</label>
		{#if (jsonDoc?.shape ?? 'array') === 'object'}
			<label class="flex items-center gap-1">
				Key column
				<select
					data-testid="entry-json-doc-key-column"
					class="rounded border border-input bg-card px-1.5 py-0.5"
					value={jsonDoc?.key_column ?? ''}
					onchange={(e) =>
						patchDoc({
							key_column: e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
						})}
				>
					<option value="">— pick a column —</option>
					{#each tableDefinition.columns as col, ci (ci)}
						<option value={ci}>{col.header || `${col.kind} ${ci}`}</option>
					{/each}
				</select>
			</label>
		{/if}
		<label class="flex items-center gap-1">
			<input
				type="checkbox"
				data-testid="entry-json-doc-pretty"
				checked={jsonDoc?.pretty ?? true}
				onchange={(e) => patchDoc({ pretty: e.currentTarget.checked })}
			/>
			Pretty-print
		</label>
	{/if}
	<label class="flex items-center gap-1">
		On error cells
		<select
			data-testid="entry-json-doc-on-error"
			class="rounded border border-input bg-card px-1.5 py-0.5"
			value={jsonDoc?.on_error ?? 'emit'}
			onchange={(e) => patchDoc({ on_error: e.currentTarget.value as 'emit' | 'fail' })}
		>
			<option value="emit">Emit markers</option>
			<option value="fail">Fail the export</option>
		</select>
	</label>
	{#if (jsonDoc?.shape ?? 'array') === 'object' && jsonDoc?.key_column == null}
		<span class="text-muted-foreground/70">object shape needs a key column (checked at export)</span>
	{/if}
</div>
```

Deliberately no Save gating on a missing key column — never block Save (spec §13); the hint plus the export-time 422 is the contract. Note in a component comment that the JSON preview panel still shows the ARRAY shape — `POST /tables/json-preview` predates shaping and previewing the object shape is out of Phase 2's scope.

- [ ] **Step 4: Run frontend suite + typecheck + lint**

Run: `pixi run frontend-test`, `pixi run frontend-check`, `pixi run frontend-lint`
Expected: PASS / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Export/ExporterTab.svelte frontend/src/lib/components/Export/EntryLayoutDialog.svelte frontend/src/lib/components/Export/__tests__
git commit -m "feat(frontend): entry-level csv/jsonl formats and json_doc controls"
```

---

### Task 11: Docs, backlog, full verification

**Files:**
- Modify: `CLAUDE.md` (the "**Table export formats**" bullet: formats are now `"xlsx" | "json" | "csv" | "jsonl"`; add one sentence for `JsonDocumentOptions` — entry-level shape/pretty/on_error, applied render→shape→serialize in the shared engine — and one for the `cell_text` extraction)
- Modify: `frontend/README.md` (the export/exporter sections: four formats, the entry dialog's json_doc controls, the panel's json-family rule)
- Modify: `BACKLOG.md` (changelog note: Exporter v2 Phase 2 shipped — CSV, JSONL, JsonDocumentOptions; Phases 3–5 remain)

**Interfaces:** none — documentation only, but part of the phase's definition of done (the repo's docs are load-bearing).

- [ ] **Step 1: Update the three documents** as described above. Keep each edit surgical — extend the existing sentences, do not restructure sections.

- [ ] **Step 2: Full verification sweep**

Run, in order:
- `pixi run dr-tidy` — format + lint + mypy + pyright, all three type/lint gates must pass
- `pixi run dr-test` — core pytest + frontend vitest
- `pixi run frontend-check` — svelte-check

Expected: everything green. Fix anything that isn't before committing.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md frontend/README.md BACKLOG.md
git commit -m "docs: exporter v2 phase 2 (csv/jsonl formats, json_doc shaping)"
```

- [ ] **Step 4: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill (verify tests → present merge options for `feat/exporter-v2-phase2` → base `main`).

---

## Self-review notes (already applied)

- **Spec coverage:** §6 CSV → Tasks 1, 2, 6; §6 JSONL → Tasks 3, 6; §7 shaping → Tasks 4, 5, 6, 7; both-routes requirement → Tasks 6 (standalone) and 7 (exporter); §11 frontend (format selects, `json_doc` dialog controls) → Tasks 8–10; §13 error rows for `key_column`/`on_error` → Tasks 6, 7; §15 test list (csv layout/quoting/error cells, jsonl + split, object shape/duplicate-key/compact) → Tasks 2, 3, 4, 6, 7. Out of scope by spec: `transform` (Phase 4), draft runs/run-by-name/picker (Phase 3), `json_doc` on `TableDefinition` (never).
- **Deliberate interpretations** (flag to the reviewer, both argued from spec text): (1) `json_doc` shaping applies **per split file** — §8's transform is defined "once per file" and shaping sits immediately before it in the pipeline; (2) `json_doc` on xlsx/csv is tolerated-ignored because §13 lists only `transform` as the format-mismatch 422.
- **Type consistency:** `cell_text(model, cell)` (T1) used by T2/T6; `render_csv(model, headers, row_iter, *, row_number_col)` (T2) used by T6; `jsonl_bytes`/`contains_error_marker` (T3) and `render_json_ex(..., key_column)` (T4) used by T6; `ExportFormat`/`JsonDocumentOptions` (T5) used by T6–T10; `MEDIA_TYPES` (T6) used by T7; `EXPORT_FORMATS` (T8) used by T9–T10.
