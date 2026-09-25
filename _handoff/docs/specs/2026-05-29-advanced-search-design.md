# Advanced Search — Design Spec

Date: 2026-05-29
Status: Approved (ready for implementation plan)

## Summary

Add an **advanced search** feature to the frontend. A button to the right of the
existing sidebar search bar opens a modal popup where the user builds a structured
query: pick a target kind (Element **or** Relationship) and a flat list of criteria
that must **all** be satisfied (AND). Pressing **Search** runs the query against the
in-memory working model and opens a full-width, resizable, scrollable **results panel**
at the bottom of the screen (below the Sidebar / Workspace / Inspector columns, above the
StatusBar). Clicking a result selects that entity, opening its detail in the Inspector —
exactly as clicking a tree node does today. An **X** button closes the panel.

## Goals

- Structured, multi-criterion search over elements and relationships.
- Metamodel-aware, **searchable** pickers for type/property names (type to filter; no
  scrolling through long lists), reusing the existing `StereotypePicker` popover pattern.
- Results in a dockable bottom panel that is scrollable, height-resizable, and closable.
- Clicking a result opens the entity detail via the existing `select()` mechanism.

## Non-goals (YAGNI)

- No nested AND/OR groups — a single flat AND list only.
- No backend search endpoint — evaluation is client-side over the working model.
- No "both kinds at once" search — exactly one target kind per search.
- No result-history tabs — a single results panel; re-running replaces its contents.
- No persistence of results across reload (only panel height is persisted).
- No relationship source/target **id-equals** criterion (only endpoint **type**).

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Execution | Client-side over `getWorkingModel()` (includes unsaved edits) |
| Criteria logic | Flat AND list |
| Input style | Metamodel-aware searchable pickers, with free-text filter |
| Relation direction | Selectable per criterion: outgoing / incoming / either |
| Target kind | Exactly one: Element **or** Relationship (no "both") |
| Results panel | Single panel; re-running replaces contents |
| Repeated search | Reopening the dialog keeps the draft to refine |
| Closing the panel (X) | Clears results and closes the panel |
| Empty criteria list | Allowed — lists everything of the target kind |

## Existing-code findings that shape the design

- **Inspector already supports relationship selection** (`Inspector.svelte:14-18`): it
  resolves both `selection.kind === 'element'` and `'relationship'`. So
  `select({ kind, id })` opens the correct detail for both — no Inspector changes needed.
- **`Sidebar/StereotypePicker.svelte`** is a metamodel-aware searchable popover (bits-ui
  `Popover` + filter input, with `filter` and `create`/single-pick modes). Reuse this
  pattern for type-name and property-name pickers.
- **Full-width grid rows use `col-span-5`** (`TopBar.svelte:112`, `StatusBar.svelte:26`)
  in the 5-column main grid. The results panel slots in the same way.
- **State stores** under `lib/state/*.svelte.ts` use the accessor-function convention
  (`getX()` / `setX()`); new state follows suit and is re-exported from `state/index.ts`.
- **`select(s: Selection)`** in `selection.svelte.ts` is the single entry point that
  drives the Inspector detail.
- **Sidebar widths** are persisted in `routes/+page.svelte` via `localStorage` + `$effect`;
  the panel height mirrors this pattern.

## Criteria catalog

A search targets exactly one kind, chosen by a toggle at the top of the dialog. Criteria
are a flat AND list. The criteria offered depend on the selected kind. Where a criterion
references a type or property name, input is a searchable, metamodel-aware picker with a
free-text filter (and free-text fallback for values).

### Shared (both kinds)

- **Type** — entity `type_name` is any of `{names…}` (multi-select).
- **Property** — `property [name] [op] [value]`, where
  `op ∈ { equals, not equals, contains, matches (regex), >, <, >=, <=, exists, is empty }`.
  (`exists` / `is empty` ignore the value field.)
- **Name/ID** — `[name | id] [contains | matches regex | equals] value`.

### Element-only

- **Relation count** — `has [at least | at most | exactly] N relations`, direction
  `[outgoing | incoming | either]`, optionally `of type {relationship types…}`.
- **Is orphan** — element has no relations (shortcut: relation-count = 0, either direction).
- **Connected to type** — connected `[outgoing | incoming | either]` to an element whose
  type is any of `{element types…}`.

### Relationship-only

- **Endpoint type** — `[source | target]` element is of type any of `{element types…}`.

## Architecture

### Pure logic (unit-tested, TDD core)

- **`frontend/src/lib/search/types.ts`**
  - `TargetKind = 'element' | 'relationship'`.
  - `Criterion` — discriminated union (one variant per catalog entry above), each carrying
    its operator/operand fields. Each variant records which kind(s) it applies to.
  - `AdvancedQuery = { target: TargetKind; criteria: Criterion[] }`.
  - `SearchResultItem = { kind: TargetKind; id: string }`.

