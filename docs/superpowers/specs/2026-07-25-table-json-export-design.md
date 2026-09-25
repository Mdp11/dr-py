# Custom JSON export of tables

Date: 2026-07-25

## Problem

Tables export to `.xlsx` only. A spreadsheet is the wrong shape for feeding a
table into a script, a pipeline, or another tool, and it is especially wrong for
tables that use `expand` columns: expansion multiplies rows, so a subsystem with
four components becomes four nearly-identical rows whose only difference is one
cell. The natural JSON for that is one object with a four-element array.

## Goal

Export a table as JSON, defaulting to one row -> one object, keys from column
headers, values in their native types. On top of that default, two customizations:

1. override the key name per column;
2. group an `expand` column back up so one key carries many values.

Everything beyond that is deliberately out of scope (see "Out of scope").

## Decisions

| Question | Decision |
|---|---|
| Grouping output shape | Nested array of objects, unwrapped to an array of scalars when the group holds only the grouped column |
| Where the config lives | On each column, in the saved table definition |
| Element references | Display name by default; per-column override to id or `{id, name, type}` |
| Failed / uncomputed cells | `{"$error": "..."}` in place of the value |
| Document shapes | Bare JSON array only |
| UI | A "JSON export" tab in the table Settings dialog; the Export button becomes an Excel/JSON dropdown |
| Default key | Header verbatim, auto-deduped, with a "snake_case all" button |
| Backend wiring | A `format` field on the existing `POST /tables/export` |

Two of these deserve their reasoning recorded.

**Config on the column, not on the table.** An earlier sketch put the config on
`TableDefinition` as index-keyed maps (`keys: {3: "mass_kg"}, groups: [2]`).
Column indices move under reorder, insert, and remove — the codebase already
carries `remapTableSortForRemove/Move/Insert` to keep a *single* index valid
across those edits, and a whole map would need the same treatment. Storing the
settings on the column makes every one of those edits free.

**A `format` field, not a second route.** The whole-table preamble in
`export_table` — resolve the definition, validate the sort, open a cache-only
script context, run the completeness probe, and decide 202-vs-ship — is the
subtlest logic in `routes/tables.py`. Both formats need it identically. A
`format` field keeps it in exactly one place; `/tables/export` is already in
`authz._READ_ONLY_POST_SUFFIXES`, and the frontend's existing retry loop is
parameterized rather than duplicated.

## Schema

`core/table/schema.py`, purely additive:

```python
class JsonColumnOptions(BaseModel):
    key:   str = ""                                   # "" = derive from header
    value: Literal["name", "id", "object"] = "name"   # element rendering
    group: bool = False                               # roll this expand column back up
```

Each of `ElementColumn`, `PropertyColumn`, `NavigationColumn`, and `ScriptColumn`
gains:

```python
json_export: JsonColumnOptions | None = None
```

`None` means "all defaults", so saved payloads stay clean. The field is named
`json_export` rather than `json` because pydantic v2 still carries a deprecated
`.json()` method that a field of that name would collide with.

`SCHEMA_VERSION` stays `1`. Nothing enforces equality on it, and every added
field is optional, so existing saved tables parse unchanged.

## Grouping

No value comparison anywhere. Grouping is slot arithmetic over the `RowKey`
tuples the evaluator already produces: a row key is the row source's base slots
followed by one slot per `expand` column, in column order, and
`_expand_slot_of(defn, base_slots, k)` already names the slot for column `k`.

### Dependency rule

`deps(j)` is the transitive set of column indices reachable from column `j`
through `ColumnRef.source`. Column `j` is *owned by* grouped column `k` when
`k ∈ deps(j)`; when several grouped columns qualify, the **innermost** (largest
index) wins. A grouped `k2` nests inside a grouped `k1` iff `k1 ∈ deps(k2)`.
Columns owned by nobody sit at the top level.

### Algorithm

1. `grouped_slots = { _expand_slot_of(defn, base_slots, k) for each grouped k }`.
2. Top-level objects are the rows partitioned by the tuple of **all slots not in
   `grouped_slots`**, merged into a dict keyed on that tuple. A dict preserves
   first-appearance order, which matters because a sort can leave one group's
   rows non-contiguous.
3. Within an object, each top-level grouped `k` partitions that object's rows
   again by `key[slot(k)]`, dropping `None` slots. The members of `k`'s group are
   `{k}` plus the columns owned by `k`. Members-is-just-`{k}` emits an array of
   scalars; otherwise an array of objects. Recurse for nested grouped columns.

### Worked example

