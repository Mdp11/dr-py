# Per-element JSON split (P-13) + custom export artefact (P-14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A table's JSON export can split into one zip'd file per base element with a `${name}` filename template, and a new `custom_export` artifact kind bundles many tables' exports — each with its own full presentation override — into one zip via `POST /exports/run`.

**Architecture:** The dense body of `routes/tables.py::export_table` is extracted into a reusable engine (`api/table_export_engine.py`) returning `ExportPending | ExportFiles`; both `/tables/export` and the new `/exports/run` route call it. Split partitioning and the filename policy are pure core modules; the P-14 payload applies presentation-only overrides to a copy of the table definition used strictly for RENDER (evaluation keeps the original definition — same boundary as `export_definition`).

**Tech Stack:** Python 3.14 / FastAPI / pydantic v2 / SQLAlchemy 2 / Alembic (backend); SvelteKit + Svelte 5 runes / zod / vitest (frontend); stdlib `zipfile`.

**Spec:** `docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md` — read it first; it records every product decision (zip delivery, strict template, array-shaped files, full override sets, tables-only scope).

## Global Constraints

- Everything runs through pixi: `pixi run -e core-dev pytest …`, `pixi run frontend-test`, `pixi run dr-tidy`. There is no global `python`/`node`.
- **RENDER ONLY invariant** (spec §3.4): `build_rows_ex` / `order_rows` / `iter_export_rows` / the script context always receive the ORIGINAL `TableDefinition`. Presentation-modified copies feed only `export_layout` / `export_header` / `export_definition` / `render_json`.
- Export presentation must never change cell values, row order, or script cache keys.
- The 202-vs-ship decision-table comments in `export_table` (FIX A / FIX B) are load-bearing — move them verbatim, never paraphrase.
- New wire fields are additive; every existing table/export payload must keep validating and exporting byte-identically.
- `docs/superpowers/` is gitignored — never `git add` the spec or this plan.
- Commit messages: imperative, `feat(api):` / `feat(frontend):` / `refactor:` style, referencing P-13/P-14.
- All three linters must stay clean: `pixi run dr-tidy` (ruff + mypy + pyright + frontend).

---

### Task 1: `JsonSplitOptions` on `TableDefinition`

**Files:**
- Modify: `src/data_rover/core/table/schema.py` (after `RowNumberExportOptions`, ~line 168; field on `TableDefinition` after `export_row_number`, ~line 278)
- Test: `tests/table/test_schema.py` (append)

**Interfaces:**
- Produces: `class JsonSplitOptions(BaseModel)` with `enabled: bool = False`, `filename_template: str = ""`; `TableDefinition.json_split: JsonSplitOptions | None = None`. Tasks 2–5, 9 consume these exact names.

- [ ] **Step 1: Write the failing test** (append to `tests/table/test_schema.py`; match its existing import style — it imports from `data_rover.core.table.schema`)

```python
def test_json_split_defaults_to_none_and_roundtrips():
    from data_rover.core.table.schema import TABLE_ADAPTER, JsonSplitOptions

    doc = {
        "row_source": {"kind": "scope", "types": ["Block"]},
        "columns": [{"kind": "element", "source": {"kind": "row"}}],
    }
    assert TABLE_ADAPTER.validate_python(doc).json_split is None  # old payloads
    doc["json_split"] = {"enabled": True, "filename_template": "DataFor${name}"}
    defn = TABLE_ADAPTER.validate_python(doc)
    assert defn.json_split == JsonSplitOptions(
        enabled=True, filename_template="DataFor${name}"
    )
    dumped = defn.model_dump()
    assert dumped["json_split"] == {
        "enabled": True,
        "filename_template": "DataFor${name}",
    }


def test_json_split_accepts_any_template_at_schema_level():
    # Strictness is EXPORT-time (spec §3.1): a stored bad template must not
    # 422 unrelated saves/evaluates of the table.
    from data_rover.core.table.schema import JsonSplitOptions

    assert JsonSplitOptions(enabled=True, filename_template="no-token").enabled
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_schema.py -k json_split -v`
Expected: FAIL — `ImportError: cannot import name 'JsonSplitOptions'`

- [ ] **Step 3: Implement**

In `schema.py`, after `RowNumberExportOptions`:

```python
class JsonSplitOptions(BaseModel):
    """Split the JSON export into one file per base element (spec:
    docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md).

    Presentation-only, like `export_order`: never consulted during evaluation.
    `filename_template` must contain `${name}` — enforced at EXPORT time
    (`core/table/split.validate_template`), deliberately not here, so a stored
    bad template cannot block saving or evaluating the table."""

    enabled: bool = False
    #: `${name}` is replaced by each base element's display name.
    filename_template: str = ""
```

On `TableDefinition`, after `export_row_number`:

```python
    #: JSON-export split settings; `None` = single-document export (today's
    #: behavior, and the no-migration guarantee for existing payloads).
    json_split: JsonSplitOptions | None = None
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/table/test_schema.py -v`
Expected: all PASS (new + pre-existing)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/schema.py tests/table/test_schema.py
git commit -m "feat(core): json_split presentation field on TableDefinition (P-13)"
```

---

### Task 2: `core/table/split.py` — partitioning + filename policy

**Files:**
- Create: `src/data_rover/core/table/split.py`
- Test: `tests/table/test_split.py` (new)

**Interfaces:**
- Consumes: `RowKey`/`Binding` from `core/table/evaluate.py`, `Cell` from `core/table/cells.py`, `display_name` from `core/model/naming.py`.
- Produces (Tasks 5, 9 consume): `SPLIT_TOKEN = "${name}"`, `validate_template(template: str) -> None` (raises `ValueError`), `split_partitions(row_keys, row_iter) -> list[tuple[Binding, list[tuple[RowKey, list[Cell]]]]]`, `partition_label(model, binding) -> tuple[str, str]` (`(fallback_id, name)`), `render_filenames(template, items: list[tuple[str, str]]) -> list[str]` (stems, no extension).

- [ ] **Step 1: Write the failing tests** (`tests/table/test_split.py`)

```python
"""Split-export partitioning and the filename policy (spec §3.2).

Partitioning is pure slot-0 bucketing, so hand-rolled RowKey/Cell pairs are
fine here (unlike grouping, which needs real evaluator rows)."""

import pytest

from data_rover.core.table.cells import ValueCell
from data_rover.core.table.split import (
    SPLIT_TOKEN,
    render_filenames,
    split_partitions,
    validate_template,
)


def _cell(v):
    return [ValueCell(present=True, value=v)]


def test_partitions_bucket_by_slot0_preserving_first_appearance_order():
    keys = [("a",), ("b",), ("a",), ("c",), ("b",)]
    rows = [_cell(i) for i in range(5)]
    parts = split_partitions(keys, iter(rows))
    assert [b for b, _ in parts] == ["a", "b", "c"]
    a_pairs = parts[0][1]
    assert [rk for rk, _ in a_pairs] == [("a",), ("a",)]
    assert a_pairs[0][1] is rows[0] and a_pairs[1][1] is rows[2]


def test_validate_template_requires_the_token():
    validate_template("DataFor${name}Element")  # no raise
    with pytest.raises(ValueError, match=r"\$\{name\}"):
        validate_template("export")


def test_filenames_substitute_sanitize_and_dedupe_in_order():
    items = [("e1", "pump"), ("e2", "pump"), ("e3", "a/b:c")]
    assert render_filenames("DataFor${name}", items) == [
        "DataForpump",
        "DataForpump_2",
        "DataFora_b_c",
    ]


def test_filename_suffix_survives_a_literal_pre_collision():
    items = [("e1", "a"), ("e2", "a_2"), ("e3", "a")]
    # "a" then literal "a_2"; third "a" must skip PAST the taken "a_2".
    assert render_filenames("${name}", items) == ["a", "a_2", "a_3"]


def test_empty_render_falls_back_to_the_id_then_to_element():
    assert render_filenames("${name}", [("e-42", "")]) == ["e-42"]
    assert render_filenames("${name}", [("", "")]) == ["element"]


def test_render_filenames_rejects_a_tokenless_template():
    with pytest.raises(ValueError):
        render_filenames("static", [("e1", "x")])
```

Check `ValueCell`'s constructor in `src/data_rover/core/table/cells.py` before running — if its fields differ from `(present, value)`, adjust `_cell` to match (the cells are payload-opaque to the partitioner; any `Cell` works).

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_split.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'data_rover.core.table.split'`

- [ ] **Step 3: Implement** (`src/data_rover/core/table/split.py`)

