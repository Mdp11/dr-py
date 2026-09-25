# View change tracking + unified save dialog

**Date:** 2026-06-16
**Branch:** `perf/large-model-overhaul`
**Scope:** frontend only (the view is fully client-held; no backend change needed)

## Problem

Today the TopBar tracks **model** changes only. That count comes from the
server-side op log (`GET /model/changes/summary`) because the model can be
~80 MB and the client never holds it whole. The **view** (`*.view.json`) — an
overlay that only references model elements by id — is small and fully held in
the browser, but it has **no change tracking at all**: it is pushed to the
backend as whole snapshots (`PUT /view/snapshot`) with no baseline and no diff.

We want to:

1. Track how many changes were made to the view since it was loaded/saved.
2. Show a single combined change count in the TopBar, with a hover tooltip
   breaking it down into `Model: x` / `View: y`.
3. Remove the standalone "Export view" button.
4. Drop the redundant `(n)` count from the TopBar "Save" button.
5. Make the Save dialog cover **both** model and view via tabs, each tab
   previewing its diff and offering its own save action. Saving the view writes
   the `.view.json` and resets the view count to 0.

## Decisions (resolved during brainstorming)

- **View-change scope:** element placements **and** folder structure changes
  count toward the View count and appear in the preview.
- **Save UI:** one dialog with **tabs** (Model / View); the footer's primary
  action is contextual to the active tab. (Not two side-by-side buttons.)
- **Reset on view save:** saving the view **rebaselines** — the View count
  resets to 0. (Note: the model count deliberately does *not* reset on save, so
  the two behave differently; this is intentional and documented in
  `changes.svelte.ts`.)

## Architecture

### 1. View-diff core — `frontend/src/lib/state/view-diff.ts` (new, pure)

A plain `.ts` module (no Svelte runes), mirroring `view-ops.ts`, so it is
directly unit-testable. It computes a **structured** diff between two views and
does **no** name resolution (callers format text).

```ts
export type ViewChange =
  | { kind: 'element-added';   id: string; to: string[] }
  | { kind: 'element-removed'; id: string; from: string[] }
  | { kind: 'element-moved';   id: string; from: string[]; to: string[] }
  | { kind: 'folder-added';    path: string[] }
  | { kind: 'folder-removed';  path: string[] };

export function diffViews(baseline: View | null, current: View | null): ViewChange[];
```

**Element placement diff** — build `Map<elementId, folderPath>` for baseline and
current (an element lives in at most one folder, per the single-folder rule).
For each id in either map:

- in baseline only ⇒ `element-removed { from }`
- in current only ⇒ `element-added { to }`
- in both, different path ⇒ `element-moved { from, to }`
- in both, same path ⇒ no change

A folder path is the array of folder names from root to the element's folder
(e.g. `['Systems', 'Power']`).

**Folder structure diff** — collect the set of all folder paths in each tree.
Report:

- path in current, not baseline ⇒ `folder-added { path }`
- path in baseline, not current ⇒ `folder-removed { path }`

…**collapsed to the shallowest distinct path**: if a folder's parent path is
itself added (resp. removed), the child is implied and suppressed, so a
rename/move of a populated folder yields a single `folder-removed` +
`folder-added` pair rather than one line per descendant.

> **Folder identity caveat.** Folders have **no stable id** in the view model —
> they are identified only by name and nesting. A folder rename or move
> therefore surfaces as a `folder-removed` + `folder-added` pair, not a
> "renamed"/"moved" line. This keeps the diff robust and counts bounded; a true
> rename/move detector would require fragile structural-signature heuristics and
> is explicitly out of scope. (Element moves are unaffected — they are keyed by
> stable element id and report "moved from X to Y" exactly.)

**Count.** `y` = `diffViews(...).length`.

### 2. Baseline state — extend `frontend/src/lib/state/view.svelte.ts`

Add a module-private `_baseline: View | null` holding a deep clone of the view
as last **loaded or saved**. New exports:

```ts
export function setViewBaseline(view: View | null): void; // clones (cloneView) or null
export function getViewChanges(): ViewChange[];           // diffViews(_baseline, _view)
export function getViewChangesCount(): number;            // getViewChanges().length
```

`getViewChanges` is computed from the existing `_view` rune and `_baseline`, so
it is reactive.

**Baseline capture points** (load or save, never on a mid-session edit):

- inside `refreshView()` — covers app boot and post-reload (`+page.svelte`
  calls it in both `bootstrap` and `onReloadModel`);
- after the load-time `pushView` in `autoload.ts` and `LoadFilesDialog.svelte`
  (a freshly loaded view becomes the new baseline);
- after a successful **view file save** (rebaseline → count resets to 0).

`pushView` is shared by both "load a new view" and "apply a mid-session edit",
so it must **not** set the baseline itself; the call sites above set it
explicitly. `clearViewState()` also clears `_baseline`.