- **`frontend/src/lib/search/evaluate.ts`**
  - `runQuery(query: AdvancedQuery, snapshot: Snapshot): SearchResultItem[]`.
  - Builds a relationship adjacency index once per run: `Map<elementId, Relationship[]>`
    for outgoing (by `source_id`) and incoming (by `target_id`).
  - Compiles each criterion into a predicate `(entity, ctx) => boolean`; AND-combines them
    over the entities of the target kind.
  - Pure and deterministic; no Svelte/DOM dependencies.

### State

- **`frontend/src/lib/state/advanced-search.svelte.ts`** (accessor-fn convention):
  - Draft query: target kind + criteria array being edited (session-memory).
  - Dialog open flag.
  - Committed results (`SearchResultItem[]`) + the target kind they were produced for.
  - Panel open flag.
  - Re-exported from `frontend/src/lib/state/index.ts`.
  - Panel **height** is not stored here; it lives in `+page.svelte` localStorage like the
    sidebar widths.

### Components

- **`Sidebar/Search.svelte`** (modify) — add a button (sliders icon) to the right of the
  search input that opens the advanced-search dialog. Input + button laid out in a flex row.
- **`Sidebar/AdvancedSearchDialog.svelte`** (new) — modal `Dialog`:
  - Target-kind toggle (Element / Relationship). Switching kind drops criteria that no
    longer apply.
  - Criteria editor: list of `CriterionRow`s + an "Add criterion" menu listing the
    criteria valid for the current kind.
  - Footer: `Clear` (left) and `Search` (bottom-right). `Search` runs
    `runQuery(draft, getWorkingModel())`, stores results, opens the panel, closes the dialog.
    `Search` is blocked while any criterion has an invalid regex.
- **`Sidebar/CriterionRow.svelte`** (new) — renders the controls for a single criterion
  based on its discriminant; uses searchable pickers for type/property names; a remove
  button; inline validation error for bad regex.
- **`ResultsPanel.svelte`** (new) — full-width bottom panel (`col-span-5`):
  - Header: `Results (N)`, target-kind label, and an **X** close button.
  - Scrollable body of result rows. Element rows show name / type / id; relationship rows
    show type and `source → target` (resolved names). Empty-state and stale-entity handling.
  - Row click → `select({ kind, id })`.
- **`ResizeHandle.svelte`** (generalize) — add `axis: 'x' | 'y'` (default `'x'`). `'y'`
  resizes by `clientY` with a row-resize cursor; used at the panel's top edge (drag up grows).
- **`routes/+page.svelte`** (modify) — grid rows `[auto_1fr_auto]` →
  `[auto_1fr_auto_auto_auto]`. When the panel is open, render the `axis="y"` resize handle
  and `ResultsPanel` (both `col-span-5`) immediately before `StatusBar`. Panel height in
  state, persisted to `localStorage` key `ui.resultsPanelHeight` via `$effect`, mirroring
  the sidebar-width pattern.

## Data flow

1. User clicks the advanced-search button → dialog opens (store flag).
2. User edits the draft query (target kind + criteria) in the store.
3. User clicks **Search** → `runQuery(draft, getWorkingModel())` → results + target kind
   stored, panel-open = true, dialog-open = false.
4. The panel renders `SearchResultItem`s, resolving display fields from the live working
   model on each render (so it tracks edits and drops deleted entities).
5. Clicking a row → `select({ kind, id })` → Inspector shows the detail.
6. Reopening the dialog keeps the draft so the user can refine; a new **Search** replaces
   the results.
7. The panel **X** clears results and sets panel-open = false.

## Edge cases & error handling

- **Invalid regex** (property `matches`, name/id `matches`): validated as the user types;
  an inline error shows on the row and **Search** is disabled until resolved.
- **Numeric comparisons** (`>`, `<`, `>=`, `<=`): operand and property value coerced to
  number; if either is non-numeric, the criterion fails for that entity.
- **`exists` / `is empty`**: `exists` = property key present and value non-null/non-empty;
  `is empty` = absent or null/empty-string.
- **Stale result ids** (entity deleted after the search): omitted when the panel resolves
  display fields from the working model.
- **Empty criteria list**: returns all entities of the target kind; the result count makes
  the size obvious.
- **Large result sets**: panel is plainly scrollable (no virtualization in v1); acceptable
  for expected model sizes.

## Testing

- **Vitest** (`frontend/src/lib/search/__tests__/evaluate.test.ts`): one focused test per
  criterion type plus combinations — type match, property equals/contains/regex/compare/
  exists/empty, name/id, relation-count for each direction and with/without type filter,
  orphan, connected-to-type, relationship endpoint-type, and multi-criterion AND.
- **Playwright** smoke (alongside existing frontend e2e): open the dialog → add a criterion
  → Search → results panel appears → click a result opens the Inspector detail → X closes
  the panel.

## Out of scope / future ideas

- AND/OR nested groups and saved queries.
- Result-history tabs and exporting results.
- Backend-side evaluation for very large models.
- Source/target **id** criteria for relationships.
