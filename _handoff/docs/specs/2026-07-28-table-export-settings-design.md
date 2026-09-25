# Table export settings dialog

Date: 2026-07-28

## Problem

`Export ▾` downloads immediately. Everything that shapes the file — which
columns appear, in what order, under what names, whether row numbers are in it —
is either fixed or borrowed from grid presentation state:

- **Columns included.** The xlsx export ships exactly the columns that are
  visible in the grid (`hidden` filters both). A column you keep hidden while
  working is unexportable without unhiding it; a column you want on screen but
  not in the file is unexcludable without hiding it.
- **Order.** Export order is definition order, which is grid order. Reordering
  for the file means reordering the grid — and column order is load-bearing
  (`ColumnRef` is backward-only, expand slots are positional), so it is not a
  free edit.
- **Names.** xlsx headers are `col.header`, the grid header. Renaming for the
  file renames the column on screen. JSON already has a separate per-column
  `key`, which is exactly the escape hatch xlsx lacks.
- **Row numbers.** `show_row_numbers` drives the grid and the xlsx export from
  one flag. You cannot have the "#" column on screen but not in the file.

The JSON side already has per-column settings, but they live in a tab of the
**table Settings** dialog — a surface about composing the table, not about
producing a file — and there is no equivalent for xlsx at all.

## Goal

Both export menu items open a modal that shows what the file will contain and
lets it be adjusted before download: include/exclude (including grid-hidden
columns), reorder, rename, and — for JSON — the existing key/item-key/value/
group settings with their live preview.

The adjustments are **export overrides**: they change the file and never the
grid. They are **persisted with the table**, so a table exported the same way
every week is configured once.

## Decisions

| Question | Decision |
|---|---|
| What the modal edits | A separate export-override block on the table definition; the grid is never touched |
| Persistence | Saved with the table (edits mark the draft dirty; `Save` persists) |
| Rename field | xlsx gets its own header override; JSON keeps its existing `json_export.key`. Never two rename boxes on one row |
| Include + order | **Shared** across formats; only the rename and the JSON extras are per-format |
| Row numbers | No separate toggle. When `show_row_numbers` is on, a row-number entry appears **in the column list** — draggable, renameable, excludable like any other |
| Trigger | The `Export ▾` dropdown keeps both items; picking one opens the modal in that format, with a format switch inside |
| The Settings dialog's "JSON export" tab | Removed. Export settings have one home |
| Evaluation | Untouched. No suspension machinery, no cache-key change |

Three of these deserve their reasoning recorded.

