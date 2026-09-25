# Excluded-pool split panel — design

**Date:** 2026-06-15
**Area:** `frontend/src/lib/components/Sidebar/` (containment tree)
**Status:** approved (brainstorming) → ready for plan

## Problem

In view mode the "Not in view" excluded pool is rendered as the last *root* of
the unified containment tree, inside the tree's single scroll viewport. Two
issues follow from this:

1. **Coupling.** The pool is visually and structurally part of the tree even
   though it is a different kind of thing (the complement of the view, not part
   of the curated scope).
2. **Runaway paging (already mitigated).** Because the pool's loaded rows sit at
   the tail of the single `visibleRows` list, collapsing the section made the
   short list read as "at the bottom" and paged the entire pool into memory. A
   first fix (`shouldLoadMoreExcluded`, gating auto-load on the section being
   expanded) already shipped; this redesign makes the separation structural.

## Goal

Move the "Not in view" pool out of the tree into a **separate, collapsible,
resizable panel** pinned to the bottom of the tree region:

- Collapsed by default on view load; **no fetch while collapsed**.
- A draggable divider between the in-view tree (top) and the pool (bottom) lets
  either take more space; first expand defaults to a 50/50 split.
- Collapsed state and divider ratio persist across reloads (localStorage).
- The stereotype type filter applies to both panels.
- Drag-and-drop works **across the divider in both directions** (pool → tree
  places into view; tree → pool excludes).

## Chosen approach: partition within `ContainmentTree`, extract the split shell

Keep a single component owning the tree machinery — one unified `tree`, one
element cache, one DnD controller, one child-level prefetch — and render its
rows into **two scroll viewports**, each with its own windowing state. Extract
only the genuinely-new, isolated bits:

- `split.ts` — pure sizing math (unit-tested, like `windowing.ts`).
- `VerticalSplit.svelte` — controlled presentational split (divider + collapse).

Rationale: the in-view side has folders and the pool does not, and DnD /
child-prefetch / element cache are tightly shared. A full extraction into a
shared "lazy tree engine + two panels" buys clean separation at real regression
risk for no immediate benefit (YAGNI). Cross-panel DnD needs almost no new code
because hit-testing is already `document.elementFromPoint`-based and the drag
store (`tree-drag.svelte.ts`) is already global.

## Components & responsibilities

### 1. `split.ts` (new, pure)

Deterministic geometry, no Svelte/DOM, mirroring `windowing.ts` so it is unit
tested without a browser.

```ts
export interface SplitHeights { topH: number; bottomH: number; dividerH: number; }

// Compute the two panel heights for the tree region.
// - collapsed: bottom panel shows only its header bar (headerH); top gets the rest.
// - expanded: split (containerH - headerH - dividerH) by `ratio`, clamped so
//   neither panel goes below minPanelH.
export function panelHeights(args: {
  containerH: number; ratio: number; collapsed: boolean;
  headerH: number; dividerH: number; minPanelH: number;
}): SplitHeights;

// Translate a divider drag (pointer Y within the container) to a new ratio,
// clamped to [minRatio, maxRatio] derived from minPanelH.
export function clampRatio(args: {
  pointerY: number; containerH: number;
  headerH: number; dividerH: number; minPanelH: number;
}): number;
```

`ratio` is the fraction of the *expandable* area (container minus header minus
divider) given to the **top** panel. Default `0.5`.

### 2. `VerticalSplit.svelte` (new, presentational, controlled)

Props/bindings:
- `collapsed: boolean` (bindable), `ratio: number` (bindable).
- `headerH`, `dividerH`, `minPanelH` (numbers, with sensible defaults).
- Snippets: `top`, `bottomHeader` (rendered in both states — it is the collapse
  toggle and, when expanded, also the area just below the divider), `bottomBody`
  (rendered only when expanded).

Behavior:
- Measures its own height via `ResizeObserver` (like the tree viewport today).
- Renders top snippet in a box of `topH`; when expanded, a `row-resize` divider
  whose drag updates `ratio` via `clampRatio`; then the header bar; then
  `bottomBody` in a box of `bottomH`. When collapsed, only the header bar shows,
  pinned at the bottom.
- Persistence is **not** owned here (controlled) — the parent binds `collapsed`
  / `ratio` to localStorage-backed state.
- Click vs drag on the divider is unambiguous: the divider strip handles drag;
  the header's chevron button handles collapse toggle. Two distinct affordances.

### 3. `ContainmentTree.svelte` (modified)

- **Tree build:** stop pushing `EXCLUDED_SECTION_KEY` into `tree.roots`. The
  excluded subtree (excluded roots + their containment children) is still built
  in `tree`/`visibility` for filtering, but its roots are exposed separately as
  `excludedRootIds`. `appendExcludedSection` is replaced by registering the
  excluded roots + their child nodes without adding a synthetic section root.
