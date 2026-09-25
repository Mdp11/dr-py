# View-aware virtualized sidebar tree

**Date:** 2026-06-15
**Status:** Design approved, pending spec review
**TODO item:** "New approach (load more) does not work well with view"

## Problem

The large-model overhaul replaced whole-model loading with incremental "load
more" paging: containment roots are fetched 500 at a time, with a "Show more
(N of M)" button assembling further pages (`ContainmentTree.svelte:96-117,
733-741`; `model-read.ts:124-141`). The backend caps a page at 500 and 422s
above it (`read.py:347`).

A **view** is a curated folder hierarchy whose folders hold element ids
(`types.ts:124-142` — `View { name, folders }`, `Folder { name, folders,
elements: string[] }`). It is pushed to the backend and stored on
`session.view` (`view.py:19-31`), and fetched whole via `GET /view`.

The two features collide. When a view is active, `buildUnifiedTree` renders
top-level folders **interleaved with every model root not placed in a folder**
(`view-tree.ts:134-147` — `roots = [topFolders, ...(pagedRoots − placed)]`).
Those unplaced roots come from the whole-model paged loader, so:

- The view's folders get buried under an effectively unbounded list of
  unrelated model roots.
- "Show more" pages over the **entire model**, not anything view-related —
  `rootsTotal` is the full-model root count (`ContainmentTree.svelte:117`).
- Which loose elements appear depends on how many pages the user has clicked,
  not on the view — the set is incoherent.
- The view's own placed elements are eagerly fetched **one HTTP request each**
  via an effect that walks every folder and calls `ensureElement(id)` for every
  placed id (`ContainmentTree.svelte:178-191`; `model.svelte.ts:638` — no
  batching). A large view fires thousands of individual `GET /model/elements/{id}`
  requests on load.

Root cause: the view and the model roots load on opposite models (view = whole,
eager, per-element; roots = paged, lazy) and are then mashed into one list.

## Goals

1. When a view is active, the tree shows a coherent, curated structure that does
   not degrade with model size.
2. No "Show more" buttons anywhere — loading is automatic as the user scrolls.
3. The user can curate the view by drag-and-drop: include, exclude, and reorder
   elements, with the ordering they choose preserved.

## Non-goals

- Changing the no-view containment tree's **data/paging semantics** (same
  endpoints, same per-level paging). Its **rendering** does change: it gains
  virtualization + auto-scroll loading and loses its "Show more" button.
- Paging the view snapshot itself from the backend (the snapshot's id list is
  still loaded whole — see Known limits).

## Design overview

When a view is active the sidebar has two regions:

```
▾ Folder A                     ┐
   • element (reorderable)     │  IN-VIEW  — the curated folder hierarchy.
   ▾ Subfolder                 │  Folders sorted by name; elements in
      • element                │  user-controlled placement order.
▾ Folder B                     ┘
─────────────────────────────
▾ Not in view (1 234)          ┐  EXCLUDED POOL — every containment root NOT
   • element                   │  placed in a folder. Always last, collapsible,
   • element                   │  backend-ordered, virtualized + auto-loaded.
   …                           ┘