Re-export the new functions through `state/index.ts`.

### 3. TopBar — `frontend/src/lib/components/TopBar.svelte`

- **Combined change indicator** (top-right): replace the model-only
  `getChangesBadgeTotal()` display with `model + view`
  (`getChangesBadgeTotal()` + `getViewChangesCount()`). Wrap it in a hover
  tooltip (reuse the existing Info-tooltip group-hover pattern already in this
  file) showing two rows:
  - `Model: x`
  - `View: y`
- **Save button:** label becomes just `Save` (drop the `(n)`). Its
  enabled/disabled logic stays, but now also accounts for view changes so Save
  is reachable when only the view is dirty: enabled when there is a model OR a
  view loaded and `model + view > 0` (or pending ops).
- **Export view button:** removed. Drop `onExportView`, and the
  `saveJsonToFile` import if it becomes unused (it is — only the dialog will use
  it). Keep the `view` derived (still used by the tooltip / save-disabled
  logic).

### 4. DiffDrawer — `frontend/src/lib/components/DiffDrawer.svelte`

Wrap the dialog body in `Tabs.Root` (the existing `$lib/components/ui/tabs`
primitive, already used by `Workspace.svelte`) with two tabs:

- **`Model (x)`** — the existing Added / Modified / Deleted sections (elements +
  relationships), the truncation/issue banners, and the Export-CR checkbox.
  Unchanged behaviour.
- **`View (y)`** — the human-readable view-change lines, with an empty state
  ("No view changes.") when `y === 0`. Lines are formatted from the structured
  `ViewChange[]` by a small presentational helper:
  - `element-moved`  → `<name|id> moved from <X> to <Y>`
  - `element-removed`→ `<name|id> removed from view`
  - `element-added`  → `<name|id> added to <Z>`
  - `folder-added`   → `Folder '<path>' created`
  - `folder-removed` → `Folder '<path>' deleted`

  Folder path is rendered slash-joined; the view root is shown as `(root)`.
  Element display names come from `getCachedElements()` + `elementDisplayName`,
  falling back to the raw id when the element is not cached or has no name. On
  open, the drawer best-effort fetches any uncached involved element ids (via
  the existing `getElement` cache-fill path) so removed elements still show a
  name; failures silently fall back to the id.

**Footer.** The primary button is **contextual to the active tab**:

- Model tab → the current model save action (existing `onSaveClick`, label/disabled
  logic unchanged — still "Save (n)"/"Saving…" within the dialog footer).
- View tab → **"Save view"**: writes the `.view.json` via the existing
  `saveJsonToFile` (reusing the view filename/handle when present, prompting
  otherwise), then calls `setViewBaseline(currentView)` so the count drops to 0,
  and updates the stored view filename/handle. Disabled when `y === 0` or while
  saving.

`Cancel` stays shared. Only one primary action is visible at a time, tied to the
tab the user is looking at.

> The TopBar "Save" button opening this dialog is unchanged; only its *label*
> loses the count.

## Data flow

```
view edit (createFolder / placeElement / …)
  → pushView(next)            # updates _view, NOT _baseline
  → getViewChanges()/Count()  # _baseline vs _view  → reactive y
  → TopBar badge (x+y) + tooltip; View tab list

Save view (View tab)
  → saveJsonToFile(view)      # writes .view.json
  → setViewBaseline(view)     # y → 0
  → update view filename/handle

Load view (boot/reload/autoload/LoadFilesDialog)
  → setViewBaseline(loadedView)  # y → 0 against the freshly loaded view
```

## Error handling

- View save failures surface inline in the dialog (same pattern as the existing
  model `saveError`); the baseline is **not** reset on failure, so the count
  persists.
- Name-fetch failures in the preview fall back to the id (never block the list).
- `diffViews` treats `null` baseline or `null` current as empty trees, so a view
  that is loaded for the first time (baseline set immediately) reads as 0
  changes, and clearing the view reads as 0.

## Testing

**Unit (vitest), `state/__tests__/view-diff.test.ts`:**
- element added / removed / moved between folders; nested folder paths.
- folder added / removed; shallowest-path collapse on a populated-folder
  rename (one removed + one added pair, no descendant lines).
- null baseline, null current, identical trees (0 changes).

**Component / e2e:**
- TopBar shows combined `x + y`; tooltip exposes `Model: x` and `View: y`.
- TopBar Save button reads `Save` (no count); Export-view button is gone.
- Save dialog: Model/View tabs with per-tab counts; View tab lists the
  human-readable lines; "Save view" writes the file and the View count resets to
  0; the footer primary action switches with the active tab.

## Out of scope

- Folder rename/move detection as a single "renamed/moved" line (no stable
  folder id; would need heuristics).
- Any server-side view change tracking / view op log (the view is small and
  client-held; snapshot diffing is sufficient).
- Combined single-click "save model + view" (decided against — tabs keep the two
  artifacts decoupled).