**Overrides, not a shortcut into the column editor.** The alternative — the
modal edits `header`/`hidden`/column order directly — is far less code, and
wrong. Every one of those fields means something on screen, and two of them
(order, and the `hidden` flag's interaction with `ColumnRef`) are structural.
"Rename this for the spreadsheet" must not be a structural edit.

**Tri-state defaults, so nothing migrates.** `include` is `bool | None` with
`None` meaning *follow `hidden`*, and `export_order` is empty-means-definition-
order. Every table that exists today therefore exports byte-identically until
someone opens the modal and changes something. There is no migration step and
no schema-version bump.

**An export-effective definition, rather than threading overrides through
`json_export.py`.** `resolve_json_keys`, `_honors_group`, and
`build_group_plan` all consult `col.hidden`, and the group plan's nesting
("nest any column that transitively sources this one") is derived from it.
Threading an include-set through all three would duplicate that logic. Instead
the route `model_copy`s the definition with `hidden = not included` and the
header override applied, and passes **that** to the render step only. All the
existing hidden-column logic is reused unchanged.

## Schema

`core/table/schema.py`, purely additive.

```python
class ColumnExportOptions(BaseModel):
    """Per-column export overrides. Presentation-only, like `json_export`:
    never consulted during evaluation."""
    #: None = follow `hidden` (a grid-hidden column is excluded by default,
    #: and can be opted back IN here without unhiding it in the grid).
    include: bool | None = None
    #: xlsx header override. "" = today's `header or kind`. JSON has its own
    #: rename in `json_export.key` and ignores this.
    header: str = ""
```

Added to each of `ElementColumn` / `PropertyColumn` / `NavigationColumn` /
`ScriptColumn` as `export: ColumnExportOptions | None = None`, exactly
alongside `json_export` and for the same reason: settings attached to the
column travel with it across reorder, insert, and remove for free.

```python
class RowNumberExportOptions(BaseModel):
    """Export overrides for the row-number pseudo-column. Lives on the
    definition because there is no `Column` to hang it off."""
    include: bool = True
    header: str = ""   # "" -> "#"          (xlsx)
    key: str = ""      # "" -> "row_number" (JSON)
```

On `TableDefinition`:

```python
#: Output order for the export, as definition column indices, with -1
#: standing for the row-number pseudo-column. [] = definition order. NOT an
#: evaluation order: column order is structural (backward-only ColumnRef,
#: positional expand slots) and is never permuted. This reorders the OUTPUT.
export_order: list[int] = []
export_row_number: RowNumberExportOptions | None = None
```

`export_order` is **normalized defensively on read**, never validated into a
422: drop out-of-range and duplicate entries, drop `-1` when
`show_row_numbers` is off, then append any definition index that is missing
(and prepend `-1` if it is missing and row numbers are on — that is where the
"#" column sits today). A stale list left behind by a column insert or remove
therefore degrades to a sensible order instead of blocking the export. The
frontend still remaps it properly on move/insert/remove, mirroring the existing
`remapTableSortForMove/Insert/Remove` helpers; the normalizer is the safety
net, not the mechanism.

## Backend

### The export-effective definition

`routes/tables.py::export_table` gains one helper — call it
`_export_effective(defn)` — returning `(effective_defn, order)`:

- `effective_defn` is `defn.model_copy` with, per column, `hidden = not
  included` and `header = export.header or header`;
- `order` is the normalized `export_order` with excluded entries removed.

**The effective definition is used only for the render step** — headers,
`build_workbook`, `render_json`, `build_group_plan`. Evaluation
(`iter_export_rows`, `build_rows`, the script context, `TableOrderCache`)
keeps the **original** definition, so cell values, row order, and every script
cache key are bit-for-bit what they are today. This is the rule that keeps the
change contained; violating it would make the script cell cache depend on
export presentation.

Note that export settings are part of the saved definition and therefore of
`TableOrderCache`'s fingerprint, so editing them invalidates a cached row
order. That is a cosmetic extra build on the next export, not a correctness
issue, and is not worth a carve-out in the fingerprint.

### xlsx

`table_export.py::build_workbook`'s `row_numbers: bool` becomes
`row_number_col: int | None` — a **position** among the output columns rather
than a prepend flag. The `#` header is supplied by the caller inside `headers`
at that index; the row loop writes `write_number(r, col, r)` when it reaches
that column and pulls the next cell from the row otherwise. `autofilter`,
`autofit`, and the trailing notice row are unaffected.

The route's `visible` list becomes the **ordered, included** definition-index
list (`-1` filtered out and remembered as `row_number_col`), which the existing
header list comprehension and row-slicing generator already consume.

### JSON

`core/table/json_export.py::render_json` gains two keyword arguments:

- `order: Sequence[int] | None = None` — a **rank list indexed by definition
  column index** (the inverse permutation of `export_order`), not the order
  list itself, so the lookup in the hot render loop is a subscript.
  `_render_level`'s `sorted([*columns, *groups])` becomes sorted by that rank,
  so a grouped column's array still sits at its own position, just its
  **export** position. `None` keeps definition order.
- `row_number: tuple[int, str] | None = None` — `(rank, key)`. Emitted in
  **top-level objects only**, at its rank position, as the 1-based index of the
  object in the output list. Inside a grouped array the concept has no
  referent, so it is not emitted there.

`resolve_json_keys`' existing dedup runs over the effective definition, so an
excluded column consumes no name — the same rule hidden columns already follow.

**Behaviour change worth stating:** JSON export has never emitted row numbers.
A table that already has `show_row_numbers` on will now get a `row_number` key
in its JSON output, because the row-number entry defaults to included and
include is shared across formats. This is deliberate — the alternative is a
format-specific default that makes the shared column list lie — and it is one
click to turn off in the modal. The JSON export is three days old, so the blast
radius is negligible.

### Wire

Nothing new. The settings ride on the definition, so `ExportTableIn` is
unchanged and `POST /tables/json-preview` — which also takes a definition —
honors order, inclusion, renames, and row numbers for free. That last point is
the whole reason the preview exists: it must show what the download produces.

## Frontend

### The dialog

New `components/Table/ExportDialog.svelte`, opened by the existing
`DropdownMenu.Item`s (`table-export-xlsx` / `table-export-json` keep their test
ids) with a preselected format. A segmented control at the top switches format
in place; the footer is `Cancel` / `Export`, and `Export` runs today's
`downloadTable(tabId, { format })` unchanged — including its 202 retry loop and
progress reporting, which stay on the chrome button.

**One unified column list**, not a shared list plus a JSON table. Each row is a
drag handle, an eye toggle, a name field, and the format's extras:

| format | name field | extras |
|---|---|---|
| `xlsx` | `export.header` (placeholder = current grid header) | — |
| `json` | `json_export.key` (placeholder = derived key) | item key (grouped only), value `name`/`id`/`object`, group checkbox |

Grid-hidden columns appear in the list with the eye off and the row dimmed, and
can be opted in. The row-number entry appears at its `export_order` position
whenever `show_row_numbers` is on, with the same three controls and no extras.
`snake_case all` and the live preview stay, JSON-only.

Reorder reuses `table/column-dnd.svelte.ts` (`createColumnDrag`) — the same
interaction as the Settings dialog's column cards, so the gesture is already
familiar and already tested.

### State

The dialog edits the draft definition through `updateTableDefinition`, which
marks it dirty; `Save` in the chrome persists. `Cancel` reverts from a snapshot
of the definition taken when the dialog opens.

No evaluation-suspension machinery (`suspendTableEvaluation` and friends). That
exists because the Settings dialog can leave a half-edited definition that must
not be evaluated; **nothing** in the export dialog affects evaluation, so a
mid-edit re-evaluation is harmless.

New helpers in `table/columns.ts`, alongside `setColumnJsonOptions`:

- `setColumnExportOptions(defn, index, patch)`
- `setRowNumberExportOptions(defn, patch)`
- `exportEntries(defn)` — the normalized, ordered list the dialog renders
  (definition indices plus `-1`), the client-side mirror of the backend
  normalizer
- `moveExportEntry(defn, from, to)`
- `remapExportOrderForMove/Insert/Remove(defn, …)`, called from the same places
  `remapTableSortFor*` already are

### Removed

The Settings dialog's `JSON export` tab, its `settingsTab` state, and the
tab strip that exists only to host it. `JsonExportEditor.svelte` is folded into
`ExportDialog.svelte` (its preview effect and `previewTableJson` call move
across verbatim); `__tests__/JsonExportEditor.test.ts` is rewritten against the
dialog.

## Testing

**Core** (`tests/table/`): `export_order` normalization (out-of-range,
duplicate, missing, `-1` with the flag off); `render_json` honoring order,
inclusion of a hidden column, exclusion of a visible one, and the row-number
key at a non-first position; a grouped column reordered so its array is not
last; row numbers absent inside group arrays.

**API** (`tests/api/`): xlsx column order and header overrides land in the
sheet; an opted-in hidden column exports; an opted-out visible one does not;
`row_number_col` at a middle position numbers correctly and the autofilter
range still spans every column; JSON parity for the same definition; a
definition with no export settings produces a byte-identical file to before
(the no-migration guarantee, asserted rather than assumed).

**Frontend** (`vitest`): reorder/toggle/rename produce the expected definition
patches; the row-number entry appears only when `show_row_numbers` is on;
Cancel restores the snapshot; the preview request carries the overrides; the
Settings dialog no longer offers a JSON tab.

## Out of scope

- Per-format include/order. One selection, both formats.
- Export presets (several saved configurations per table).
- Renaming the xlsx sheet, or multi-sheet output.
- Column formatting (widths, number formats, colors) — the export still
  autofits and deliberately ignores `width_px`.
- Any change to the 202/retry export protocol or to the script sweep.