```

- **In-view region** = the folder hierarchy only. No loose top-level elements.
  Every placed element lives in a folder. Element ids come entirely from the
  view snapshot, so this region needs no fetch-paging — it is pure client-side
  windowing; only element **bodies** for the on-screen window are fetched.
- **Excluded pool** = the *complement*: containment roots not placed in any
  folder. It is **derived, not stored** — there is no "excluded list" in the
  view; an element is excluded iff it is not in a folder. This is the correct
  home for the whole-model roots paging that previously leaked into the top
  level.

This reframes the original bug: the old interleaved "unplaced roots" were not
wrong to exist, only mislocated. They become the excluded pool.

### Curation semantics (drag-and-drop)

- **Pool → folder** = include in view. Existing `placeElementsInView`
  (`view-ops.ts:60-78`), extended with a **positional insert** so the element
  lands at the drop index, not always appended.
- **Folder → pool** = exclude from view. Existing unplace (place with empty
  path) — strips the id from all folders; it then reappears in the pool because
  the pool is the complement. No new persistence.
- **Within a folder: reorder** = drag an element to a new index among its
  siblings. New pure helper in `view-ops.ts`. Placement order is the
  user-controlled order and is what the in-view region renders by.
- All mutations persist exactly as today: clone the view, apply the pure
  transform, `pushView` the snapshot (`view.svelte.ts`).

Only uncontained elements are placeable; the existing rule that skips contained
elements from folder placement (`view-tree.ts:78`) is unchanged. In the pool,
roots are draggable; their expanded containment children are visible but not
draggable (consistent with today's `movableElementIds` / `canDropElement`,
`view-tree.ts:252-304`).

## Components and changes

### Backend

1. **Complement endpoint** — `GET /model/containment/roots/excluded`
   (`read.py`, alongside `list_containment_roots`). Reads `session.view`,
   computes `root_ids = [eid for eid in model.elements if first_parent(eid) is
   None and eid not in placed]` where `placed` is the set of ids in the view's
   folders, and returns a `ContainmentPage` (`items`, `total`) paged by
   `limit`/`offset` (same 500 cap). Backend order = model insertion order, same
   as `list_containment_roots`. When `session.view is None`, behaves like
   `list_containment_roots` (or the frontend simply does not call it).

2. **Batch element fetch** — `POST /model/elements/batch` (`elements.py` or
   `read.py`). Body `{ids: string[]}`, capped at 500 (422 above). Returns the
   known elements for those ids, **silently omitting unknown/deleted ids** (so a
   stale window id does not fail the whole request). Reuses the existing
   element serializer.

### Frontend — API layer (`model-read.ts`)

3. `listExcludedRoots({limit, offset})` → calls the complement endpoint;
   `listExcludedRootsPaged` mirrors `listContainmentRootsPaged` for assembling
   growth past 500 if needed.
4. `getElementsBatch(ids: string[])` → `POST /model/elements/batch`.

### Frontend — store (`model.svelte.ts`)

5. `ensureElements(ids: string[])` — fetches only the **uncached** ids in one
   batched `getElementsBatch` call, dedupes against in-flight batch requests,
   seeds the cache. Replaces the per-element `ensureElement` loop for window
   loading. (`ensureElement` stays for single-id callers like the Inspector.)

### Frontend — tree model (`view-tree.ts`)

6. `buildUnifiedTree` no longer interleaves unplaced roots. With a view:
   `roots = topFolderKeys` only. The excluded pool is built separately (it is
   not part of the folder snapshot) and appended as a dedicated section node
   below the folders. In-folder element order = `folder.elements` order (no
   name-sort); folders still name-sorted.
7. New `view-ops` helpers (pure, unit-tested): positional place/insert and
   in-folder reorder, producing a new `View` for `pushView`.

### Frontend — rendering (`ContainmentTree.svelte` + new windowing)

8. **Virtualization.** Replace the recursive `{#each tree.roots}` → `TreeNode`
   mounting (`:710`) with a **fixed-row-height windowed list** over the existing
   flattened `visibleRows` (`:292`): a scroll container with top/bottom spacers
   that mounts only the on-screen window. Rows keep depth-based indent
   (`TreeNode` `padding-left: depth*12+4`). Hand-rolled (no new dependency) to
   coexist with the bespoke pointer-DnD and keyboard nav.
9. **Auto-load on scroll (no buttons).** When the window nears the end of a
   level's loaded rows, fetch the next page automatically:
   - Excluded pool → next `listExcludedRoots` page.
   - Expanded containment levels → next `listContainmentChildren` page.
   Remove the "Show more" button (`:733-741`). In-view folders need no fetch
   (snapshot-resident) but still window.
10. **Windowed body fetch.** For ids entering the window, call `ensureElements`.
    Remove the eager fetch-all effect (`:178-191`).
11. **Excluded section node.** A collapsible section header ("Not in view",
    with count from the endpoint `total`) rendered as the last root; its
    children are the paged/windowed excluded roots.
12. **DnD under virtualization.** Add edge **auto-scroll during drag** so a drag
    from the bottom pool to a top folder (or vice versa) can reach off-screen
    targets as they scroll into the window. Drop hit-testing stays DOM-based on
    `data-drop-key` for mounted rows.
13. **Structural-refetch coherence.** On a structural delta / model swap, reset
    the excluded pool and expanded levels to their first page and scroll-extent
    rather than trying to reload every previously-scrolled page.

### Frontend — search-to-curate (companion, in scope)

14. Allow dragging a **search result** into a folder (place in view). At
    whole-model scale the pool cannot be scrolled to find one element, so search
    is the real discovery path. Search results become draggable with the
    element payload (`ELEMENT_MIME`, `view-tree.ts:217/231`), reusing the same
    place-into-folder drop handling. (Search panel: `Search.svelte` /
    `CommandPalette.svelte`.)

## Decisions (settled)

- **In-view ordering:** folders by name; elements by user-controlled placement
  order (drag-to-reorder).
- **Top level:** folders only; there are no loose top-level view elements. The
  excluded pool is the home for everything not in a folder.
- **Excluded pool source:** backend complement endpoint (exact total + order).
- **Excluded pool order:** backend (model insertion) order — not name-sorted
  (name-sort would require loading every element body).
- **Loading UX:** infinite/auto scroll everywhere; no "Show more" buttons.
- **Body fetch:** batched window fetch via `POST /model/elements/batch`.
- **Search-to-curate:** in scope.

## Type-filter behavior (preserved, clarified)

The type filter is an allowlist of metamodel stereotype names (a small bounded
set — `filters.svelte.ts`), independent of element count. `computeVisibility`
still needs each row's `type_name`. For rows whose body is not yet loaded, treat
them as **tentatively visible** (skeleton row) and re-evaluate once the body
loads — mirroring today's "visibility over the loaded subset only" semantics
(`ContainmentTree.svelte:241-243`). Total scroll height is an estimate that
refines as filtered rows drop out.

## Edge cases

- Placed id missing / contained elsewhere / multi-placed → existing skip /
  first-wins rules in `ingestFolder` unchanged (`view-tree.ts:76-83`).
- Duplicate sibling folder names → existing skip rule unchanged.
- Empty / brand-new view → in-view region empty, excluded pool = whole model;
  the expected "start curating" state.
- View dropped → fall back to the containment tree (no excluded section).
- Stale window id (deleted between layout and fetch) → omitted by the batch
  endpoint; row renders nothing and is dropped on the next structural refetch.

## Known limits (documented, not addressed now)

- The view snapshot (all placed ids + folder names) is still loaded whole. For a
  whole-model view that is a few MB of strings — acceptable. Backend-paged
  snapshots are future work.
- Deeply nested expanded containment levels are virtualized but each level is
  still fetched page-by-page; extremely deep + wide expansions hold more in
  memory than a collapsed tree. Bounded by what the user expands.

## Testing

- **`view-tree.ts` unit:** view active ⇒ `roots` are folders only (no unplaced
  interleave); in-folder order follows `folder.elements`; folders name-sorted;
  excluded section assembled separately.
- **`view-ops.ts` unit:** positional insert lands at the drop index; in-folder
  reorder permutes order; exclude strips from all folders; all return fresh
  `View` clones.
- **`model-read` / store:** `getElementsBatch` posts ids and omits unknown;
  `ensureElements` fetches only uncached ids in one call and seeds the cache.
- **Backend:** `/model/containment/roots/excluded` returns complement with exact
  total, respects `session.view`, falls back when no view, paginates, 422s above
  cap; `/model/elements/batch` happy path, omits unknown ids, 422 above 500.
- **e2e (`view.spec.ts`):** large view shows folders immediately; scrolling the
  excluded pool auto-loads more with no button; drag pool→folder includes,
  folder→pool excludes, intra-folder drag reorders and persists across reload;
  drag a search result into a folder.
