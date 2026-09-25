# Table Settings Popup — UX Refactor

**Date:** 2026-07-13
**Area:** frontend (`src/lib/components/Table/`)
**Status:** design approved, spec under review

## Problem

Today `TableView.svelte` stacks three things vertically:

1. A slim chrome bar (name input · dirty dot · Export · Save · Save as).
2. The **`ColumnManager`** settings panel — row-source editor + a variable-length
   list of columns, each with an expandable per-column sub-editor
   (`NavigationColumnEditor`, `PropertyColumnEditor`) + add-column buttons.
3. `TableGrid`, squeezed into the remaining `flex-1`.

`ColumnManager` is tall and grows with the number of columns, so it permanently
subtracts vertical space from the grid. The result: the settings dominate the
top and the actual table is a small strip at the bottom.

## Goal

Give the grid the entire area by default. Move the definition-editing settings
behind a button that opens them in a popup, so settings only occupy space when
the user explicitly asks for them.

## Chosen approach

A **large centered modal** built on the existing `Dialog` primitive
(`$lib/components/ui/dialog`).

### Why a centered modal (not a side sheet)

- **Settings are big and complex.** A row-source editor plus a growing list of
  columns, each with its own dense sub-editor, needs both width and height. A
  centered modal can be wide (`max-w-3xl`) and tall (`max-h-[85vh]`) with an
  internally scrolling body. A narrow right-side sheet would force the already
  dense column rows to wrap awkwardly.
- **Codebase consistency + least code.** The repo's existing "drawers"
  (`HistoryDrawer`, `SwapMetamodelDrawer`) are in fact centered modals:
  `dialog-content.svelte` hardwires `fixed top-1/2 left-1/2 -translate-*` and
  each caller just widens it with `max-w-*`. A genuine side sheet would mean
  fighting that shared positioning or writing a new component, for little gain.
- **Live preview is not a requirement.** A modal gives up watching the grid
  update while editing, but for editing a *whole table definition* (as opposed
  to tweaking one cell), edit-then-review-on-close is natural. Edits still apply
  immediately to state, so the grid reflects them the moment the modal closes.

## Design

### Layout

`TableView.svelte` becomes two rows inside its `flex h-full flex-col` root:

1. **Slim top bar** (unchanged height, one row): name input · dirty dot · a new
   **⚙ Settings** button · Export · Save · Save as. Save/Export/Save-as **stay
   in the bar** — they are frequent, primary, small actions; burying them behind
   the popup would cost a click on every save.
2. **`TableGrid`** in `min-h-0 flex-1` — full width, full remaining height.

The conflict banner and `saveError` line keep their current positions between
the top bar and the grid.

### The popup

- A `Dialog` (`bits-ui` via `$lib/components/ui/dialog`) with local open state.
- Content sized `class="max-w-3xl max-h-[85vh] overflow-y-auto"` (widen/scroll
  the shared centered content; keep its built-in close button).
- A `Dialog.Title` ("Table settings") for a11y.
- The body is the **existing `ColumnManager` component, relocated wholesale** —
  row-source editor, column list with per-column controls (rename, mode toggle,
  reorder, remove), add-column buttons, and its inline error line. No internal
  changes to `ColumnManager` beyond what's needed to sit inside the dialog (it
  currently owns a `border-b p-3` frame meant for an inline strip; the outer
  `border-b` is dropped when it lives in the modal — see Component changes).

### Access control

The **⚙ Settings button renders only when `canEdit()`** (mirrors today's
`{#if editable}` guard around `ColumnManager`). Non-editors get the full-height
table with no settings entry point; Export stays available to them. This is
strictly better than today's read-only experience (they currently see the
disabled chrome but no manager anyway).

### State

- One local `let settingsOpen = $state(false)` in `TableView`, bound to the
  `Dialog`'s `open`.
- **No changes** to `table-editor.svelte.ts`, `$lib/state`, `columns.ts`, or any
  API. Editing continues to flow through `updateTableDefinition`; the popup is a
  pure presentation relocation.

## Component changes

- **`TableView.svelte`** — remove the inline `<ColumnManager {tabId} />` block;
  add the ⚙ Settings button to the top bar (guarded by `editable`); render a
  `Dialog` containing `ColumnManager`; add `settingsOpen` state. Import the
  `Dialog` primitives.
- **`ColumnManager.svelte`** — drop the outer `border-b` (and adjust the frame
  padding/`space-y` only if needed) so it reads as modal body content rather
  than a top strip. Its logic (apply/tryApply, add/remove/move/rename, per-column
  change, `sampleRowElementId`) is unchanged. Consider whether the
  `data-testid="column-manager"` wrapper stays on the same element (it should —
  tests key off it).

## Testing

- **Existing tests** — `ColumnManager` behavior tests keep passing since its
  logic is untouched; verify the `data-testid` hooks still resolve.
- **New/updated component test** (`TableView`): the ⚙ Settings button is present
  when editable and absent when not; clicking it reveals `column-manager`;
  `column-manager` is **not** in the DOM until the button is clicked.
- **E2E** (playwright) — update the existing table-editing e2e flow
  (`82dee72` added inline nav/property/row-source e2e) to first open the settings
  popup via the ⚙ button before exercising column edits, then assert the grid
  reflects the change after closing. Keep the assertions on the resulting grid
  identical; only the path to reach the editor changes.

## Out of scope (YAGNI)

- No resizable / draggable popup.
- No true right-side sheet component.
- No live-preview-while-editing layout.
- No relocation of Save/Export/Save-as into the popup.
- No changes to the ops/state/API layers.
