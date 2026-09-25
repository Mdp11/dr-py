# Table & Panel Polish Pack — Design

**Date:** 2026-07-24
**Status:** Approved
**Scope:** Five small, independent table/panel improvements (session-5 checklist items 7–11).

Each item ships independently; nothing here depends on another item except that
item 10's export column rides on item 11's rewritten workbook builder.

---

## Item 7 — Cancel/Save semantics for the table settings dialog

### Problem

Every edit made in the table settings dialog (`ColumnManager` inside
`TableView`'s `Dialog.Root`) mutates the draft definition immediately. The
dialog's x/Escape/overlay close just resumes evaluation. In particular, the
header "+" flow (`addColumnFromHeader` in `TableView.svelte`) appends a blank
column *before* opening the dialog — so closing with x still leaves the new
column behind.

### Design

Snapshot-on-open, restore-on-cancel:

- **Snapshot:** when the dialog opens, store a reference to the current
  `TableDefinition`. The mutators in `frontend/src/lib/table/columns.ts` are
  copy-on-write, so the pre-open object is immutable from the dialog's
  perspective and serves as the snapshot with no cloning.
- **Ordering constraint:** `addColumnFromHeader` takes the snapshot **before**
  appending the blank column, so Cancel discards that column.
- **Footer:** the dialog gains a `Dialog.Footer` (pattern from
  `ApplyCrDialog.svelte`) with ghost **Cancel** and primary **Save** buttons.
- **Save** = current close behavior: keep all edits, `resumeTableEvaluation`.
- **Cancel** (and x, Escape, overlay click — all routes through
  `onOpenChange`) = `updateTableDefinition(tabId, snapshot)` to restore, then
  `resumeTableEvaluation`. If the current definition is reference-identical to
  the snapshot (no edits were made), skip the restore so the draft's `dirty`
  flag is not set spuriously.
- Embedded navigation-draft edits made from inside the dialog flow into the
  column's inline `definition` via `updateTableDefinition`, so the snapshot
  restore covers them. The implementation must verify the embedded
  navigation-editor draft store is re-synced (or discarded) on cancel so stale
  embedded drafts don't resurrect reverted edits.

**Naming note:** the dialog's "Save" applies edits to the *draft*; the tab's
own Save (persisting the table artifact) is unchanged and the tab stays dirty
until used. Button label is "Save" per user request ("Apply" was offered as an
alternative and declined by default).

### Tests

- Cancel after renaming/adding/reordering restores the pre-open definition.
- Header "+" → Cancel leaves the column list unchanged.
- Save keeps edits and triggers exactly one resumed evaluation.
- No-edit close does not mark the draft dirty.
- Existing `ColumnManager.collapse.test.ts` durability expectations still hold.

---

## Item 8 — Clone-column button in table settings

### Design

- Each column row in `ColumnManager` gets a copy-icon button next to Remove.
- Clicking it inserts a deep copy **immediately after the original** and moves
  focus to the clone. Header becomes `"<original header> (copy)"` (empty
  header stays empty — the grid already falls back to the column kind).
- New pure helper `cloneColumn(defn, index)` in
  `frontend/src/lib/table/columns.ts`:
  - Deep-copies the column via a plain-JSON copy (`JSON.parse(JSON.stringify)`
    of a `$state.snapshot`), deliberately avoiding the documented
    `structuredClone`-on-proxy trap (see `columns.ts` module doc). Inline
    `navigation.definition` and `snippet.definition` payloads are fully copied
    — no shared references between original and clone.
  - Shifts later columns' `ColumnRef.index` values **up by one** for refs
    pointing past the insertion point (mirror of `removeColumn`'s shift-down).
    Refs pointing *at* the original keep pointing at the original; the clone's
    own backward-pointing source ref remains valid unchanged.

### Tests

- `columns.ts` unit tests: clone with inline nav definition shares no
  references; ref-shift correctness for refs before/at/after the clone point.
- `ColumnManager` interaction test: clone button inserts adjacent copy with
  "(copy)" header and focuses it.

---

## Item 9 — Collapse snippet editors in navigation/table column editing

### Design

- `frontend/src/lib/components/Snippet/SnippetSourceEditor.svelte` — the one
  shared component embedded by `Table/ScriptColumnEditor.svelte` and
  `Navigation/ScriptStepRow.svelte` — gains a disclosure header in the style
  of `PathCard`'s chevron toggle (`ChevronRight`/`ChevronDown`,
  `aria-expanded`, `data-testid`).
- **Collapsed by default.** Collapsed state shows a one-line summary: the
  referenced snippet's name for ref mode, or `entry` + the first non-empty
  code line for inline mode.
- Expanding reveals the current full UI (ref/inline toggle, code editor, lint
  warnings, test panel).
- **Durability:** expansion state must survive re-renders caused by other
  edits in the dialog while the tab is open (the same guarantee
  `ColumnManager.collapse.test.ts` enforces for path cards). Follow the
  store-backed `PathCard` pattern (`isCardCollapsed`/`setCardCollapsed` in
  `navigation-editor.svelte.ts`) unless component-local `$state` provably
  survives the `{#each}` re-render — the regression test decides.
- The standalone snippet workspace tab (`SnippetTab`) is untouched.

### Tests

- Snippet editor renders collapsed by default in both embedding contexts.
- Expanded state persists across an unrelated definition edit.
- Summary line shows ref name / entry + first code line.

---

## Item 10 — Optional row-number first column

### Design

- New optional field `show_row_numbers: bool = false` on the table definition
  (frontend `TableDefinition` type + backend pydantic schema). Absent on
  existing saved artifacts → defaults off; fully backward compatible.
- Toggle checkbox **"Show row numbers"** in the table settings dialog (above
  the column list in `ColumnManager`).
- **Grid:** when on, `TableGrid` renders a leading muted "#" gutter column
  showing the 1-based, post-sort absolute row index (already available as
  `win.start + i`). It is *not* a column definition: `ColumnRef` indexes,
  reorder, hide, and the settings column list are unaffected.
- **Export:** when on, the workbook builder prepends a "#" header and 1-based
  row number to every row (numbering follows export row order, which matches
  the current sort). Rides on item 11's builder.

### Tests

- Frontend: toggle renders/removes the gutter; numbers reflect window offset.
- Backend: export with the flag on has "#" first header and sequential
  numbers; flag off is byte-identical behavior to today.

---

## Item 11 — Excel export: autofit, borders, header filters

### Decision record

- openpyxl has **no working autofit** (`ColumnDimension.auto_size`/`bestFit`
  is ignored by Excel) and its write-only streaming mode cannot set widths
  after rows are written.
- xlsxwriter ships `worksheet.autofit(max_width)` with real font-metric width
  tables, but explicitly refuses to run in `constant_memory` mode (verified in
  source: warns and returns), so buffering the workbook in memory is inherent
  to autofit regardless of library.
- **Chosen:** migrate the export to **xlsxwriter** in normal in-memory mode.
  The bounded-peak-memory streaming property of the old write-only builder is
  consciously traded away for the export path. `iter_export_rows` still feeds
  the builder chunk-by-chunk (unchanged); xlsxwriter accumulates internally.

### Design

Rewrite `build_workbook` in `src/data_rover/api/table_export.py`:

- **Workbook:** `xlsxwriter.Workbook(buf, {"in_memory": True})` writing to a
  `BytesIO`; route contract (bytes of an .xlsx, 202/Retry-After behavior,
  CACHE-ONLY stance, `#ERROR` rendering, truncation-notice trailing row) is
  unchanged.
- **Header row:** bold, heavier bottom border, freeze panes at A2 (as today),
  plus `worksheet.autofilter(0, 0, last_row, last_col)` for header dropdowns.
- **Data cells:** thin borders via a shared xlsxwriter `Format`.
- **Autofit:** `worksheet.autofit(max_width=300)` (pixels) after all rows are
  written. Definition `width_px` values no longer influence the export —
  autofit always wins. On-screen widths still use `width_px`.
- **Row numbers:** honors item 10's flag (prepend "#" column).
- **Dependency:** add `xlsxwriter` to the api feature in `pixi.toml` (and
  thereby core-dev). openpyxl remains a dependency of the test suite, which
  keeps reading workbooks back with it (xlsxwriter is write-only).

### Tests

`tests/api/test_table_export.py` — existing assertions (headers, rows,
truncation notice, cell-cap regression) must pass against the new builder;
new assertions: autofilter range present, header bold + borders, data-cell
borders, column widths set (non-default), row-number column per item 10.

---

## Out of scope

- Any change to `/tables/evaluate`, the sweep, or the script cell cache.
- Streaming/low-memory export mode (removed trade-off is accepted).
- Relabeling the tab-level Save; change-password-style UI concerns; export
  formats other than xlsx.