Row source `Subsystem`; columns `Name` (property), `Component` (navigation,
expand), `Component Mass` (property sourced from `Component`).

Ungrouped — two rows, two objects:

```json
[
  {"Name": "Propulsion", "Component": "Thruster A", "Component Mass": 12},
  {"Name": "Propulsion", "Component": "Thruster B", "Component Mass": 9}
]
```

Grouped on `Component` — `Component Mass` depends on it, so both nest:

```json
[
  {
    "Name": "Propulsion",
    "Component": [
      {"Component": "Thruster A", "Component Mass": 12},
      {"Component": "Thruster B", "Component Mass": 9}
    ]
  }
]
```

Same table without the `Component Mass` column — the group holds only the
grouped column, so it unwraps:

```json
[{"Name": "Propulsion", "Component": ["Thruster A", "Thruster B"]}]
```

### Consequences

- The top-level array is **shorter than the grid's row count** whenever anything
  is grouped.
- An `expand` column with `keep_empty=True` and nothing to expand yields `[]`,
  never `[null]`.
- With `keep_empty=False` the parent row is filtered out upstream and simply does
  not appear, exactly as in the grid and the xlsx export.
- Array order follows export row order, i.e. the requested sort.

### Eligibility

`group: true` is honored only on a **visible expand** column. On a collapse,
hidden, or since-deleted column it is ignored rather than rejected — the same
tolerant-evaluation stance as `NavigationSource`'s unconfigured `{}` source. The
column editor can flip `expand` -> `collapse` at any moment, and a 422 there
would block exporting the whole table over a stale flag. The Settings tab only
renders the checkbox where it is eligible, so the state is normally unreachable.

Hidden `expand` columns are otherwise left alone: they still multiply rows, just
as they do in the xlsx export.

## Serialization

### Keys

Computed once per export, over the visible columns in order:

1. `json_export.key`, if non-empty;
2. else `header`;
3. else `"<kind>_<index>"` (e.g. `property_3`), using the column's own index.

On collision the first occurrence keeps the name and later ones get `_2`, `_3`,
and so on. The map is **global**, not per nesting level, so a column has the same
key wherever it appears in the document.

"snake_case all" is frontend-only: it rewrites every column's `json_export.key`
in the draft definition. The backend has no notion of slugification.

### Cells

| Cell | JSON |
|---|---|
| `ValueCell(present=False)` | `null` — the element's type does not declare the property |
| `ValueCell(present=True)` | `value` verbatim: already a native scalar, or a list for a multi-valued property |
| `ValuesCell` | array of the values, **always** an array, length 1 included |
| `ElementCell` | `null` when the slot is empty, else rendered per `json_export.value` |
| `ElementsCell` | array of rendered elements, `[]` when nothing was reached |
| `ErrorCell` | `{"$error": message}` |
| `PendingCell` | `{"$error": "not computed"}` |

`PendingCell` reuses the existing `NOT_COMPUTED_MESSAGE` constant so its wording
matches the xlsx cell and the script-errors recap. The constant currently lives
in `api/routes/tables.py`, which core cannot import; it moves to
`core/table/cells.py` beside `PendingCell` and the route imports it from there,
leaving its single existing use site working unchanged.

Row keys are hashable — every `Binding` variant is a scalar or the frozen
`PropertyValue` — so grouping can partition on them via plain dicts. When no
column is grouped, the renderer skips bucketing entirely and emits one object per
row: two rows can in principle carry equal keys, and bucketing them would
silently merge rows the xlsx export renders separately.

Element rendering by `json_export.value`:

- `"name"` — `display_name(el)`
- `"id"` — `el.id`
- `"object"` — `{"id": el.id, "name": display_name(el), "type": el.type_name}`

A dangling id — a cell referencing an element deleted since evaluation — renders
`{"$error": "unknown element <id>"}` rather than raising, matching how the xlsx
path tolerates the same case.

### Document

A bare JSON array; `[]` for zero rows. UTF-8, `ensure_ascii=False`, `indent=2` —
this is a human-facing download, and the size cost is acceptable within the
existing 50 000-row ceiling.

Keys are always present; an empty cell is `null`. There is deliberately no "omit
empty keys" toggle. `show_row_numbers` is ignored — it is a grid and spreadsheet
affordance, and an array index already numbers the rows. Hidden columns are
excluded, exactly as in xlsx.

### Response

`application/json`, `Content-Disposition: attachment; filename="<name>.json"`,
and the same `X-Table-Truncated` / `X-Table-Script-Errors` headers the xlsx path
sets. There is no JSON equivalent of the xlsx trailing notice row: the `$error`
markers are in-band and the header carries the summary.

