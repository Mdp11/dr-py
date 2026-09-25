# Table column editing & inline navigation definitions — design

Date: 2026-07-13
Status: approved

## Problem

Two gaps in the Stage 2 table definition UI (`ColumnManager.svelte`):

1. **Property columns are frozen after creation.** The property name is typed
   as free text at creation time (`newPropertyName` input); afterwards only
   header, mode, order, and existence are editable. `name`, `source`, and
   `keep_empty` cannot be changed — the column must be deleted and recreated.
2. **Navigation columns can only reference a saved navigation.** The
   `NavigationSource` schema supports an inline `definition` (and the backend
   fully evaluates it, including the `RowStart` start sentinel bound per row),
   but the frontend only offers a `<select>` over saved navigation artifacts.
   Inline definition editing was deferred at Stage 2 ("Stage-2.1"); the
   original spec (2026-07-10, line ~493) called for embedding the navigation
   builder with a `RowStart` start.

## Decisions (user-approved)

- Inline navigation editing is **embedded in the column panel**, not a modal.
- Inline definitions come to **both** navigation columns and navigation/chains
  **row sources** (row sources keep `Scope` starts — no `RowStart` there).
- Property name editing uses a **searchable picker with free-text fallback**
  (reuse `Sidebar/PropertyPicker.svelte`), same control at creation and edit.
- Reuse mechanism: **Approach A — ephemeral "embedded drafts" hosted in the
  existing navigation-editor store** under synthetic ids, so
  `NavigationNode`/`PathCard`/`CombineFrame`/previews/selection/structural
  edits are reused verbatim. (Rejected: refactoring the builder tree to
  controlled `definition`+`onChange` components — large regression risk to the
  Stage 1 builder, rewrites the coupling instead of reusing it.)

## What already exists (no backend work)

- `core/navigation/schema.py` has `RowStart` (`{kind: "row"}`); `evaluate()`
  takes `row_elements` and binds it to any `RowStart`.
- `core/table/resolve.py` inlines refs transitively; `NavigationSource`
  enforces exactly-one-of `ref`/`definition`. Table core tests already use
  inline `start: {kind: "row"}` definitions.
- `POST /navigations/evaluate` accepts `row_element_id` — previews of
  row-rooted definitions against a sample element already work server-side.
- `canEdit()` (role-based) gates both `TableView` and `PathCard` — embedded
  builder inherits editability for free.

## Design

### 1. Groundwork: `RowStart` in the frontend

- `frontend/src/lib/api/types.ts`: add `RowStart` (`{kind: 'row'}`) to the
  `PathNavigation.start` union (Zod + TS type).
- `frontend/src/lib/navigation/tree.ts`: helpers handle a row start —
  `titleForPath`/`chainColumns` label the start column "Row element";
  `precedingTargetTypes` returns `[]` for it (downstream pickers fall back to
  all types).
- `PathCard.svelte`: a fourth start mode "the row's element", offered **only**
  when the hosting draft is flagged row-context. Standalone builder tabs and
  row-source embeds never show it.

### 2. Embedded drafts (`state/navigation-editor.svelte.ts`)

- New `ensureEmbeddedDraft(id, definition, {rowContext, sampleRowElementId?})`
  and a matching close path. Embedded ids use a reserved prefix (`navemb:`).
- Embedded drafts never appear in the tab strip (tabs are owned by the tabs
  store, so this is largely automatic — guard anyway) and
  `saveDraft`/`saveAsDraft` reject them. Their only output is the definition.
- Preview plumbing: when the draft carries a `sampleRowElementId`, per-node
  evaluate calls pass `row_element_id`. A row-rooted definition with no sample
  (empty table) shows a "no row to preview against" hint on the status chip
  instead of surfacing the 422.
- Draft lifecycle is owned by the embedding component: created on mount
  (seeded from the column), closed on unmount. The column's stored definition
  stays the source of truth, so column reorder/remove simply remounts.

### 3. Inline definitions in table editors

- **`NavigationColumnEditor.svelte`** gets a "Saved navigation ⇄ Defined
  inline" switch.
  - Inline mode seeds the embedded draft from, in order: the column's existing
    inline definition → a fetched copy of the currently selected saved nav
    ("customize this one") → a fresh single path with a `RowStart` start.
  - Renders `NavigationNode` with the embedded id; an `$effect` mirrors
    `draft.definition` back through the existing whole-column `onChange` as
    `navigation: {definition}`.
  - Sample element for previews: first row element of the table's current
    page 0, supplied by the editor from table state.
  - Switching inline→saved keeps the inline definition in component memory
    while the editor is mounted (toggling back doesn't lose work); only the
    active mode is written to the column.
- **`RowSourceEditor.svelte`**: same switch for `navigation`/`chains` row
  sources, `rowContext: false` (scope starts; previews need no row binding).
- Persistence: nothing new — the inline definition rides inside the table
  artifact payload; `TableDefinitionSchema` (Zod) already models
  `NavigationSource` as `{ref?, definition?}`.

### 4. Property column editor

- New **`PropertyColumnEditor.svelte`**, controlled component mirroring
  `NavigationColumnEditor`'s `{column, columnIndex, columns, onChange}`
  contract, rendered under property columns in `ColumnManager` (same
  `{#if col.kind === ...}` pattern, routed through the existing whole-column
  replacement handler).
- Editable fields: `name` (searchable `PropertyPicker` + free-text fallback),
  `source` (row slot / earlier element-producing column — same options logic
  as the nav column editor), `keep_empty`.
- Property suggestions: derived from the source's element types when knowable
  (e.g. scope row source → `effectivePropertiesForTypes` over its types);
  otherwise the union of all metamodel property names. Typed free text always
  wins.
- The "+ Property column" flow becomes add-then-edit (column created with
  empty name, edited in the panel) — the free-text quick-add input is removed.
  Affected e2e tests updated.

### 5. Testing

- **Vitest**: embedded-draft lifecycle (create/sync/close, save rejection,
  `row_element_id` threading in preview calls); `PropertyColumnEditor`
  behavior; nav-column mode switch incl. seed-from-saved-copy (MSW).
- **Playwright e2e**: edit a property column's name after creation and observe
  cell values change; define an inline navigation column and observe reached
  elements; define an inline row source.

## Out of scope

- Promoting an inline definition to a saved navigation artifact.
- Any backend/schema changes (none are needed).
- Column-level identity (columns stay index-addressed; embedded drafts are
  ephemeral so index shifts are harmless).