```python
"""Per-base-element partitioning and the filename policy for split JSON export.

Pure over (row keys, cells), like `json_export.py` — the renderer stays
per-document; this module sits ABOVE it and decides which rows land in which
file and what that file is called.

Spec: docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md
"""

from __future__ import annotations

from collections.abc import Iterable

from data_rover.core.model.model import Model
from data_rover.core.model.naming import display_name

from .cells import Cell
from .evaluate import Binding, RowKey

SPLIT_TOKEN = "${name}"
#: Sanitized-stem length cap. Well under every filesystem's 255-byte limit
#: even after the `.json` extension and a `_NN` dedupe suffix.
MAX_FILENAME_LEN = 120
_UNSAFE = set('/\\:*?"<>|')

_Pair = tuple[RowKey, list[Cell]]


def validate_template(template: str) -> None:
    """`ValueError` when `${name}` is absent — the routes map `ValueError` to
    422, and the frontend dialog mirrors this predicate (spec decision:
    reject, don't normalize — the ONE strict export setting)."""
    if SPLIT_TOKEN not in template:
        raise ValueError(f"filename template must contain {SPLIT_TOKEN}")


def split_partitions(
    row_keys: list[RowKey], row_iter: Iterable[list[Cell]]
) -> list[tuple[Binding, list[_Pair]]]:
    """The rows bucketed by RowKey slot 0 (the base element for scope/nav
    sources, the chain origin for chains), in first-appearance order so the
    requested sort survives. Materializes — same trade as `render_json`."""
    parts: dict[Binding, list[_Pair]] = {}
    for rk, cells in zip(row_keys, row_iter, strict=True):
        parts.setdefault(rk[0], []).append((rk, cells))
    return list(parts.items())


def partition_label(model: Model, binding: Binding) -> tuple[str, str]:
    """`(fallback_id, name)` for one partition's slot-0 binding. A dangling id
    (element deleted between evaluation and render) degrades to the id itself
    — same tolerance as `json_export._element_json`."""
    if isinstance(binding, str):
        el = model.elements.get(binding)
        return (binding, display_name(el)) if el is not None else (binding, binding)
    return str(binding), str(binding)


def _sanitize(name: str) -> str:
    cleaned = "".join(
        "_" if ch in _UNSAFE or ord(ch) < 32 else ch for ch in name
    )
    return cleaned.strip()[:MAX_FILENAME_LEN].strip()


def render_filenames(template: str, items: list[tuple[str, str]]) -> list[str]:
    """One filename STEM per `(fallback_id, name)` item, deduplicated `_2`,
    `_3`, ... in row order. The extension is appended by the CALLER after
    dedup, so `a` and a literal `a_2` can never merge. Loop (not a single
    suffix) for the same reason `resolve_json_keys` loops: a produced `_2`
    can collide with a literal name."""
    validate_template(template)
    taken: set[str] = set()
    out: list[str] = []
    for fallback, name in items:
        base = (
            _sanitize(template.replace(SPLIT_TOKEN, name))
            or _sanitize(fallback)
            or "element"
        )
        candidate, n = base, 2
        while candidate in taken:
            candidate = f"{base}_{n}"
            n += 1
        taken.add(candidate)
        out.append(candidate)
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/table/test_split.py -v`
Expected: all PASS. (`partition_label`'s element-name path is pinned by the API zip test in Task 5 — it needs a real model.)

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/split.py tests/table/test_split.py
git commit -m "feat(core): split partitioning + filename policy for per-element export (P-13)"
```

---

### Task 3: `core/table/custom_export.py` — P-14 payload + `overridden_table`

**Files:**
- Create: `src/data_rover/core/table/custom_export.py`
- Test: `tests/table/test_custom_export.py` (new)

**Interfaces:**
- Consumes: `ColumnExportOptions`, `JsonColumnOptions`, `JsonSplitOptions`, `RowNumberExportOptions`, `TableDefinition` from `core/table/schema.py`.
- Produces (Tasks 6, 7 consume): `TableRef` (`{ref: str}`), `ColumnOverride`, `ExportEntry`, `CustomExportDefinition`, `CUSTOM_EXPORT_ADAPTER: TypeAdapter[CustomExportDefinition]`, `overridden_table(defn: TableDefinition, entry: ExportEntry) -> TableDefinition`.

- [ ] **Step 1: Write the failing tests** (`tests/table/test_custom_export.py`)

```python
"""The custom_export payload schema and the presentation-override application
(spec §3.3/§3.4). `overridden_table` output is RENDER ONLY — these tests pin
that it never touches structural fields and never mutates its input."""

from data_rover.core.table.custom_export import (
    CUSTOM_EXPORT_ADAPTER,
    ColumnOverride,
    ExportEntry,
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
    return ExportEntry.model_validate(doc)


def test_payload_roundtrips_and_defaults():
    cdef = CUSTOM_EXPORT_ADAPTER.validate_python(
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/table/test_custom_export.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement** (`src/data_rover/core/table/custom_export.py`)

```python
"""The `kind='custom_export'` artifact payload: a named collection of table
exports whose presentation lives IN the artefact (spec §3.3).

`overridden_table` is the override mechanism: a copy of the table definition
whose PRESENTATION fields are restated from an entry. RENDER ONLY — the copy
feeds `export_layout`/`export_header`/`export_definition`/`render_json` and
nothing else; evaluation keeps the original definition so cell values, row
order and script cache keys are independent of the artefact (the
`export_definition` boundary, applied from a different source).

Spec: docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, TypeAdapter

from .schema import (
    ColumnExportOptions,
    JsonColumnOptions,
    JsonSplitOptions,
    RowNumberExportOptions,
    TableDefinition,
)


class TableRef(BaseModel):
    """Serialized as a dict under the literal key `"ref"` — the shape
    `artifact_kinds.extract_refs`'s generic walk already understands, so the
    bundle deps closure and id rewriting need zero per-kind code."""

    ref: str


class ColumnOverride(BaseModel):
    """Presentation override for ONE definition column, keyed by index.
    Indices drift-normalize against the current definition at apply time
    (out-of-range dropped, duplicates first-wins) — `normalized_order`'s
    stance: a stale override left by a column remove must not block an
    export."""

    index: int = Field(ge=0)
    export: ColumnExportOptions | None = None
    json_export: JsonColumnOptions | None = None


class ExportEntry(BaseModel):
    source: TableRef
    #: Output base name in the zip; "" falls back to the table's name.
    name: str = ""
    format: Literal["xlsx", "json"] = "xlsx"
    columns: list[ColumnOverride] = Field(default_factory=list)
    export_order: list[int] = Field(default_factory=list)
    show_row_numbers: bool = False
    export_row_number: RowNumberExportOptions | None = None
    json_split: JsonSplitOptions | None = None


class CustomExportDefinition(BaseModel):
    schema_version: int = 1
    entries: list[ExportEntry] = Field(default_factory=list)


CUSTOM_EXPORT_ADAPTER: TypeAdapter[CustomExportDefinition] = TypeAdapter(
    CustomExportDefinition
)


def overridden_table(defn: TableDefinition, entry: ExportEntry) -> TableDefinition:
    """A copy of `defn` whose presentation restates `entry`.

    Columns the entry does not mention get DEFAULT presentation (`export=None`
    -> include follows `hidden`; `json_export=None`), deliberately NOT the
    table's own standalone settings — the two config sets never bleed into
    each other in either direction. Structural fields (sources, modes,
    `hidden`, filters, row source) are untouched: an entry restates how a
    table RENDERS, never what it computes.
    """
    by_index: dict[int, ColumnOverride] = {}
    for ov in entry.columns:
        if 0 <= ov.index < len(defn.columns) and ov.index not in by_index:
            by_index[ov.index] = ov
    columns = []
    for i, col in enumerate(defn.columns):
        ov = by_index.get(i)
        columns.append(
            col.model_copy(
                update={
                    "export": ov.export if ov is not None else None,
                    "json_export": ov.json_export if ov is not None else None,
                }
            )
        )
    return defn.model_copy(
        update={
            "columns": columns,
            "export_order": list(entry.export_order),
            "show_row_numbers": entry.show_row_numbers,
            "export_row_number": entry.export_row_number,
            "json_split": entry.json_split,
        }
    )
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/table/test_custom_export.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/core/table/custom_export.py tests/table/test_custom_export.py
git commit -m "feat(core): custom_export payload schema + overridden_table (P-14)"
```

---

### Task 4: Extract the export engine (pure refactor — zero behavior change)

**Files:**
- Create: `src/data_rover/api/table_export_engine.py`
- Modify: `src/data_rover/api/routes/tables.py` (`export_table` body, `_drain` at ~:162, `_status_from_job` at ~:171)
- Test: existing suites only — this task adds none.

**Interfaces:**
- Produces (Tasks 5, 7 consume):

```python
@dataclass(frozen=True)
class ExportPending:
    status: ScriptStatusOut

@dataclass(frozen=True)
class ExportFiles:
    files: list[tuple[str, bytes]]   # (filename WITH extension, blob)
    truncated: bool
    degraded: bool
    archive: bool                    # True => ship as zip even if len==1

def status_from_job(job: SweepJob) -> ScriptStatusOut: ...
def build_zip(files: list[tuple[str, bytes]]) -> bytes: ...
def run_table_export(
    *,
    session: Session,
    settings: Settings,
    runner: ScriptRunner | None,
    metamodel: Metamodel,
    model: Model,
    defn: TableDefinition,          # evaluation — the ORIGINAL definition
    render_defn: TableDefinition,   # presentation — same object for /tables/export
    name: str,
    format: str,                    # "xlsx" | "json"
    sort: SortSpec | None,
) -> ExportPending | ExportFiles: ...
```

- [ ] **Step 1: Record the green baseline**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py tests/api/test_table_export_json.py tests/api/test_tables_routes.py tests/api/test_tables_script_status.py tests/api/test_tables_nav_script.py -q`
Expected: all PASS. Note the counts — they must be identical after the refactor.

- [ ] **Step 2: Create the engine module**

`src/data_rover/api/table_export_engine.py` — module docstring:

```python
"""Shared table-export engine: the 202-vs-ship logic behind
`POST /tables/export` and `POST /exports/run`.

Extracted from `routes/tables.py::export_table` so both routes share ONE
completeness probe, ONE decision table, ONE zip builder. The long FIX A /
FIX B comments moved here VERBATIM — they are load-bearing; do not trim.

`run_table_export` takes TWO definitions: `defn` (evaluation — always the
original) and `render_defn` (presentation — an `overridden_table` copy for a
custom-export entry, the same object otherwise). This is the RENDER ONLY
boundary from `core/table/export_layout.py` made into a parameter.
"""
```

Move, verbatim, from `routes/tables.py` into this module:
- `_drain` (delete from routes/tables.py — export-only)
- `_status_from_job` → rename `status_from_job`; in `routes/tables.py` add `from ..table_export_engine import status_from_job as _status_from_job` (the evaluate route at ~:375 keeps using it under the old local name; do not touch that call site)
- the body of `export_table` from `limits = TableLimits(max_cell_elements=10**9, ignore_cell_caps=True)` (~:572) through the response assembly (~:830), EXCLUDING: `_resolve_table`, the sort bounds check, the artifact-name lookup, the exception mapping, and the `Response(...)` construction — those stay in the route.

Inside the engine, the moved code changes ONLY as follows:
- it runs inside `run_table_export` with its own `try/finally: close_script_context(script_ctx, acquired)`
- every 202 `return JSONResponse(...)` becomes `return ExportPending(status=...)` (for FIX B, build the status with `state` overridden to `"computing"` via `status.model_copy(update={"state": "computing"})` instead of mutating a dict body)
- every read of presentation goes through `render_defn`: `export_layout(render_defn)`, `export_header(render_defn, i)`, `export_definition(render_defn)`, and `render_json(model, eff, ...)` where `eff = export_definition(render_defn)`. Evaluation calls (`build_rows_ex`, `order_rows`, `iter_export_rows`, `open_script_context`/`table_has_script`) keep `defn`.
- the final branch returns `ExportFiles(files=[(filename, blob)], truncated=truncated, degraded=_degraded(), archive=False)` where `filename` is `f"{name}.json"` / `f"{name}.xlsx"` exactly as today.

Add the zip helper (used from Task 5 on):

```python
#: Fixed member timestamp: identical content zips byte-identically (the
#: determinism stance the WASM runner takes for snippet output).
ZIP_DATE_TIME = (1980, 1, 1, 0, 0, 0)


def build_zip(files: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, blob in files:
            info = zipfile.ZipInfo(filename, date_time=ZIP_DATE_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, blob)
    return buf.getvalue()
```

- [ ] **Step 3: Rewire `export_table`**

The route keeps its docstring, `_resolve_table`, sort validation, name lookup, and exception mapping; its middle becomes:

```python
        result = run_table_export(
            session=session,
            settings=settings,
            runner=runner,
            metamodel=metamodel,
            model=model,
            defn=defn,
            render_defn=defn,
            name=name,
            format=payload.format,
            sort=sort,
        )
        if isinstance(result, ExportPending):
            return JSONResponse(
                status_code=202,
                content=result.status.model_dump(),
                headers={"Retry-After": "1"},
            )
        if result.archive or len(result.files) > 1:
            blob = build_zip(result.files)
            media_type = "application/zip"
            filename = f"{name}.zip"
        else:
            filename, blob = result.files[0]
            media_type = (
                "application/json"
                if filename.endswith(".json")
                else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            )
        resp_headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        if result.truncated:
            resp_headers["X-Table-Truncated"] = "true"
        if result.degraded:
            resp_headers["X-Table-Script-Errors"] = "true"
        return Response(content=blob, media_type=media_type, headers=resp_headers)
```

Note the artifact-name lookup (`name = "table"` / `row.name`, ~:731) must move ABOVE the engine call. `close_script_context` leaves the route's `finally` (the engine owns it now) — delete the route-level `script_ctx`/`acquired` bookkeeping for this endpoint only (`json_preview` keeps its own).

- [ ] **Step 4: Verify zero behavior change**

Run: `pixi run -e core-dev pytest tests/api/test_table_export.py tests/api/test_table_export_json.py tests/api/test_tables_routes.py tests/api/test_tables_script_status.py tests/api/test_tables_nav_script.py -q`
Expected: identical pass counts to Step 1.

Run: `pixi run backend-lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/table_export_engine.py src/data_rover/api/routes/tables.py
git commit -m "refactor(api): extract run_table_export engine from the export route"
```

---

### Task 5: Split rendering in the engine + zip response (P-13 backend complete)

**Files:**
- Modify: `src/data_rover/api/table_export_engine.py` (JSON branch + early template validation)
- Test: `tests/api/test_table_export_split.py` (new)

**Interfaces:**
- Consumes: Task 2's `split_partitions`/`partition_label`/`render_filenames`/`validate_template`; Task 1's `json_split`.
- Produces: `ExportFiles.archive == True` for split runs (Task 7's folder rule keys off it).

- [ ] **Step 1: Write the failing tests** (`tests/api/test_table_export_split.py`; copy the `client` fixture and `_body` helper shape from `tests/api/test_table_export_json.py`, and `_bootstrap_model` from `tests/api/test_artifacts_routes.py` — read `_bootstrap_model` first to learn what elements it seeds and adapt the assertions' expected counts to it)

```python
"""POST /tables/export with json_split enabled (P-13)."""

import io
import json
import zipfile

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


def _body(split, columns=None):
    return {
        "definition": {
            "row_source": {"kind": "scope", "types": ["Block"]},
            "columns": columns
            or [
                {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
            ],
            "json_split": split,
        },
        "format": "json",
    }


def _post(client, body):
    return client.post(papi("/tables/export"), json=body, headers=AUTH_HEADERS)


def test_split_export_ships_a_zip_with_one_array_file_per_base_element(client):
    _bootstrap_model(client)
    r = _post(client, _body({"enabled": True, "filename_template": "DataFor${name}"}))
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].endswith('.zip"')
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = zf.namelist()
    assert names and all(n.startswith("DataFor") and n.endswith(".json") for n in names)
    # every file is an ARRAY, and concatenating them reproduces the unsplit export
    concat = []
    for n in names:
        docs = json.loads(zf.read(n))
        assert isinstance(docs, list) and docs
        concat.extend(docs)
    plain = _post(client, _body(None))
    assert json.loads(plain.content) == concat


def test_split_export_is_byte_deterministic(client):
    _bootstrap_model(client)
    body = _body({"enabled": True, "filename_template": "${name}"})
    assert _post(client, body).content == _post(client, body).content


def test_tokenless_template_answers_422_before_evaluating(client):
    _bootstrap_model(client)
    r = _post(client, _body({"enabled": True, "filename_template": "static"}))
    assert r.status_code == 422
    assert "${name}" in r.json()["detail"]


def test_disabled_split_and_xlsx_format_ignore_the_setting(client):
    _bootstrap_model(client)
    r = _post(client, _body({"enabled": False, "filename_template": "${name}"}))
    assert r.headers["content-type"].startswith("application/json")
    body = _body({"enabled": True, "filename_template": "${name}"})
    body["format"] = "xlsx"
    r = _post(client, body)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.openxml")
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_split.py -v`
Expected: FAIL — split export still returns a single JSON document (no zip), 422 test fails with 200.

- [ ] **Step 3: Implement in the engine**

At the top of `run_table_export`, before any evaluation:

```python
    split = render_defn.json_split
    split_on = format == "json" and split is not None and split.enabled
    if split_on:
        # Strict by decision (spec §2): the ONE export setting that rejects
        # rather than normalizes. Before any evaluation — a bad template must
        # not cost a whole-table pass. ValueError -> the routes' 422 mapping.
        validate_template(split.filename_template)
```

In the JSON branch (where `docs = render_json(...)` is today), with `rn = (layout.row_number_pos, layout.row_number_key) if layout.row_number_pos is not None else None`:

```python
        if split_on:
            parts = split_partitions(ordered, all_rows)
            labels = [partition_label(model, b) for b, _ in parts]
            stems = render_filenames(split.filename_template, labels)
            files = []
            for stem, (_, pairs) in zip(stems, parts, strict=True):
                docs = render_json(
                    model,
                    eff,
                    [rk for rk, _ in pairs],
                    (cells for _, cells in pairs),
                    build.base_slots,
                    order=layout.rank,
                    row_number=rn,
                )
                blob = json.dumps(docs, ensure_ascii=False, indent=2).encode("utf-8")
                files.append((f"{stem}.json", blob))
            return ExportFiles(
                files=files, truncated=truncated, degraded=_degraded(), archive=True
            )
```

(the non-split JSON path and the xlsx path are unchanged, `archive=False`).

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_table_export_split.py tests/api/test_table_export_json.py tests/api/test_table_export.py -v`
Expected: all PASS (old suites prove no regression).

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/table_export_engine.py tests/api/test_table_export_split.py
git commit -m "feat(api): per-element split JSON export ships as a zip (P-13)"
```

---

### Task 6: Register the `custom_export` artifact kind

**Files:**
- Modify: `src/data_rover/api/db_models.py` (`ArtifactKind`, ~:265), `src/data_rover/api/artifact_kinds.py` (`_REGISTRY`), `src/data_rover/api/schemas.py` (`CreateArtifactOp.artifact_kind` Literal ~:324, `ArtifactCreateIn.kind` Literal ~:1004)
- Create: `alembic/versions/0010_artifact_kind_width.py`
- Test: `tests/api/test_artifact_kinds.py` (append), `tests/api/test_artifacts_routes.py` (append)

**Interfaces:**
- Produces: `ArtifactKind.custom_export` (value `"custom_export"`), registry entry with `CUSTOM_EXPORT_ADAPTER`. Everything downstream (commit ops, leases, bundle closure, preview) is generic over the registry — no further backend wiring.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/test_artifact_kinds.py` (mirror the existing per-kind blocks):

```python
CUSTOM_EXPORT_PAYLOAD = {
    "schema_version": 1,
    "entries": [
        {"source": {"ref": "tbl-artifact-1"}, "name": "a", "format": "xlsx"},
        {
            "source": {"ref": "tbl-artifact-2"},
            "name": "b",
            "format": "json",
            "json_split": {"enabled": True, "filename_template": "${name}"},
        },
    ],
}


def test_custom_export_is_registered_and_roundtrips():
    spec = get_spec(ArtifactKind.custom_export)
    assert spec is not None
    obj = spec.adapter.validate_python(CUSTOM_EXPORT_PAYLOAD)
    assert [e.source.ref for e in obj.entries] == ["tbl-artifact-1", "tbl-artifact-2"]


def test_custom_export_refs_extract_and_rewrite():
    spec = get_spec(ArtifactKind.custom_export)
    assert spec.extract_deps(CUSTOM_EXPORT_PAYLOAD) == {
        "tbl-artifact-1",
        "tbl-artifact-2",
    }
    out = spec.rewrite_refs(CUSTOM_EXPORT_PAYLOAD, {"tbl-artifact-1": "NEW"})
    assert out["entries"][0]["source"]["ref"] == "NEW"
    assert out["entries"][1]["source"]["ref"] == "tbl-artifact-2"  # tolerant
    assert CUSTOM_EXPORT_PAYLOAD["entries"][0]["source"]["ref"] == "tbl-artifact-1"
```

Append to `tests/api/test_artifacts_routes.py` (mirror its create-route tests):

```python
def test_create_custom_export_artifact(client):
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "custom_export",
            "name": "release drop",
            "payload": {"entries": [{"source": {"ref": "tbl-1"}}]},
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    assert r.json()["kind"] == "custom_export"


def test_custom_export_payload_is_validated_on_create(client):
    r = client.post(
        papi("/artifacts"),
        json={
            "kind": "custom_export",
            "name": "bad",
            "payload": {"entries": [{"format": "csv"}]},  # no source, bad format
        },
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 422
```

(Adapt `client`/`papi`/`AUTH_HEADERS` usage to that file's local conventions — read its existing create test first.)

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_kinds.py tests/api/test_artifacts_routes.py -q`
Expected: new tests FAIL (`AttributeError: custom_export` / 422 on create).

- [ ] **Step 3: Implement**

`db_models.py` — add to `ArtifactKind`:

```python
    custom_export = "custom_export"
```

`artifact_kinds.py` — import `from data_rover.core.table.custom_export import CUSTOM_EXPORT_ADAPTER` and add to `_REGISTRY`:

```python
    ArtifactKind.custom_export: ArtifactKindSpec(
        kind=ArtifactKind.custom_export, adapter=CUSTOM_EXPORT_ADAPTER
    ),
```

`schemas.py` — add `"custom_export"` to BOTH Literals: `CreateArtifactOp.artifact_kind` and `ArtifactCreateIn.kind`.

`alembic/versions/0010_artifact_kind_width.py`:

```python
"""Widen project_artifacts.kind for custom_export.

`SAEnum(..., native_enum=False)` (0008) emitted a plain VARCHAR sized to the
then-longest member — VARCHAR(12) — with NO CHECK constraint
(`create_constraint` defaults to False). "custom_export" is 13 chars, so
Postgres needs the widen; 32 leaves headroom for future kinds. SQLite is
untyped-length and unaffected (tests use create_all anyway).

Revision ID: 0010
Revises: 0009
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "project_artifacts",
        "kind",
        existing_type=sa.VARCHAR(length=12),
        type_=sa.VARCHAR(length=32),
        existing_nullable=False,
    )


def downgrade() -> None:
    op.alter_column(
        "project_artifacts",
        "kind",
        existing_type=sa.VARCHAR(length=32),
        type_=sa.VARCHAR(length=12),
        existing_nullable=False,
    )
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_artifact_kinds.py tests/api/test_artifacts_routes.py tests/api/test_alembic.py tests/api/test_artifact_bundle.py tests/api/test_commits_artifact_ops.py -q`
Expected: all PASS — the bundle and commit-op suites prove the generic paths accept the kind. If any suite enumerates kinds exhaustively (asserting `diagram` 422s etc.), extend its expectation lists to include `custom_export`.

Then add ONE closure test to `tests/api/test_artifact_bundle.py`, following that file's existing closure tests (read how they seed artifacts and call the closure/derive function — reuse its helpers verbatim, only changing the fixture kinds):

```python
def test_custom_export_root_pulls_its_tables_into_the_closure(...):
    # seed: two table artifacts t1/t2 + one custom_export whose entries
    # reference both (payload shape: CUSTOM_EXPORT_PAYLOAD with the real ids)
    # assert: exporting with the custom_export as the only root includes
    # t1 and t2 in the bundle (the extract_deps BFS), and importing the
    # bundle into a fresh project rewrites entries[].source.ref to the
    # newly minted table ids (no ref left pointing at the source project).
```

Run: `pixi run -e core-dev pytest tests/api/test_artifact_bundle.py -q` — all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data_rover/api/db_models.py src/data_rover/api/artifact_kinds.py \
        src/data_rover/api/schemas.py alembic/versions/0010_artifact_kind_width.py \
        tests/api/test_artifact_kinds.py tests/api/test_artifacts_routes.py
git commit -m "feat(api): register the custom_export artifact kind (P-14)"
```

---

### Task 7: `POST /exports/run`

**Files:**
- Create: `src/data_rover/api/routes/exports.py`
- Modify: `src/data_rover/api/schemas.py` (add `RunExportIn`), `src/data_rover/api/authz.py` (`_READ_ONLY_POST_SUFFIXES`), `src/data_rover/api/main.py` (import + `include_router`)
- Test: `tests/api/test_exports_route.py` (new); `tests/api/test_authz.py` (append one viewer test)

**Interfaces:**
- Consumes: Task 3's `CUSTOM_EXPORT_ADAPTER`/`overridden_table`, Task 4's `run_table_export`/`ExportPending`/`ExportFiles`/`build_zip`, `routes/tables.py::_resolve_table` (reused via `EvaluateTableIn(artifact_id=...)`).
- Produces: `POST /{project_id}/exports/run` — 200 `application/zip` | 202 `ScriptStatusOut` | 404 unknown-or-wrong-kind | 422 empty/dangling.

- [ ] **Step 1: Write the failing tests** (`tests/api/test_exports_route.py`)

```python
"""POST /exports/run — the custom_export artifact's zip assembly (spec §4.3)."""

import io
import json
import zipfile

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


TABLE_PAYLOAD = {
    "row_source": {"kind": "scope", "types": ["Block"]},
    "columns": [
        {"kind": "element", "source": {"kind": "row"}, "header": "Block"},
        {"kind": "property", "source": {"kind": "row"}, "name": "mass",
         "header": "Mass"},
    ],
}


def _mk_table(client, name):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "table", "name": name, "payload": TABLE_PAYLOAD},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


def _mk_export(client, entries, name="drop"):
    r = client.post(
        papi("/artifacts"),
        json={"kind": "custom_export", "name": name,
              "payload": {"entries": entries}},
        headers=AUTH_HEADERS,
    )
    assert r.status_code == 201
    return r.json()["id"]


def _run(client, artifact_id):
    return client.post(
        papi("/exports/run"), json={"artifact_id": artifact_id},
        headers=AUTH_HEADERS,
    )


def test_mixed_format_entries_land_in_one_zip(client):
    _bootstrap_model(client)
    t1, t2 = _mk_table(client, "alpha"), _mk_table(client, "beta")
    art = _mk_export(
        client,
        [
            {"source": {"ref": t1}, "name": "sheet", "format": "xlsx"},
            {"source": {"ref": t2}, "name": "doc", "format": "json"},
        ],
    )
    r = _run(client, art)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"] == 'attachment; filename="drop.zip"'
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert sorted(names) == ["doc.json", "sheet.xlsx"]


def test_split_entry_lands_in_a_folder(client):
    _bootstrap_model(client)
    t = _mk_table(client, "gamma")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": "per-el", "format": "json",
            "json_split": {"enabled": True, "filename_template": "${name}"},
        }],
    )
    r = _run(client, art)
    assert r.status_code == 200
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert names and all(n.startswith("per-el/") and n.endswith(".json") for n in names)


def test_entry_name_falls_back_to_the_table_name(client):
    _bootstrap_model(client)
    t = _mk_table(client, "delta")
    art = _mk_export(client, [{"source": {"ref": t}, "format": "json"}])
    names = zipfile.ZipFile(io.BytesIO(_run(client, art).content)).namelist()
    assert names == ["delta.json"]


def test_entry_overrides_apply_without_touching_the_table(client):
    _bootstrap_model(client)
    t = _mk_table(client, "epsilon")
    art = _mk_export(
        client,
        [{
            "source": {"ref": t}, "name": "narrow", "format": "json",
            "columns": [{"index": 1, "export": {"include": False}}],
        }],
    )
    r = _run(client, art)
    docs = json.loads(zipfile.ZipFile(io.BytesIO(r.content)).read("narrow.json"))
    assert docs and "Mass" not in docs[0]  # excluded by the ENTRY
    # the table's own standalone export still contains Mass
    r2 = client.post(
        papi("/tables/export"), json={"artifact_id": t, "format": "json"},
        headers=AUTH_HEADERS,
    )
    assert "Mass" in json.loads(r2.content)[0]


def test_dangling_ref_is_a_422_naming_the_entry(client):
    _bootstrap_model(client)
    art = _mk_export(client, [{"source": {"ref": "gone"}, "name": "lost"}])
    r = _run(client, art)
    assert r.status_code == 422
    assert "lost" in r.json()["detail"]


def test_empty_entries_422_and_wrong_kind_404(client):
    _bootstrap_model(client)
    empty = _mk_export(client, [])
    assert _run(client, empty).status_code == 422
    t = _mk_table(client, "zeta")
    assert _run(client, t).status_code == 404          # a table, not a custom_export
    assert _run(client, "nope").status_code == 404
```

Append to `tests/api/test_authz.py`, following `test_viewer_can_call_readonly_post` exactly (same `_seed`/`_h` helpers):

```python
def test_viewer_can_call_readonly_post_exports_run(client: TestClient) -> None:
    pid = _seed()
    r = client.post(
        f"/projects/{pid}/exports/run", headers=_h("viewer"),
        json={"artifact_id": "x"},
    )
    assert r.status_code != 403  # authz passes; 404 comes from the route
```

- [ ] **Step 2: Run to verify failure**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py -q`
Expected: FAIL — 404 on every `_run` (route does not exist).

- [ ] **Step 3: Implement**

`schemas.py`:

```python
class RunExportIn(BaseModel):
    """`POST /exports/run` body. The id travels in the BODY, not the path:
    `authz._READ_ONLY_POST_SUFFIXES` matches fixed path suffixes, and this
    route must be viewer-callable like `/tables/export`."""

    artifact_id: str
```

`authz.py` — add `"/exports/run",` to `_READ_ONLY_POST_SUFFIXES`.

`src/data_rover/api/routes/exports.py`:

```python
"""Run a custom_export artifact: every entry's table export, one zip.

Read-only (viewer-callable): running an export commits nothing — only edits
to the artifact's DEFINITION go through POST /commits.
Spec: docs/superpowers/specs/2026-08-13-table-export-split-and-custom-export-design.md §4.3
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session as DbSession

from data_rover.core.navigation.resolve import NavigationResolveError
from data_rover.core.script.runner import ScriptRunner
from data_rover.core.table.custom_export import (
    CUSTOM_EXPORT_ADAPTER,
    CustomExportDefinition,
    overridden_table,
)

from .. import content
from ..db import get_db
from ..db_models import ArtifactKind
from ..deps import Session, get_request_session, require_model
from ..schemas import EvaluateTableIn, RunExportIn, ScriptStatusOut
from ..script_runner import get_runner
from ..settings import Settings, get_settings
from ..table_export_engine import (
    ExportFiles,
    ExportPending,
    build_zip,
    run_table_export,
)
from .tables import _resolve_table

router = APIRouter()


def _dedupe(stem: str, taken: set[str]) -> str:
    candidate, n = stem, 2
    while candidate in taken:
        candidate = f"{stem}_{n}"
        n += 1
    taken.add(candidate)
    return candidate


@router.post("/exports/run")
def run_export(
    payload: RunExportIn,
    project_id: str,
    session: Session = Depends(get_request_session),
    db: DbSession = Depends(get_db),
    runner: ScriptRunner | None = Depends(get_runner),
    settings: Settings = Depends(get_settings),
) -> Response:
    metamodel, model = require_model(session)
    row = content.get_artifact(db, payload.artifact_id)
    if (
        row is None
        or row.project_id != project_id
        or row.kind is not ArtifactKind.custom_export
    ):
        raise HTTPException(
            status_code=404, detail=f"unknown custom export {payload.artifact_id}"
        )
    cdef: CustomExportDefinition = CUSTOM_EXPORT_ADAPTER.validate_python(row.payload)
    if not cdef.entries:
        raise HTTPException(status_code=422, detail="custom export has no entries")

    # Resolve every table up front: an export artefact with a hole fails
    # LOUDLY (422 naming the entries) rather than shipping a partial zip that
    # looks complete — deliberate divergence from the bundle's
    # tolerant-dangler stance (spec §4.3).
    missing: list[str] = []
    tables = []
    for entry in cdef.entries:
        t = content.get_artifact(db, entry.source.ref)
        if (
            t is None
            or t.project_id != project_id
            or t.kind is not ArtifactKind.table
        ):
            missing.append(entry.name or entry.source.ref)
            tables.append(None)
        else:
            tables.append(t)
    if missing:
        raise HTTPException(
            status_code=422,
            detail="missing table(s) for entries: " + ", ".join(missing),
        )

    try:
        results = []
        for entry, t in zip(cdef.entries, tables, strict=True):
            assert t is not None
            defn = _resolve_table(
                EvaluateTableIn(artifact_id=t.id), project_id, db
            )
            out_name = entry.name or t.name
            results.append(
                (
                    entry,
                    out_name,
                    run_table_export(
                        session=session,
                        settings=settings,
                        runner=runner,
                        metamodel=metamodel,
                        model=model,
                        defn=defn,
                        render_defn=overridden_table(defn, entry),
                        name=out_name,
                        format=entry.format,
                        sort=None,
                    ),
                )
            )
    except LookupError as exc:
        raise HTTPException(status_code=422, detail=f"unknown artifact {exc}") from exc
    except (NavigationResolveError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    pending = [r.status for _, _, r in results if isinstance(r, ExportPending)]
    if pending:
        # ONE aggregate 202. Every entry already ran (kicking every pending
        # table's sweep, so they fill concurrently); the retry re-reads the
        # cache. `computing` wins over `failed` for the same reason as the
        # per-table FIX B: a retry that will succeed must not be told to
        # abandon the download.
        state = (
            "computing"
            if any(s.state == "computing" for s in pending)
            else "failed"
        )
        agg = ScriptStatusOut(
            state=state,
            done=sum(s.done for s in pending),
            total=sum(s.total for s in pending),
        )
        return JSONResponse(
            status_code=202,
            content=agg.model_dump(),
            headers={"Retry-After": "1"},
        )

    # zip assembly: continues in Step 3a below
```

**Step 3a — the assembly loop:** the function body continues (after the `pending` early-return) with:

```python
    files: list[tuple[str, bytes]] = []
    taken: set[str] = set()
    truncated = degraded = False
    for _entry, out_name, res in results:
        assert isinstance(res, ExportFiles)
        truncated |= res.truncated
        degraded |= res.degraded
        if res.archive:
            # A split entry keeps its per-element files together under one
            # folder named by the entry; root-name collisions dedupe `_2`.
            folder = _dedupe(out_name, taken)
            files.extend((f"{folder}/{fn}", blob) for fn, blob in res.files)
        else:
            fn, blob = res.files[0]
            stem, dot, ext = fn.rpartition(".")
            files.append((f"{_dedupe(stem, taken)}{dot}{ext}", blob))

    resp_headers = {
        "Content-Disposition": f'attachment; filename="{row.name}.zip"'
    }
    if truncated:
        resp_headers["X-Table-Truncated"] = "true"
    if degraded:
        resp_headers["X-Table-Script-Errors"] = "true"
    return Response(
        content=build_zip(files),
        media_type="application/zip",
        headers=resp_headers,
    )
```

`main.py` — add `exports` to the `from .routes import (...)` list and mount beside the tables router:

```python
    app.include_router(exports.router, prefix=proj, tags=["exports"])
```

- [ ] **Step 4: Run to verify pass**

Run: `pixi run -e core-dev pytest tests/api/test_exports_route.py tests/api/test_authz.py -q`
Expected: all PASS.

Also add and run ONE aggregate-202 test if `tests/api/test_tables_script_status.py`'s fake-runner fixture (`tests/api/_script_fakes.py`, `CountingRunner`) transplants cleanly: a custom export whose single entry's table has a script column, asserting `_run(...)` answers 202 with `Retry-After: 1` and a `state` of `computing`, then (after the sweep completes, following that suite's polling pattern) 200 with a zip. If the transplant needs more than ~30 lines of scaffolding, note it in the commit body and leave the aggregate-202 covered by the engine's own suite (the aggregation arithmetic is 6 lines; the engine 202 path is already pinned).

- [ ] **Step 5: Full backend gate**

Run: `pixi run core-test && pixi run backend-lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/data_rover/api/routes/exports.py src/data_rover/api/schemas.py \
        src/data_rover/api/authz.py src/data_rover/api/main.py \
        tests/api/test_exports_route.py tests/api/test_authz.py
git commit -m "feat(api): POST /exports/run assembles a custom export zip (P-14)"
```

---

### Task 8: Frontend C-6 — shared artifact-kind module (pure refactor, 3 kinds)

**Files:**
- Create: `frontend/src/lib/artifacts/kinds.ts`
- Modify: `frontend/src/lib/components/Sidebar/ArtifactsSection.svelte` (:23, :37-59), `frontend/src/lib/components/ExportArtifactsDialog.svelte` (:22, :24-28, :44), `frontend/src/lib/components/ImportArtifactsDialog.svelte` (:22-26), `frontend/src/lib/components/DiffDrawer.svelte` (:115-119), `frontend/src/lib/state/ops.ts` (:62), `frontend/src/lib/state/artifact-edits.svelte.ts` (:49, :135), `frontend/src/lib/state/artifacts.svelte.ts` (:97, :118), `frontend/src/lib/state/unsaved.ts` (:71)
- Test: `frontend/src/lib/artifacts/__tests__/kinds.test.ts` (new); existing component suites must stay green.

**Interfaces:**
- Produces (Tasks 9–12 consume): from `$lib/artifacts/kinds` — `type ArtifactKind`, `REGISTERED_KINDS`, `KIND_ICONS`, `KIND_LABEL`, `SECTION_KINDS`, `isRegisteredKind`.

- [ ] **Step 1: Write the module + test first**

`frontend/src/lib/artifacts/kinds.ts` (starts with today's 3 kinds — `custom_export` joins in Task 11, so this task is a ZERO-BEHAVIOR refactor):

```ts
/**
 * The one client-side registry of artifact kinds (backlog C-6): every
 * component that filters, labels, or icons artifact kinds reads from here.
 * Mirrors the backend registry in src/data_rover/api/artifact_kinds.py.
 */
import { FileCode, Route, Table } from '@lucide/svelte';

export type ArtifactKind = 'navigation' | 'table' | 'code_snippet';

export const REGISTERED_KINDS = ['navigation', 'table', 'code_snippet'] as const;

export const KIND_ICONS: Record<ArtifactKind, typeof Route> = {
	navigation: Route,
	table: Table,
	code_snippet: FileCode
};

export const KIND_LABEL: Record<ArtifactKind, string> = {
	navigation: 'Navigation',
	table: 'Table',
	code_snippet: 'Snippet'
};

/** Filter for headers whose kind is registered (unregistered kinds like the
 * reserved `diagram` must never render a row). */
export const SECTION_KINDS: ReadonlySet<string> = new Set(REGISTERED_KINDS);

export function isRegisteredKind(k: string): k is ArtifactKind {
	return SECTION_KINDS.has(k);
}
```

`frontend/src/lib/artifacts/__tests__/kinds.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	KIND_ICONS,
	KIND_LABEL,
	REGISTERED_KINDS,
	SECTION_KINDS,
	isRegisteredKind
} from '../kinds';

describe('artifact kind registry', () => {
	it('icon and label maps are total over the registered kinds', () => {
		for (const k of REGISTERED_KINDS) {
			expect(KIND_ICONS[k]).toBeTruthy();
			expect(KIND_LABEL[k]).toBeTruthy();
		}
	});
	it('rejects unregistered kinds', () => {
		expect(isRegisteredKind('diagram')).toBe(false);
		expect(SECTION_KINDS.has('diagram_kind')).toBe(false);
	});
});
```

- [ ] **Step 2: Run the new test**

Run: `pixi run frontend-test -- src/lib/artifacts/__tests__/kinds.test.ts`
Expected: PASS (module is self-contained).

- [ ] **Step 3: Refactor the duplicated sites to consume it**

- `ArtifactsSection.svelte`: delete local `type ArtifactKind` (:23); import it and the icons from `$lib/artifacts/kinds`; `SECTIONS` keeps its per-kind `title`/`singular`/`open` thunks but reads `icon: KIND_ICONS[kind]`.
- `ExportArtifactsDialog.svelte`: delete local `type ArtifactKind` (:22) and derive `SECTION_KINDS` from the shared module (the local `SECTIONS` display array stays; its `icon` fields come from `KIND_ICONS`).
- `ImportArtifactsDialog.svelte`: replace the local `ICONS` record with `KIND_ICONS` (keep the `?? Route` fallback for unregistered kinds in bundles).
- `DiffDrawer.svelte`: replace `ARTIFACT_KIND_LABEL` with `KIND_LABEL` (keep any lowercase/casing transformation it applied — check the render site).
- `ops.ts` :62, `artifact-edits.svelte.ts` :49/:135, `artifacts.svelte.ts` :97/:118, `unsaved.ts` :71: replace each inline `'navigation' | 'table' | 'code_snippet'` with `ArtifactKind` imported from `$lib/artifacts/kinds` (type-only imports where the file otherwise imports nothing runtime).

- [ ] **Step 4: Verify zero behavior change**

Run: `pixi run frontend-test -- src/lib/components/__tests__/artifacts-section.test.ts src/lib/components/__tests__/ExportArtifactsDialog.test.ts src/lib/components/__tests__/ImportArtifactsDialog.test.ts src/lib/components/__tests__/DiffDrawer.artifacts.test.ts src/lib/state/__tests__/artifacts.test.ts src/lib/state/__tests__/artifact-edits.test.ts src/lib/artifacts/__tests__/kinds.test.ts`
Expected: all PASS. Then `pixi run frontend-check` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/artifacts/ frontend/src/lib/components/Sidebar/ArtifactsSection.svelte \
        frontend/src/lib/components/ExportArtifactsDialog.svelte \
        frontend/src/lib/components/ImportArtifactsDialog.svelte \
        frontend/src/lib/components/DiffDrawer.svelte frontend/src/lib/state/ops.ts \
        frontend/src/lib/state/artifact-edits.svelte.ts frontend/src/lib/state/artifacts.svelte.ts \
        frontend/src/lib/state/unsaved.ts
git commit -m "refactor(frontend): shared artifact-kind registry module (C-6)"
```

---

### Task 9: Frontend P-13 — `json_split` types, mutator, and the ExportDialog split section

**Files:**
- Modify: `frontend/src/lib/api/types.ts` (~:930 `TableDefinitionSchema`), `frontend/src/lib/table/columns.ts`, `frontend/src/lib/components/Table/ExportDialog.svelte`
- Test: `frontend/src/lib/table/__tests__/columns.test.ts` (append), `frontend/src/lib/components/Table/__tests__/ExportDialog.test.ts` (append)

**Interfaces:**
- Produces: `JsonSplitOptionsSchema` / `type JsonSplitOptions` in `$lib/api/types`; `TableDefinition.json_split?: JsonSplitOptions | null`; `setJsonSplitOptions(defn, patch: Partial<JsonSplitOptions>): TableDefinition` and `templateIsValid(template: string): boolean` in `$lib/table/columns`.

- [ ] **Step 1: Types**

In `types.ts`, above `TableDefinitionSchema`:

```ts
export const JsonSplitOptionsSchema = z.object({
	enabled: z.boolean().default(false),
	filename_template: z.string().default('')
});
export type JsonSplitOptions = z.infer<typeof JsonSplitOptionsSchema>;
```

and inside `TableDefinitionSchema`: `json_split: JsonSplitOptionsSchema.nullish(),`.

- [ ] **Step 2: Write failing mutator tests** (append to `columns.test.ts`, inside or beside the `export_order bookkeeping` describe; use its local defn factory)

```ts
describe('json_split', () => {
	it('setJsonSplitOptions patches immutably with defaults', () => {
		const d = defn(); // the file's existing factory
		const on = setJsonSplitOptions(d, { enabled: true });
		expect(on.json_split).toEqual({ enabled: true, filename_template: '' });
		expect(d.json_split ?? null).toBeNull(); // input untouched
		const named = setJsonSplitOptions(on, { filename_template: 'DataFor${name}' });
		expect(named.json_split).toEqual({
			enabled: true,
			filename_template: 'DataFor${name}'
		});
	});
	it('templateIsValid requires ${name}', () => {
		expect(templateIsValid('DataFor${name}')).toBe(true);
		expect(templateIsValid('static')).toBe(false);
	});
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pixi run frontend-test -- src/lib/table/__tests__/columns.test.ts`
Expected: FAIL — `setJsonSplitOptions is not defined`.

- [ ] **Step 4: Implement in `columns.ts`** (beside `setRowNumberExportOptions`, ~:425)

```ts
export const DEFAULT_JSON_SPLIT: JsonSplitOptions = {
	enabled: false,
	filename_template: ''
};

export const SPLIT_TOKEN = '${name}';

/** Mirrors core/table/split.py::validate_template — the dialog blocks saving
 * a tokenless template; the server 422 stays as backstop. */
export function templateIsValid(template: string): boolean {
	return template.includes(SPLIT_TOKEN);
}

export function setJsonSplitOptions(
	defn: TableDefinition,
	patch: Partial<JsonSplitOptions>
): TableDefinition {
	const prev = defn.json_split ?? DEFAULT_JSON_SPLIT;
	return { ...defn, json_split: { ...prev, ...patch } };
}
```

Run the mutator tests again: PASS.

- [ ] **Step 5: Write failing dialog tests** (append to `ExportDialog.test.ts`, following its `mount`/`flushSync` conventions and existing helpers; JSON mode is entered by clicking `export-format-json`)

```ts
it('json mode shows the split section and persists json_split', async () => {
	const { host, tabId } = mountDialog(); // the file's existing helper pattern
	click('export-format-json');
	click('json-split-enabled');
	type('json-split-template', 'DataFor${name}');
	flushSync();
	expect(getTableDraft(tabId)!.definition.json_split).toEqual({
		enabled: true,
		filename_template: 'DataFor${name}'
	});
});

it('a tokenless template disables confirm and shows the hint', async () => {
	const { host } = mountDialog();
	click('export-format-json');
	click('json-split-enabled');
	type('json-split-template', 'static');
	flushSync();
	expect(
		(byTestId('export-confirm') as HTMLButtonElement).disabled
	).toBe(true);
	expect(byTestId('json-split-error').textContent).toContain('${name}');
});

it('xlsx mode hides the split section entirely', () => {
	mountDialog(); // default format is xlsx
	expect(queryByTestId('json-split-enabled')).toBeNull();
});
```

(Adapt `mountDialog`/`click`/`type`/`byTestId` to the concrete helpers in that file — it drives the real store via `ensureTableDraft` + `updateTableDefinition`; reuse its `defn()` fixture.)

- [ ] **Step 6: Implement the dialog section**

In `ExportDialog.svelte`, JSON-mode area (beside the snake_case controls):

```svelte
{#if format === 'json'}
	{@const split = defn.json_split ?? DEFAULT_JSON_SPLIT}
	<div class="split-section">
		<label>
			<input
				type="checkbox"
				data-testid="json-split-enabled"
				checked={split.enabled}
				onchange={(e) =>
					patchSplit({ enabled: e.currentTarget.checked })}
			/>
			One file per element (zip)
		</label>
		{#if split.enabled}
			<input
				type="text"
				data-testid="json-split-template"
				placeholder={'DataFor${name}'}
				value={split.filename_template}
				oninput={(e) =>
					patchSplit({ filename_template: e.currentTarget.value })}
			/>
			{#if !templateIsValid(split.filename_template)}
				<p data-testid="json-split-error" class="error">
					The template must contain {'${name}'}.
				</p>
			{/if}
		{/if}
	</div>
{/if}
```

with a `patchSplit` helper beside `patchJson` (:118):

```ts
function patchSplit(patch: Partial<JsonSplitOptions>) {
	updateTableExportSettings(tabId, setJsonSplitOptions(defn, patch));
}
```

and gate the confirm button: `disabled` when `format === 'json' && (defn.json_split?.enabled ?? false) && !templateIsValid(defn.json_split?.filename_template ?? '')`. Match the dialog's existing styling classes for the section (read the neighboring markup). The download path needs NO change — `exportTable` already parses `content-disposition` and blobs the body, which works for zip.

- [ ] **Step 7: Run to verify pass**

Run: `pixi run frontend-test -- src/lib/components/Table/__tests__/ExportDialog.test.ts src/lib/table/__tests__/columns.test.ts`
Expected: all PASS (old dialog tests included).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/table/columns.ts \
        frontend/src/lib/components/Table/ExportDialog.svelte \
        frontend/src/lib/table/__tests__/columns.test.ts \
        frontend/src/lib/components/Table/__tests__/ExportDialog.test.ts
git commit -m "feat(frontend): per-element split settings in the JSON export dialog (P-13)"
```

---

### Task 10: Frontend P-14 types, override helpers, API client

**Files:**
- Modify: `frontend/src/lib/api/types.ts`
- Create: `frontend/src/lib/table/custom-export.ts`, `frontend/src/lib/api/exports.ts`
- Test: `frontend/src/lib/table/__tests__/custom-export.test.ts`, `frontend/src/lib/api/__tests__/exports.test.ts` (MSW, mirroring `api/__tests__/tables.test.ts`'s 202 coverage)

**Interfaces:**
- Produces:
  - types: `ColumnOverrideSchema`/`ExportEntrySchema`/`CustomExportDefinitionSchema` + inferred types (wire mirror of Task 3).
  - `$lib/table/custom-export`: `applyEntryOverrides(defn: TableDefinition, entry: ExportEntry): TableDefinition` (client mirror of `overridden_table`, for the layout dialog + preview), `overridesFromDefinition(defn: TableDefinition): Pick<ExportEntry, 'columns' | 'export_order' | 'show_row_numbers' | 'export_row_number' | 'json_split'>` (copy-at-add), `entryForTable(tableId: string, defn: TableDefinition, name: string): ExportEntry`.
  - `$lib/api/exports`: `runCustomExport(artifactId: string): Promise<ExportResult>` (reuses `ExportResult` — export it from `api/tables.ts` if not already exported).

- [ ] **Step 1: Types** (in `types.ts`, after the table schemas)

```ts
export const ColumnOverrideSchema = z.object({
	index: z.number().int().nonnegative(),
	export: ColumnExportOptionsSchema.nullish(),
	json_export: JsonColumnOptionsSchema.nullish()
});
export const ExportEntrySchema = z.object({
	source: z.object({ ref: z.string() }),
	name: z.string().default(''),
	format: z.enum(['xlsx', 'json']).default('xlsx'),
	columns: z.array(ColumnOverrideSchema).default([]),
	export_order: z.array(z.number().int()).default([]),
	show_row_numbers: z.boolean().default(false),
	export_row_number: RowNumberExportOptionsSchema.nullish(),
	json_split: JsonSplitOptionsSchema.nullish()
});
export const CustomExportDefinitionSchema = z.object({
	schema_version: z.number().default(1),
	entries: z.array(ExportEntrySchema).default([])
});
export type ColumnOverride = z.infer<typeof ColumnOverrideSchema>;
export type ExportEntry = z.infer<typeof ExportEntrySchema>;
export type CustomExportDefinition = z.infer<typeof CustomExportDefinitionSchema>;
```

- [ ] **Step 2: Failing tests for the pure helpers** (`custom-export.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
	applyEntryOverrides,
	entryForTable,
	overridesFromDefinition
} from '../custom-export';
import type { TableDefinition } from '$lib/api/types';

const defn: TableDefinition = {
	schema_version: 1,
	row_source: { kind: 'scope', types: ['Block'], criteria: [] },
	columns: [
		{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: 'A',
		  width_px: null, hidden: false,
		  json_export: { key: 'a', item_key: '', value: 'name', group: false },
		  export: { include: false, header: '' } },
		{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: 'B',
		  width_px: null, hidden: false, json_export: null, export: null }
	],
	default_cell_mode: 'collapse',
	show_row_numbers: true,
	export_order: [1, 0],
	export_row_number: null,
	json_split: null
};

describe('custom-export helpers', () => {
	it('entryForTable copies the table settings at add time', () => {
		const e = entryForTable('tbl-1', defn, 'My table');
		expect(e.source).toEqual({ ref: 'tbl-1' });
		expect(e.name).toBe('My table');
		expect(e.columns).toEqual([
			{ index: 0,
			  export: { include: false, header: '' },
			  json_export: { key: 'a', item_key: '', value: 'name', group: false } }
		]); // column 1 has nothing to copy
		expect(e.export_order).toEqual([1, 0]);
		expect(e.show_row_numbers).toBe(true);
	});

	it('applyEntryOverrides mirrors overridden_table: defaults, drift, no mutation', () => {
		const e = entryForTable('tbl-1', defn, 'n');
		const out = applyEntryOverrides(defn, {
			...e,
			columns: [{ index: 0, export: { include: true, header: 'X' }, json_export: null },
			          { index: 99, export: null, json_export: null }],
			export_order: [0, 1],
			show_row_numbers: false
		});
		expect(out.columns[0].export).toEqual({ include: true, header: 'X' });
		expect(out.columns[1].export).toBeNull(); // unmentioned -> DEFAULT
		expect(out.columns[1].json_export).toBeNull();
		expect(out.export_order).toEqual([0, 1]);
		expect(defn.columns[0].export).toEqual({ include: false, header: '' });
	});

	it('overridesFromDefinition extracts exactly the presentation set', () => {
		const o = overridesFromDefinition(defn);
		expect(Object.keys(o).sort()).toEqual([
			'columns', 'export_order', 'export_row_number',
			'json_split', 'show_row_numbers'
		]);
	});
});
```

- [ ] **Step 3: Run to verify failure, then implement** (`frontend/src/lib/table/custom-export.ts`)

Run: `pixi run frontend-test -- src/lib/table/__tests__/custom-export.test.ts` → FAIL, then:

```ts
/**
 * Client mirror of core/table/custom_export.py::overridden_table — used by
 * the entry layout dialog and the json-preview call. Display-only; the
 * backend re-applies overrides itself at /exports/run time, so drift here
 * cannot corrupt an export (same stance as table/export-layout.ts).
 */
import type {
	ColumnOverride,
	ExportEntry,
	TableDefinition
} from '$lib/api/types';

export function applyEntryOverrides(
	defn: TableDefinition,
	entry: ExportEntry
): TableDefinition {
	const byIndex = new Map<number, ColumnOverride>();
	for (const ov of entry.columns) {
		if (ov.index >= 0 && ov.index < defn.columns.length && !byIndex.has(ov.index))
			byIndex.set(ov.index, ov);
	}
	return {
		...defn,
		columns: defn.columns.map((col, i) => {
			const ov = byIndex.get(i);
			return { ...col, export: ov?.export ?? null, json_export: ov?.json_export ?? null };
		}),
		export_order: [...entry.export_order],
		show_row_numbers: entry.show_row_numbers,
		export_row_number: entry.export_row_number ?? null,
		json_split: entry.json_split ?? null
	};
}

export function overridesFromDefinition(
	defn: TableDefinition
): Pick<
	ExportEntry,
	'columns' | 'export_order' | 'show_row_numbers' | 'export_row_number' | 'json_split'
> {
	const columns: ColumnOverride[] = [];
	defn.columns.forEach((col, index) => {
		if (col.export != null || col.json_export != null)
			columns.push({
				index,
				export: col.export ?? null,
				json_export: col.json_export ?? null
			});
	});
	return {
		columns,
		export_order: [...defn.export_order],
		show_row_numbers: defn.show_row_numbers,
		export_row_number: defn.export_row_number ?? null,
		json_split: defn.json_split ?? null
	};
}

export function entryForTable(
	tableId: string,
	defn: TableDefinition,
	name: string
): ExportEntry {
	return {
		source: { ref: tableId },
		name,
		format: 'xlsx',
		...overridesFromDefinition(defn)
	};
}
```

Re-run: PASS.

- [ ] **Step 4: API client + MSW test**

`frontend/src/lib/api/exports.ts` (mirror `exportTable`'s shape in `api/tables.ts:36-78`, reusing its `ExportResult` type — export it from `tables.ts` if it isn't):

```ts
import { apiFetchRaw } from './client'; // match tables.ts's actual import
import { parseAttachmentFilename, type ExportResult } from './tables'; // reuse; export these from tables.ts if private

export async function runCustomExport(artifactId: string): Promise<ExportResult> {
	const res = await apiFetchRaw('/exports/run', {
		method: 'POST',
		body: JSON.stringify({ artifact_id: artifactId })
	});
	if (res.status === 202) {
		const body = await res.json();
		return { kind: 'preparing', done: body.done ?? 0, total: body.total ?? 0 };
	}
	return {
		kind: 'ready',
		blob: await res.blob(),
		filename: parseAttachmentFilename(res) ?? 'export.zip'
	};
}
```

**Before writing this, read `api/tables.ts:36-78`** and reuse its exact fetch helper and filename-parsing code (extract the filename parser into a shared function if it's inline). `exports.test.ts` mirrors `api/__tests__/tables.test.ts`: MSW `server.use(http.post('*/exports/run', ...))` returning (a) 202 `{state:'computing',done:1,total:4}` → expect `{kind:'preparing',done:1,total:4}`; (b) 200 with `Content-Disposition: attachment; filename="drop.zip"` and a body → expect `kind:'ready'`, `filename === 'drop.zip'`.

- [ ] **Step 5: Run, then commit**

Run: `pixi run frontend-test -- src/lib/api/__tests__/exports.test.ts src/lib/api/__tests__/tables.test.ts`
Expected: PASS.

```bash
git add frontend/src/lib/api/types.ts frontend/src/lib/api/exports.ts \
        frontend/src/lib/api/tables.ts frontend/src/lib/table/custom-export.ts \
        frontend/src/lib/table/__tests__/custom-export.test.ts \
        frontend/src/lib/api/__tests__/exports.test.ts
git commit -m "feat(frontend): custom-export types, override helpers, run client (P-14)"
```

---

### Task 11: `custom-export-editor` state module + kind/workspace wiring

**Files:**
- Create: `frontend/src/lib/state/custom-export-editor.svelte.ts`
- Modify: `frontend/src/lib/artifacts/kinds.ts` (add the kind), `frontend/src/lib/state/workspace.svelte.ts` (:20 kind union, :25 `PREFIX`), `frontend/src/lib/state/unsaved.ts` (`isTabDirty` :49-62, `isArtifactDirty` :70-76), `frontend/src/lib/state/artifact-lock-denied.ts` (:27-31), `frontend/src/lib/state/index.ts` (barrel block)
- Test: `frontend/src/lib/state/__tests__/custom-export-editor.test.ts` (new), `frontend/src/lib/state/__tests__/artifact-lock-denied.test.ts` (append), `frontend/src/lib/state/__tests__/workspace.test.ts` (append)

**Interfaces:**
- Consumes: Task 10's types/helpers; `acquireArtifactLease` from `state/edit-gate.ts`; `stageArtifactCreate`/`stageArtifactUpdate` from `state/artifact-edits.svelte.ts`; `assertNoNameClash` from `state/artifacts.svelte.ts`; `openArtifactTab`/`retitleTab`/`repointTabArtifact`/`bindTabToArtifact` from `state/workspace.svelte.ts`; `releaseArtifactIfUnneeded` from `state/checkout.svelte.ts`; `artifactsApi.getArtifact`.
- Produces (Task 12 consumes; all re-exported through the `$lib/state` barrel):

```ts
export interface CustomExportDraft {
	name: string;
	artifactId: string | null;
	artifactRev: number | null;
	entries: ExportEntry[];
	dirty: boolean;
}
export function ensureCustomExportDraft(tabId: string): Promise<void>;
export function getCustomExportDraft(tabId: string): CustomExportDraft | undefined;
export function getCustomExportLockHolder(tabId: string): string | undefined;
export function setCustomExportLockDenied(tabId: string, holder: string): void;
export function setCustomExportName(tabId: string, name: string): void;
export function addExportEntry(tabId: string, tableId: string, tableName: string, defn: TableDefinition): void;
export function removeExportEntry(tabId: string, index: number): void;
export function moveExportEntryInList(tabId: string, from: number, to: number): void;
export function updateExportEntry(tabId: string, index: number, patch: Partial<ExportEntry>): void;
export function saveCustomExportDraft(tabId: string): void;   // STAGES, never POSTs
export function closeCustomExportDraft(tabId: string): void;
export function resetCustomExportEditors(): void;
export function hasDirtyCustomExportDrafts(): boolean;
```

Tab-id keying: `exp:draft:<n>` (unsaved) / `exp:<artifactId>` (saved) — `PREFIX` entry `custom_export: 'exp'`. Workspace `DynamicTab.kind` gains `'custom_export'`.

- [ ] **Step 1: Model the module on `snippet-editor.svelte.ts`** — read it in full first (its docstring L1-27 states the contract: draft keyed by tabId, lease-on-open for saved artifacts with `.catch(() => null)` and `_lockDenied` only on `reason === 'conflict'`, saving STAGES via `stageArtifactCreate`/`stageArtifactUpdate`, rekey-at-commit listeners at module bottom). Reproduce that structure with the draft shape above; `ensureCustomExportDraft`'s saved branch parses the fetched payload through `CustomExportDefinitionSchema` and builds `entries`; `saveCustomExportDraft` validates `assertNoNameClash('custom_export', name, artifactId)` then stages `{schema_version: 1, entries}` as the payload; `addExportEntry` pushes `entryForTable(tableId, defn, tableName)` (the copy-at-add moment, spec §5.2).

- [ ] **Step 2: Write the failing state tests** (`custom-export-editor.test.ts`; mirror `snippet-editor.test.ts`'s setup — `beforeEach` resets + `vi.spyOn(artifactsApi, 'getArtifact')`, spies on `checkoutApi.acquireLocks` returning an `art:<id>` lease like `Workspace.export-button.test.ts` does)

```ts
it('a draft tab starts empty and add copies the table settings', async () => {
	await ensureCustomExportDraft('exp:draft:1');
	addExportEntry('exp:draft:1', 'tbl-1', 'Alpha', defnFixture);
	const d = getCustomExportDraft('exp:draft:1')!;
	expect(d.entries).toHaveLength(1);
	expect(d.entries[0].name).toBe('Alpha');
	expect(d.dirty).toBe(true);
});

it('saving a new draft stages a create and repoints the tab', async () => {
	await ensureCustomExportDraft('exp:draft:1');
	addExportEntry('exp:draft:1', 'tbl-1', 'Alpha', defnFixture);
	setCustomExportName('exp:draft:1', 'Release drop');
	saveCustomExportDraft('exp:draft:1');
	const ops = getStagedArtifactOps();
	expect(ops).toHaveLength(1);
	expect(ops[0]).toMatchObject({
		kind: 'create_artifact',
		artifact_kind: 'custom_export',
		name: 'Release drop'
	});
	expect(getCustomExportDraft('exp:draft:1')!.dirty).toBe(false);
});

it('opening a saved artifact acquires the lease and hydrates entries', async () => {
	// getArtifact spy returns {id:'art-1', kind:'custom_export', name:'Drop',
	//  artifact_rev: 3, payload:{entries:[{source:{ref:'tbl-1'}}]}}
	await ensureCustomExportDraft('exp:art-1');
	expect(acquireSpy).toHaveBeenCalled();
	const d = getCustomExportDraft('exp:art-1')!;
	expect(d.artifactId).toBe('art-1');
	expect(d.entries[0].source.ref).toBe('tbl-1');
	expect(d.dirty).toBe(false);
});

it('a lease conflict marks the tab read-only', async () => {
	// acquireLocks spy rejects with {reason:'conflict', holder:'Ada'}
	await ensureCustomExportDraft('exp:art-1');
	expect(getCustomExportLockHolder('exp:art-1')).toBe('Ada');
});
```

(Adapt the spy shapes to what `snippet-editor.test.ts` actually stubs — copy its fixtures.)

- [ ] **Step 3: Run to verify failure, implement the module, run to pass**

Run: `pixi run frontend-test -- src/lib/state/__tests__/custom-export-editor.test.ts`

- [ ] **Step 4: Wire the kind through the small unions**

- `kinds.ts`: `ArtifactKind` gains `'custom_export'`; `REGISTERED_KINDS` gains it; `KIND_ICONS.custom_export = FolderOutput` (import from `@lucide/svelte` — verified present); `KIND_LABEL.custom_export = 'Custom export'`.
- `workspace.svelte.ts`: kind union + `PREFIX['custom_export'] = 'exp'`.
- `unsaved.ts`: `isTabDirty` gains a `custom_export` arm reading `getCustomExportDraft(tabId)?.dirty`; `isArtifactDirty` gains the `exp:` prefix mapping.
- `artifact-lock-denied.ts`: fourth branch — `exp:` → `setCustomExportLockDenied`.
- `state/index.ts`: re-export the module's public surface (mirror the snippet block at :340-374).
- Append to `artifact-lock-denied.test.ts` (a `exp:` dispatch case) and `workspace.test.ts` (an `openArtifactTab('custom_export', {artifactId: 'a', title: 't'})` id-shape case asserting `exp:a`).

- [ ] **Step 5: Run the wiring suites, then commit**

Run: `pixi run frontend-test -- src/lib/state/__tests__/custom-export-editor.test.ts src/lib/state/__tests__/artifact-lock-denied.test.ts src/lib/state/__tests__/workspace.test.ts src/lib/state/__tests__/unsaved.test.ts src/lib/artifacts/__tests__/kinds.test.ts` (if `unsaved.test.ts` doesn't exist, skip it)
Expected: PASS. Then `pixi run frontend-check`.

```bash
git add frontend/src/lib/state/custom-export-editor.svelte.ts frontend/src/lib/artifacts/kinds.ts \
        frontend/src/lib/state/workspace.svelte.ts frontend/src/lib/state/unsaved.ts \
        frontend/src/lib/state/artifact-lock-denied.ts frontend/src/lib/state/index.ts \
        frontend/src/lib/state/__tests__/custom-export-editor.test.ts \
        frontend/src/lib/state/__tests__/artifact-lock-denied.test.ts \
        frontend/src/lib/state/__tests__/workspace.test.ts
git commit -m "feat(frontend): custom-export editor state + kind wiring (P-14)"
```

---

### Task 12: Components — settings panel extraction, entry dialog, the tab, sidebar/workspace

**Files:**
- Create: `frontend/src/lib/components/Export/ExportSettingsPanel.svelte`, `frontend/src/lib/components/Export/EntryLayoutDialog.svelte`, `frontend/src/lib/components/Export/CustomExportTab.svelte`
- Modify: `frontend/src/lib/components/Table/ExportDialog.svelte` (delegate to the panel), `frontend/src/lib/components/Sidebar/ArtifactsSection.svelte` (SECTIONS entry), `frontend/src/lib/components/Sidebar/TreeRow.svelte` (:229-237 open switch, :389-397 icon switch, :399-405 dirty guard), `frontend/src/lib/components/Workspace.svelte` (:52-58 close switch, :93-105 content loop)
- Test: `frontend/src/lib/components/Export/__tests__/CustomExportTab.test.ts`, `frontend/src/lib/components/Export/__tests__/EntryLayoutDialog.test.ts`; existing `ExportDialog.test.ts` must stay green.

**Interfaces:**
- Consumes: everything Tasks 9–11 produced.
- Produces: `ExportSettingsPanel` props — `{ definition: TableDefinition; format: 'xlsx' | 'json'; onChange: (next: TableDefinition) => void; previewDefinition?: TableDefinition }` (presentational: entry list with include/rename/drag, row-number entry, json options, split section, debounced `previewTableJson({definition: previewDefinition ?? definition})` pane — all markup lifted from today's `ExportDialog`).

- [ ] **Step 1: Extract `ExportSettingsPanel` from `ExportDialog`**

Mechanical: move the settings-list + json-options + split-section + preview markup and their pure-function helpers (`patchExport`/`patchJson`/`patchRowNumber`/`patchSplit`/`toggleInclude`/`setName`/`snakeAll`/drag) into the panel, rewritten to call `onChange(nextDefinition)` instead of `updateTableExportSettings` directly. `ExportDialog` keeps: open/snapshot/cancel semantics, format buttons, confirm/cancel buttons, and passes `onChange={(next) => updateTableExportSettings(tabId, next)}`. ALL existing testids move with the markup — `ExportDialog.test.ts` (29 tests, incl. Task 9's) is the regression harness and must pass **unmodified**.

Run: `pixi run frontend-test -- src/lib/components/Table/__tests__/ExportDialog.test.ts`
Expected: PASS with zero test edits.

- [ ] **Step 2: `EntryLayoutDialog`** — a bits-ui dialog (copy `ExportDialog`'s dialog scaffolding) with props `{ open: bindable; tableDefinition: TableDefinition; entry: ExportEntry; onSave: (patch: Partial<ExportEntry>) => void; onClose: () => void }`. It holds a local working copy: `effective = $state(applyEntryOverrides(tableDefinition, entry))` plus a local `format` initialized from `entry.format`; renders `<ExportSettingsPanel definition={effective} {format} onChange={(n) => (effective = n)} />` and format buttons; Save extracts `{format, ...overridesFromDefinition(effective)}` via `onSave` and closes. Confirm disabled under the same tokenless-template rule as Task 9.

- [ ] **Step 3: `CustomExportTab`** — props `{ tabId: string }`, modeled on `SnippetTab`'s frame (header with name input + lock-holder banner + Save button; body). On mount `ensureCustomExportDraft(tabId)`. Body:
  - entry list (`data-testid="export-entry-{i}"`): name input, format toggle (two `aria-pressed` buttons like the export dialog), "Edit layout" button opening `EntryLayoutDialog` for that entry (fetching the table's definition via `artifactsApi.getArtifact(entry.source.ref)` on open, parsed with `TableDefinitionSchema`), remove button, drag-reorder via the same pattern the export dialog's entry list uses (`createColumnDrag`).
  - "Add table" picker: a dropdown over `referenceableArtifactHeaders('table')` minus tables already present; selecting one calls `addExportEntry(tabId, header.id, header.name, parsedDefinition)` (fetch + parse first).
  - Save button → `saveCustomExportDraft(tabId)` (staging; the DiffDrawer commit flow takes it from there).
  - Export button (`data-testid="custom-export-run"`): disabled while `draft.dirty || draft.artifactId == null` (tooltip "Save and commit first — the export runs the committed definition"); on click, poll `runCustomExport(artifactId)` in the same retry loop shape as `downloadTable` (`table-editor.svelte.ts:1607-1657` — reuse its constants; extract the generic retry-and-download helper into `frontend/src/lib/util/export-download.ts` if the loop can be shared without touching `downloadTable`'s public signature, otherwise copy the ~20 lines and note the duplication in a comment).
- [ ] **Step 4: Wire the surfaces**
  - `ArtifactsSection.svelte`: SECTIONS entry `{ kind: 'custom_export', title: 'Custom exports', singular: 'custom export', icon: KIND_ICONS.custom_export, open: (o) => openArtifactTab('custom_export', o) }`; the `collapsed` record gains the key.
  - `TreeRow.svelte`: `custom_export` arms in the open switch, icon switch, and dirty guard.
  - `Workspace.svelte`: close-path arm calling `closeCustomExportDraft(tab.id)`; content branch `{:else if tab.kind === 'custom_export'}<CustomExportTab tabId={tab.id} />`.

- [ ] **Step 5: Write the component tests**

`CustomExportTab.test.ts` — copy the mount scaffolding (`mount`/`unmount`/`flushSync`, `beforeEach` resets, `setProjectInfo({role:'editor', lockTtlSeconds:300})`, `vi.spyOn(artifactsApi, 'listArtifacts'/'getArtifact')`, `vi.spyOn(checkoutApi, 'acquireLocks')` returning an `art:<id>` lease) from `Workspace.export-button.test.ts` and `SnippetTab.lock-denied.test.ts`. First test in full:

```ts
const EXPORT_ARTIFACT = {
	id: 'art-1',
	kind: 'custom_export',
	name: 'Drop',
	artifact_rev: 3,
	updated_at: new Date().toISOString(),
	updated_by: null,
	entry_points: null,
	payload: { schema_version: 1, entries: [{ source: { ref: 'tbl-1' }, name: 'Alpha', format: 'json' }] }
};

it('renders entries from a saved artifact and stages edits on save', async () => {
	getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
	const host = mount(CustomExportTab, {
		target: document.body,
		props: { tabId: 'exp:art-1' }
	});
	await vi.waitFor(() =>
		expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
	);
	const name = document.querySelector<HTMLInputElement>(
		'[data-testid="export-entry-0"] input'
	)!;
	name.value = 'Renamed';
	name.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	document
		.querySelector<HTMLButtonElement>('[data-testid="custom-export-save"]')!
		.click();
	flushSync();
	expect(getStagedArtifactOps()[0]).toMatchObject({ kind: 'update_artifact' });
	unmount(host);
});
```

Three more tests, same scaffolding, asserting exactly:
- **add-table copy semantics**: with `listArtifacts` returning one committed `table` header and `getArtifact` returning a table whose column 0 has `export: {include: false}` — picking it in the add-table dropdown produces `getCustomExportDraft('exp:art-1')!.entries[1].columns` equal to `[{index: 0, export: {include: false, header: ''}, json_export: null}]`.
- **export gating + download loop**: while `draft.dirty` is true, `[data-testid="custom-export-run"]` has `disabled`; after save (clean draft, non-null `artifactId`), with `vi.spyOn(exportsApi, 'runCustomExport')` resolving `{kind:'preparing', done:1, total:2}` once then `{kind:'ready', blob, filename:'Drop.zip'}`, clicking it (with `vi.useFakeTimers()` and advancing past the retry sleep) calls the spy exactly twice.
- **peer lease banner**: `acquireLocks` rejecting with the same conflict shape `SnippetTab.lock-denied.test.ts` stubs → the tab shows its read-only banner naming the holder and the entry inputs are disabled.

`EntryLayoutDialog.test.ts` — mount the dialog directly with `props: { open: true, tableDefinition, entry, onSave, onClose }`, asserting exactly:
- the panel reflects the EFFECTIVE definition: an entry with `columns: [{index: 1, export: {include: false, header: ''}, json_export: null}]` renders `export-include-…` for column 1 unchecked while `tableDefinition` itself has it included;
- Save calls `onSave` with `{format, ...overridesFromDefinition(editedCopy)}` — toggle column 1 back on first and assert the emitted `columns` no longer contains an `include: false` override for it;
- with `format: 'json'` and `json_split: {enabled: true, filename_template: 'static'}` on the entry, the Save button is `disabled` (tokenless template), and typing `${name}` into `json-split-template` re-enables it.

- [ ] **Step 6: Run everything frontend, commit**

Run: `pixi run frontend-test` and `pixi run frontend-check`
Expected: full suite green.

```bash
git add frontend/src/lib/components/Export/ frontend/src/lib/components/Table/ExportDialog.svelte \
        frontend/src/lib/components/Sidebar/ArtifactsSection.svelte \
        frontend/src/lib/components/Sidebar/TreeRow.svelte frontend/src/lib/components/Workspace.svelte
git commit -m "feat(frontend): custom export tab, entry layout dialog, sidebar wiring (P-14)"
```

---

### Task 13: Docs + final gates

**Files:**
- Modify: `BACKLOG.md` (P-13, P-14 → `done`, same-commit rule from its header; C-6 row → done), `CLAUDE.md` ("Table export formats" bullet + the artifact-ops bullet's kind list), `frontend/README.md` (state-model section: the `exp:` tab kind and editor module, following how the snippet editor is documented)

- [ ] **Step 1: Update the docs**

- `BACKLOG.md`: mark `P-13` and `P-14` `done (2026-08-XX)` with one-line summaries naming the landed surfaces (`core/table/split.py`, `POST /exports/run`, `custom_export` kind); mark C-6 done in §7's table.
- `CLAUDE.md`: extend the **Table export formats** bullet with two sentences: split-JSON zips via `json_split` + `core/table/split.py`, and the `custom_export` kind (`core/table/custom_export.py`, engine `api/table_export_engine.py`, `POST /exports/run`, spec path). Update the artifact-kind enumeration in the artifact-ops bullet (`diagram`/`diagram_kind` stay unregistered).
- `frontend/README.md`: document the `exp:` tab prefix, `custom-export-editor.svelte.ts`, and the copy-at-add override semantics in the state-model section.

- [ ] **Step 2: Full gates**

Run, in order, all must pass:

```bash
pixi run core-test
pixi run frontend-test
pixi run dr-tidy
```

- [ ] **Step 3: Commit**

```bash
git add BACKLOG.md CLAUDE.md frontend/README.md
git commit -m "docs: P-13 + P-14 shipped; C-6 folded in"
```

---

## Self-review notes (already applied)

- Spec §4.1's engine also serves `/tables/export` unchanged → Task 4 pins byte-identical behavior via the pre-refactor suites, run before AND after.
- Spec §5.3 (preview for entries) lands via `EntryLayoutDialog`'s `previewDefinition` → `previewTableJson({definition: applyEntryOverrides(...)})` — Task 12 Step 2.
- Spec's aggregate-202 FIX-B stance → Task 7 Step 3 (`computing` wins over `failed`) with best-effort route-level test in Step 4.
- Type-consistency check: `run_table_export` keyword signature (Task 4) matches both call sites (Tasks 4, 7); `ExportEntry` field names identical across Python (Task 3), zod (Task 10), and state module (Task 11); `archive` flag produced in Task 5, consumed in Task 7.
- No task references `db` inside the engine — resolution stays in the routes (verified against `_resolve_table`'s signature).