### Memory

Grouping cannot stream — groups merge by dict, and a sort can scatter one group's
rows across the whole result. Rows still arrive chunk-by-chunk from
`iter_export_rows`, but the assembled document is held whole. This is the same
trade the xlsx path already made when it gave up `constant_memory` for
`autofit`, and it is bounded by the same `TableLimits.max_rows`.

## Components

### `core/table/json_export.py` (new)

Pure over `(model, definition, row keys, cells)`. No API imports — the xlsx
writer lives in the API layer only because core stays xlsx-free, and JSON needs
no dependency at all.

- `resolve_json_keys(defn) -> list[str | None]` — the global key map, `None` for
  hidden columns.
- `build_group_plan(defn) -> GroupPlan` — deps, ownership, nesting order, slot
  indices. Computed once and reused for every row.
- `render_json(model, defn, row_keys, row_iter, base_slots) -> list[dict]` — the
  algorithm above. `row_keys` are the evaluator's `RowKey` tuples, not the JSON
  keys `resolve_json_keys` produces; the two are never mixed.

`base_slots` is `1` for scope and navigation row sources and the chain length for
a chains row source; `_row_source_base_slots` already computes it, and it is
equally derivable from a full key as `len(key) - <number of expand columns>`.

### `api/schemas.py`

`ExportTableIn(EvaluateTableIn)` adding `format: Literal["xlsx", "json"] =
"xlsx"`. Subclassing keeps every existing client byte-compatible.

### `api/routes/tables.py`

`export_table` takes `ExportTableIn` and branches only at its final render step —
media type, filename extension, and `build_workbook` vs `render_json`. The
preamble, completeness probe, and 202 decision table are untouched.

New `POST /tables/json-preview`, read-only and added to
`authz._READ_ONLY_POST_SUFFIXES`. It exists so the Settings tab's live sample
runs through the *same* `render_json` as the export, instead of a TypeScript
reimplementation of the grouping algorithm that would drift from core. It is
bounded and never kicks a sweep: build rows, take the first 200, render
cache-only, then **drop the final top-level object unless the row set was
exhausted** — the last group may be cut mid-way, every earlier one is complete.
When dropping would empty the sample (a single group wider than the window) the
object is kept instead: an approximate sample beats a blank pane. Returns
`{sample: str, truncated: bool}`, where `truncated` is true whenever the window
did not cover the whole table, so the pane can label the sample honestly.

Key order within an object follows **column order**, with a grouped column's
array appearing at that column's own position.

### Frontend

- `api/types.ts` — a `JsonColumnOptions` zod schema, added to all four column
  types.
- `api/tables.ts`, `state/table-editor.svelte.ts` — `format` threaded through
  `exportTable` and `downloadTable`. The retry loop, abort handling, and
  filename parsing are already format-agnostic.
- `components/Table/TableView.svelte` — the Export button becomes a dropdown
  (Excel `.xlsx` / JSON `.json`); the Settings dialog gains a two-tab strip
  (Columns / JSON export).
- `components/Table/JsonExportEditor.svelte` (new) — one row per visible column:
  key input, value select (only on element-producing columns), group checkbox
  (only on expand columns), a "snake_case all" button, and the preview pane.

Editing happens in the Settings dialog, which mutates the draft definition. An
unsaved tweak still exports correctly because the frontend already sends the
draft definition inline when it is dirty; saving the table persists it.

## Testing

`tests/table/test_json_export.py` carries the bulk of it, since the interesting
logic is pure:

- key derivation: blank header, duplicate headers, explicit override, hidden
  columns excluded from the map;
- every cell kind, including both `$error` markers;
- the three element modes and the dangling-id case;
- grouping: none; a single group unwrapped to scalars; a single group nested; two
  independent groups; nested groups; `keep_empty` yielding `[]`; a group whose
  rows are non-contiguous after a sort; and `group: true` ignored on a collapse
  or hidden column.

`tests/api/test_table_export_json.py`:

- content type and filename;
- `X-Table-Truncated`;
- script errors landing as `$error` plus `X-Table-Script-Errors`;
- the 202 retry path behaving identically under `format: "json"`;
- viewer access;
- the preview route's drop-the-last-group rule.

Frontend vitest: dropdown wiring, the editor mutating the draft definition,
"snake_case all", and eligibility gating on the group checkbox.

## Out of scope

Additive later, none of them blocked by anything here:

- envelope and NDJSON document shapes;
- an "omit empty keys" toggle;
- dotted key paths for arbitrary nesting;
- JSON *import*.
