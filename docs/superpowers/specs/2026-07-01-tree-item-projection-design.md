# Tree-item projection: fast folder-open on large models

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Area:** `frontend/src/lib/state`, `frontend/src/lib/components/Sidebar`, `src/data_rover/api/routes/read.py`, `src/data_rover/api/schemas.py`

## Problem

Opening a view folder that holds many elements on a large model (>100 MB) is
clunky: rows render as placeholder skeletons and take a visible beat to fill in,
flashing again as the user scrolls. It is already noticeable on localhost and
will be worse over the cloud.

### Root cause (two compounding problems)

1. **Over-fetch.** `POST /model/elements/batch` returns the full `ElementOut`
   — the entire `properties` dict per element — but a containment/view tree row
   renders only `display_name`, `type_name`, a child-count expand caret, and a
   lock badge (`Sidebar/TreeRow.svelte`). On a 100 MB model those property bags
   are large, so the client pays heavy JSON serialization + transfer for data
   the row discards. The same over-fetch exists in the containment-level reads
   (`/model/containment/roots`, `/children`, `/roots/excluded`), which return
   full `ContainmentItem`s (`element: ElementOut` + `child_count`).
2. **Piecemeal fetching.** The tree ensures only the current scroll *window's*
   ids (`ContainmentTree.svelte`, the `ensureElements(ids)` call driven by
   `windowedRows`). Every new window while scrolling fires a fresh round-trip,
   so a skeleton flashes each time — the latency made visible.

### Constraints / success criteria (from brainstorming)

- **Priority:** folder-open / scroll latency (not initial load, not general
  reactivity jank).
- **Target UX:** perceived-instant as much as possible — ideally zero
  placeholder flash, and never a stall.
- **Folder scale:** a big view folder tops out around ~1k direct children.
  (Containment levels in no-view mode can still be large, so those keep paging.)

## Approach (chosen: A, unified / scope 1b)

Render the whole tree from a **lightweight projection** and fetch full elements
only on selection. Because a view folder is ≤1k and the client already holds the
folder's id list, fetch the entire folder's lite rows in **one** request on
expand — eliminating both the over-fetch and the per-window flash.

Rejected alternatives:
- **B (frontend-only eager prefetch):** whole-folder fetch of *full* elements.
  Removes the flash but keeps the heavy payload; still slow on 100 MB / cloud.
- **C (server-side precomputed tree index):** cached per-folder projection
  invalidated on ops. Most scalable but most new invariants; overkill for ~1k
  folders. The projection endpoint below is a clean stepping-stone to C later.

## Design

### 1. Backend: the `TreeItem` projection

**Schema** (`schemas.py`):

```python
class TreeItem(BaseModel):
    id: str
    type_name: str
    display_name: str   # reuses _display_name(): name prop or id
    child_count: int    # reuses _containment_child_ids()
```

No `properties`, no `rev`. A 1k-element folder becomes ~4 short fields × 1k
(tens of KB) instead of potentially many MB.

**By-ids endpoint** (`routes/read.py`): `POST /model/elements/tree-items`
- Body `{ids: [...]}`, capped at `MAX_PAGE_LIMIT` (422 above — same guard as
  `/batch`).
- Returns `{items: [TreeItem, ...]}`, unknown/deleted ids **silently omitted**,
  identical semantics to `/batch` so the client's "omitted ⇒ missing" handling
  carries over unchanged.

**Unified lite mode (scope 1b):** the three containment-level endpoints
(`/model/containment/roots`, `/children`, `/roots/excluded`) also gain a lite
mode returning `TreeItem` pages (e.g. a `?lite=1` query flag, or parallel
functions), so the *entire* tree renders from one lightweight shape and full
elements are fetched only on selection. Ordering and paging semantics are
unchanged (display-name-then-id sort preserved).

**Display-name parity fix:** backend `_display_name` currently checks only the
exact `name` key, while the frontend `nameProp` (`lib/util/element-name.ts`) is
case-insensitive (`Name`, `NAME`, ...). Align `_display_name` with `nameProp`'s
case-insensitive rule so a row's name is identical whether it comes from the
lite (server) or full (client) source.

### 2. Frontend: tree-item cache + fetch-on-expand

**New cache** in `model.svelte.ts`, parallel to `_elements`:

```ts
const _treeItems = new SvelteMap<string, TreeItem>();  // id → {type_name, display_name, child_count}
```