- **Two flatten passes:** `treeVisibleRows` over `tree.roots` (in-view folders),
  and `poolVisibleRows` over `excludedRootIds`. Each feeds its own
  `computeWindow` + `windowedRows` slice with independent `scrollTop`/`viewportH`.
- **Pool fetch gate:** the excluded auto-load fires only when
  `!poolCollapsed && poolViewportH > 0` (extends today's `shouldLoadMoreExcluded`
  by also requiring a sized viewport). Collapsed ⇒ zero excluded GETs.
- **Header label:** the pool header shows `Not in view (excludedTotal)`.
- **Persistence:** `poolCollapsed` (default `true`) and `poolRatio` (default
  `0.5`) read/written to localStorage under stable keys, e.g.
  `dataRover.tree.poolCollapsed` / `dataRover.tree.poolRatio`. Guard for absent
  `localStorage` (SSR/tests).
- **DnD:**
  - Pool → tree: excluded roots remain in `movableElementIds` (today they come
    from `tree.children.get(EXCLUDED_SECTION_KEY)`; now from `excludedRootIds`).
    Drop resolution onto folders/rows is unchanged.
  - Tree → pool: the pool **body** and the **collapsed header bar** carry
    `data-drop-kind="section"` (and `data-drop-path="null"`), so a drop there
    resolves via `resolveElementDrop({targetKind:'section'})` → `{path:[],index:0}`
    (exclude) — the exact semantics the old section row provided.
  - Edge auto-scroll: `tickAutoScroll` chooses the viewport whose rect contains
    the pointer Y (tree vs pool), scrolling that one.

## Data flow

```
view + roots + excludedRoots + childLevels + elementsById
  → buildUnifiedTree (folders + element subtrees; NO excluded section root)
  → register excluded roots/children + expose excludedRootIds
  → computeVisibility (type filter) over the whole tree (both regions)
  → flattenVisibleRows(tree.roots)      → treeVisibleRows → window A
     flattenVisibleRows(excludedRootIds) → poolVisibleRows → window B
  → VerticalSplit renders [tree viewport A] / divider / [pool header + viewport B]
```

Auto-load (pool): `shouldLoadMoreExcluded({ sectionCollapsed: poolCollapsed || poolViewportH===0, ... })`.

## Edge cases

- **Zero excluded:** header still shows `Not in view (0)`; expanding shows an
  empty list; the bar remains a valid drop target for excluding elements.
- **Collapsed + drag-to-exclude:** the collapsed bar is a drop target, so users
  can exclude without expanding.
- **No view loaded:** `VerticalSplit` is only used in view mode. With no view,
  the tree fills the region exactly as today (single viewport, no pool, no
  divider).
- **Container too short for both mins:** `panelHeights` clamps; if even the mins
  don't fit, the top panel yields first (pool keeps header + minPanelH).
- **localStorage unavailable:** fall back to in-memory defaults (collapsed, 0.5).

## Out of scope (defaults)

- Keyboard arrow-navigation stays scoped to the in-view tree (today's behavior);
  the pool is pointer-driven. The pool viewport is still focusable/scrollable.
- No server-side or per-view persistence of panel state; it is per-browser.

## Testing

- `split.test.ts` (vitest, pure): `panelHeights` collapsed vs expanded, ratio
  clamping at min panel heights, container-too-short degradation; `clampRatio`
  maps pointer Y to ratio and clamps at both ends.
- `windowing` already covers `shouldLoadMoreExcluded`; add a case for the
  `poolViewportH === 0` gate if it lands as a new pure helper, otherwise it is
  covered by the existing collapsed case.
- Existing `view-tree-window.test.ts` updated: `buildUnifiedTree` no longer adds
  an `EXCLUDED_SECTION_KEY` root; the excluded roots are exposed for a separate
  flatten. Adjust the `appendExcludedSection` tests to the new registration
  helper / `excludedRootIds` shape.
- Manual verification (running app): load smart-city with a view, confirm pool
  starts collapsed with no excluded GETs; expand → 50/50 + first page fetched;
  drag divider resizes; collapse/expand and reload persist; drag an element from
  pool into a folder (adds to view) and from the tree onto the pool/bar
  (excludes); edge auto-scroll works in each viewport.

## Risk notes

- The pre-existing O(n²) re-accumulation in `listExcludedRootsPaged` (re-fetches
  from offset 0 on each limit bump) is unchanged here and out of scope; it is no
  longer triggered in a runaway loop after the auto-load gate.