plus `getCachedTreeItems()` and `ensureTreeItems(ids)` mirroring
`ensureElements` (dedup via `_inFlightBatchIds` / `_missingElementIds`, chunk at
`READ_PAGE_LIMIT`) but hitting `POST /model/elements/tree-items`.

**API layer** (`model-read.ts`): `getTreeItemsBatch(ids)` and lite variants of
the three containment-level reads returning `TreeItem` pages.

**Trigger change (kills the flash):**
- **View-folder rows:** on folder **expand**, fetch **all** of that folder's
  child ids in one `ensureTreeItems` call (≤1k → a single small request). Rows
  render from cache with no per-window fetching → no flash on scroll.
- **Containment levels (no-view mode / expanding an element's children):** keep
  the existing paged auto-load, but pages now carry lite `TreeItem`s and feed
  the same `_treeItems` cache + `childCounts`.

**Render source:** a unified accessor `treeDisplay(id)` returns
`{display_name, type_name, child_count}`, **preferring `_elements`** (full, kept
fresh by deltas) when present, else `_treeItems`. A fully-loaded/edited element
always wins; unedited rows come from the lite cache. `TreeRow`/`ContainmentTree`
switch from `getCachedElements()` + `displayName(el)` + `el.type_name` +
`childCounts` to this accessor.

### 3. Consistency

Guiding principle: **`_treeItems` only ever holds rows the user is merely
viewing.** The moment an element is created, edited, or arrives in a delta, its
full entry lands in `_elements` (via `applyDelta`/`seedElements`) and
`treeDisplay` prefers it. So the lite cache never needs per-field patching —
only two cheap maintenance rules:

- **Eviction on delete.** `applyDelta`'s `deleted_element_ids` handling also
  deletes from `_treeItems` (same site it deletes from `_elements`); temp→
  canonical id remap moves/drops the lite entry likewise.
- **`child_count` refresh on structural change.** `child_count` shifts when
  containment relationships are created/deleted, which already bumps
  `_structureRev`. Since folders are ≤1k, the tree re-runs `ensureTreeItems`
  for currently-expanded view folders when `_structureRev` changes
  (drop-then-refetch the affected ids). Containment levels already re-derive on
  `_structureRev` and refresh through their paged path. Names/types never need
  this route — an edited element is already in `_elements`.
- **Locks are orthogonal** — badges come from `lockBadgeFor()`/lock state, never
  from element payloads; unchanged.
- **Store reset** clears `_treeItems` alongside `_elements` / `_missingElementIds`.

Net: the lite cache is a pure display accelerator that defers to the
authoritative full cache; structural freshness rides the existing
`_structureRev` signal. No new invariant coupling.

### 4. Edge cases

- **Missing/dangling ids** — `tree-items` omits unknown ids like `/batch`;
  `ensureTreeItems` records omissions in `_missingElementIds`, so a dangling
  folder placement drops its row instead of holding a skeleton forever.
- **Temp ids** — skipped in `ensureTreeItems`; the optimistic full entry in
  `_elements` renders the row until the create acks, then the delta supplies the
  canonical full entry.
- **Selected element** — fetched as full `ElementOut` on selection (Inspector),
  lands in `_elements`; `treeDisplay` prefers it. No double-render.
- **Cap overflow** — a view folder can't exceed `MAX_PAGE_LIMIT`, but
  `ensureTreeItems` chunks at `READ_PAGE_LIMIT` regardless, so it is safe if one
  ever does.

## Testing

- **Backend** (`tests/api/`): `tree-items` returns the lite shape, omits unknown
  ids, 422s over `MAX_PAGE_LIMIT`; lite containment levels match full-mode
  ordering/paging; `_display_name` case-insensitive parity.
- **Frontend unit** (`lib/state/__tests__`, `Sidebar/*.test.ts`):
  `ensureTreeItems` dedup/missing/chunk logic; `treeDisplay` prefers `_elements`
  over `_treeItems`; delete evicts the lite entry; `_structureRev` bump
  refetches expanded-folder items; whole-folder-prefetch-on-expand issues
  exactly one request for a ≤1k folder.
- **Perf sanity** (manual / e2e): open a ~1k-element view folder on a large
  model — one request, no placeholder flash on scroll.

## Out of scope

- Initial model/view load time and session hydration.
- General post-load reactivity jank over large caches.
- Server-side precomputed tree index (approach C) — deferred; this design is a
  stepping-stone to it if folders ever grow past the ~1k assumption.
