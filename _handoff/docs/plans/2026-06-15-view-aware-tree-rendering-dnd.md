# View-aware Tree — Virtualized Rendering & DnD Curation (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the view-aware sidebar tree with a virtualized (windowed) list, surface the "Not in view" excluded pool as an auto-loading section, and let the user curate the view by drag-and-drop (include / exclude / reorder, plus drag-from-search) — eliminating every "Show more" button and the eager per-element fetch.

**Architecture:** The tree is rendered as a **flat windowed list** over the already-flattened `visibleRows`, replacing the recursive `<TreeNode>` mounting. Only on-screen rows mount; their element bodies are fetched in batched windows via `ensureElements`. When a view is active, the in-view folder hierarchy (snapshot-resident, no fetch-paging) is followed by a collapsible **"Not in view"** section whose children are the backend complement (`listExcludedRoots`), auto-loaded as the user scrolls. Drag-and-drop persists by cloning the view, applying a pure `view-ops` transform, and `pushView`-ing the snapshot — exactly as today. All geometry (windowing, auto-load thresholds, drop-index, edge auto-scroll) lives in pure, unit-tested helpers; the Svelte components are thin wiring verified by `svelte-check` + Playwright.

**Tech Stack:** SvelteKit / Svelte 5 (runes), TypeScript, Vitest + MSW (unit), Playwright (e2e), FastAPI backend (already complete from Plan 1 — no backend work here).

---

## Pre-flight: environment & commands

**This is a non-negotiable constraint.** The repo pins Node 22. The system Node is 18 and bare `npm`/`npx`/`vitest` **fail** with `SyntaxError: ... node:util does not provide an export named 'styleText'`. Every frontend command in this plan MUST be run through the pinned env:

- Run a single vitest file:
  `pixi run -e frontend bash -c 'cd frontend && npx vitest run <path-or-pattern>'`
- Type/svelte check (no test runner):
  `pixi run -e frontend bash -c 'cd frontend && npm run check'`
- Lint (frontend): `pixi run -e frontend bash -c 'cd frontend && npm run lint'` (only if present; otherwise rely on `npm run check`).
- Playwright e2e: `pixi run -e frontend bash -c 'cd frontend && npx playwright test e2e/view.spec.ts'`
  — e2e needs a browser + the dev server; if the implementer has no browser, AUTHOR the spec changes and report that e2e was not executed (Plan 1 did the same). Do not block the plan on e2e execution.

Test infra facts (from the existing suite): MSW `server` lives at `src/lib/api/__tests__/server.ts`; `BASE = 'http://api.test/api/v1'`; store tests call `setModelApiConfig({ baseUrl: BASE })`. Follow the patterns already in `src/lib/state/__tests__/model-store.test.ts` and `src/lib/api/__tests__/model-read.test.ts`.

## Context: what Plan 1 already delivered (do not rebuild)

- Backend `POST /model/elements/batch` and `GET /model/containment/roots/excluded`.
- API client: `getElementsBatch(ids)`, `listExcludedRoots(opts)`, `listExcludedRootsPaged(limit)` (`src/lib/api/model-read.ts`), `READ_PAGE_LIMIT = 500`.
- Store: `ensureElements(ids)` — batched, dedup'd, in-flight-guarded window fetch (`src/lib/state/model.svelte.ts:677`). `ensureElement` (single id) stays for the Inspector.
- `view-ops.ts`: `placeElementsInViewAt(view, path, ids, index)` (positional place/reorder/exclude) + `placeElementsInView` wrapper (append).
- `view-tree.ts`: `buildUnifiedTree` curated scope — with a view, `roots = topFolderKeys` only (no interleaved unplaced roots). DnD helpers `canDropElement`, `canDropFolder`, `movableElementIds`, `encode/decodeElementPayload`, `encode/decodeFolderPayload`, `VIEW_ROOT_DROP_KEY`, `FOLDER_KEY_PREFIX`, `folderKey`, `folderPathFromKey`, `isFolderKey`.

The **store mutators** that persist a view (`src/lib/state/view.svelte.ts`): `placeElement(path,id)`, `placeElements(path,ids)`, `removeElement(id)`, `moveFolder(src,dst)`, folder CRUD. `placeElements` currently calls `placeElementsInView` (append). Phase B adds a positional variant.

## File structure (what each file is responsible for)

**New files:**
- `frontend/src/lib/components/Sidebar/windowing.ts` — pure virtualization & drag geometry: `computeWindow`, `shouldLoadMore`, `edgeScrollDelta`. No Svelte, fully unit-tested.
- `frontend/src/lib/components/Sidebar/windowing.test.ts` — unit tests for the above.
- `frontend/src/lib/components/Sidebar/TreeRow.svelte` — a **single** non-recursive row (folder, element, or the excluded-section header). Extracted from `TreeNode.svelte`'s markup; receives a fully-resolved `FlatRow` + per-row flags and emits the same `data-drop-*` attributes.
- `frontend/src/lib/state/tree-drag.svelte.ts` — shared pointer-drag controller (runes module) so both `ContainmentTree` and `Search` can start an element drag and the tree completes the drop. Holds drag state + `beginDrag/updatePointer/commitDrop/cancel`; pure geometry delegated to `windowing.ts`.
- `frontend/src/lib/state/__tests__/tree-drag.test.ts` — unit tests for the controller's pure decisions (payload building, drop resolution dispatch) using fakes.

**Modified files:**
- `frontend/src/lib/components/Sidebar/view-tree.ts` — add the excluded-section node (`EXCLUDED_SECTION_KEY`, `isExcludedSectionKey`, `appendExcludedSection`), `flattenVisibleRows` (pure flatten with depth), drop-index helper `dropTargetForRow`; remove the in-folder name-sort (order follows `folder.elements`); make `computeVisibility` treat unloaded bodies as tentatively visible.
- `frontend/src/lib/components/Sidebar/view-tree-build.test.ts` & a new `view-tree-window.test.ts` — cover the new pure helpers.
- `frontend/src/lib/components/Sidebar/ContainmentTree.svelte` — the integration surface: windowed render, excluded-pool fetch + section, auto-load on scroll, windowed body fetch, remove eager fetch effect + "Show more", DnD positional drop / reorder / exclude, edge auto-scroll, structural-refetch reset.
- `frontend/src/lib/components/Sidebar/TreeNode.svelte` — **deleted** once `TreeRow.svelte` + windowed render replace it (recursive mounting is incompatible with windowing).
- `frontend/src/lib/components/Sidebar/Search.svelte` — make result rows drag sources (start an element drag via the shared controller).
- `frontend/src/lib/state/view.svelte.ts` — add `placeElementsAt(path, ids, index)` mutator wrapping `placeElementsInViewAt`; export via `src/lib/state/index.ts`.
- `frontend/e2e/view.spec.ts` — restore/extend the `TODO(plan-2)` assertions: Beta appears in the "Not in view" section; pool auto-loads; drag include/exclude/reorder persists; drag-from-search.

---

# Phase A — Virtualized rendering & the excluded pool

Phase A makes the curated view usable again: folders render immediately, the "Not in view" pool shows every unplaced root and auto-loads on scroll, only on-screen bodies are fetched, and no "Show more" button remains. No new curation gestures yet (existing append-on-drop keeps working).

### Task A1: Pure windowing geometry

**Files:**
- Create: `frontend/src/lib/components/Sidebar/windowing.ts`
- Test: `frontend/src/lib/components/Sidebar/windowing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/components/Sidebar/windowing.test.ts
import { describe, expect, it } from 'vitest';
import { computeWindow, shouldLoadMore, edgeScrollDelta } from './windowing';

describe('computeWindow', () => {
	it('returns the first slice at scrollTop 0 with overscan', () => {
		// viewport 240 / row 24 = 10 visible; overscan 4 -> end 14
		const w = computeWindow({ scrollTop: 0, viewportH: 240, rowH: 24, total: 100, overscan: 4 });
		expect(w.start).toBe(0);
		expect(w.end).toBe(14);
		expect(w.padTop).toBe(0);
		expect(w.padBottom).toBe((100 - 14) * 24);
	});

	it('offsets start by floor(scrollTop/rowH) minus overscan, clamped at 0', () => {
		const w = computeWindow({ scrollTop: 240, viewportH: 240, rowH: 24, total: 100, overscan: 4 });
		// floor(240/24)=10, minus 4 overscan = 6
		expect(w.start).toBe(6);
		expect(w.padTop).toBe(6 * 24);
		expect(w.end).toBe(Math.min(100, 6 + Math.ceil(240 / 24) + 4 * 2)); // 6 + 10 + 8 = 24
		expect(w.end).toBe(24);
	});

	it('clamps end to total and never produces negative padding', () => {
		const w = computeWindow({ scrollTop: 100000, viewportH: 240, rowH: 24, total: 30, overscan: 4 });
		expect(w.end).toBe(30);
		expect(w.padBottom).toBe(0);
		expect(w.start).toBeLessThanOrEqual(30);
		expect(w.padTop).toBe(w.start * 24);
	});

	it('handles an empty list', () => {
		const w = computeWindow({ scrollTop: 0, viewportH: 240, rowH: 24, total: 0, overscan: 4 });
		expect(w).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
	});
});

describe('shouldLoadMore', () => {
	it('is true when the window approaches the loaded count and more remain', () => {
		expect(shouldLoadMore({ windowEnd: 95, loadedCount: 100, total: 500, threshold: 10 })).toBe(true);
	});
	it('is false when everything is already loaded', () => {
		expect(shouldLoadMore({ windowEnd: 95, loadedCount: 100, total: 100, threshold: 10 })).toBe(false);
	});
	it('is false when the window is far from the end', () => {
		expect(shouldLoadMore({ windowEnd: 40, loadedCount: 100, total: 500, threshold: 10 })).toBe(false);
	});
});

describe('edgeScrollDelta', () => {
	it('is zero in the middle of the viewport', () => {
		expect(edgeScrollDelta({ pointerY: 300, top: 100, bottom: 500, edge: 40, maxSpeed: 24 })).toBe(0);
	});
	it('is negative (scroll up) near the top edge and scales with proximity', () => {
		const atEdge = edgeScrollDelta({ pointerY: 100, top: 100, bottom: 500, edge: 40, maxSpeed: 24 });
		expect(atEdge).toBe(-24);
		const partial = edgeScrollDelta({ pointerY: 120, top: 100, bottom: 500, edge: 40, maxSpeed: 24 });
		expect(partial).toBeLessThan(0);
		expect(partial).toBeGreaterThan(-24);
	});
	it('is positive (scroll down) near the bottom edge', () => {
		expect(edgeScrollDelta({ pointerY: 500, top: 100, bottom: 500, edge: 40, maxSpeed: 24 })).toBe(24);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/windowing.test.ts'`
Expected: FAIL — `Cannot find module './windowing'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// frontend/src/lib/components/Sidebar/windowing.ts
//
// Pure geometry for the virtualized tree. No Svelte, no DOM — every function
// is a deterministic transform so the windowing/auto-load/edge-scroll behaviour
// can be unit-tested without a browser.

export interface WindowSlice {
	/** First row index to mount (inclusive). */
	start: number;
	/** One past the last row index to mount (exclusive). */
	end: number;
	/** Spacer height above the mounted window, px. */
	padTop: number;
	/** Spacer height below the mounted window, px. */
	padBottom: number;
}

/**
 * Compute the mounted row window for a fixed-row-height list. `overscan` rows
 * are mounted above and below the viewport so fast scrolls don't flash blanks.
 */
export function computeWindow(args: {
	scrollTop: number;
	viewportH: number;
	rowH: number;
	total: number;
	overscan: number;
}): WindowSlice {
	const { scrollTop, viewportH, rowH, total, overscan } = args;
	if (total <= 0 || rowH <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
	const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
	const start = Math.min(first, total);
	const visibleCount = Math.ceil(viewportH / rowH) + overscan * 2;
	const end = Math.min(total, start + visibleCount);
	return {
		start,
		end,
		padTop: start * rowH,
		padBottom: (total - end) * rowH
	};
}

/**
 * True when the mounted window is within `threshold` rows of the last loaded
 * row and the server still has more (`loadedCount < total`). Drives automatic
 * paging — there is no "Show more" button.
 */
export function shouldLoadMore(args: {
	windowEnd: number;
	loadedCount: number;
	total: number;
	threshold: number;
}): boolean {
	const { windowEnd, loadedCount, total, threshold } = args;
	if (loadedCount >= total) return false;
	return windowEnd >= loadedCount - threshold;
}

/**
 * Per-frame scroll delta (px) for edge auto-scroll while dragging. Returns a
 * negative value near the top edge (scroll up), positive near the bottom,
 * scaled linearly with how deep into the `edge` band the pointer sits. Zero in
 * the middle.
 */
export function edgeScrollDelta(args: {
	pointerY: number;
	top: number;
	bottom: number;
	edge: number;
	maxSpeed: number;
}): number {
	const { pointerY, top, bottom, edge, maxSpeed } = args;
	if (pointerY < top + edge) {
		const frac = Math.min(1, (top + edge - pointerY) / edge);
		return -Math.ceil(maxSpeed * frac);
	}
	if (pointerY > bottom - edge) {
		const frac = Math.min(1, (pointerY - (bottom - edge)) / edge);
		return Math.ceil(maxSpeed * frac);
	}
	return 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/windowing.test.ts'`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Sidebar/windowing.ts frontend/src/lib/components/Sidebar/windowing.test.ts
git commit -m "feat(view-tree): pure windowing/auto-load/edge-scroll geometry"
```

---

### Task A2: Flatten helper + remove in-folder name-sort

The component currently builds `visibleRows` inline (`ContainmentTree.svelte:292-304`) and `ingestFolder` name-sorts placed elements (`view-tree.ts:84-86`). Extract the flatten as a pure, depth-carrying function and make in-folder order follow `folder.elements` (the user's placement order — required for drag-to-reorder).

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/view-tree.ts`
- Test: `frontend/src/lib/components/Sidebar/view-tree-window.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/components/Sidebar/view-tree-window.test.ts
import { describe, expect, it } from 'vitest';
import type { Element, View } from '$lib/api/types';
import {
	buildUnifiedTree,
	computeVisibility,
	flattenVisibleRows,
	folderKey
} from './view-tree';

function el(id: string, type = 'Block', name = id): Element {
	return { id, type_name: type, properties: { name }, rev: 0 } as Element;
}
const displayName = (e: Element): string => String(e.properties.name ?? e.id);

describe('in-folder order follows folder.elements (no name-sort)', () => {
	it('keeps placement order even when names sort the other way', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['z', 'a'] }]
		};
		const byId = new Map([
			['z', el('z', 'Block', 'Zebra')],
			['a', el('a', 'Block', 'Apple')]
		]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		expect(tree.children.get(folderKey(['F']))).toEqual(['z', 'a']);
	});
});

describe('flattenVisibleRows', () => {
	it('emits a depth-carrying pre-order walk, skipping hidden and not descending stubs/collapsed', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['a'] }]
		};
		const byId = new Map([['a', el('a')]]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		const rows = flattenVisibleRows(tree, vis, new Set());
		expect(rows.map((r) => r.depth)).toEqual([0, 1]);
		expect(rows[0].key).toBe(folderKey(['F']));
		expect(rows[0].parent).toBeNull();
		expect(rows[1].key).toBe('a');
		expect(rows[1].parent).toBe(folderKey(['F']));
	});

	it('does not descend into a collapsed folder', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['a'] }]
		};
		const byId = new Map([['a', el('a')]]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		const rows = flattenVisibleRows(tree, vis, new Set([folderKey(['F'])]));
		expect(rows.map((r) => r.key)).toEqual([folderKey(['F'])]);
	});
});

describe('computeVisibility treats unloaded element bodies as tentatively visible', () => {
	it('keeps a row whose body is not in elementsById', () => {
		const view: View = {
			name: 'v',
			folders: [{ name: 'F', folders: [], elements: ['ghost'] }]
		};
		// 'ghost' has no body loaded yet
		const byId = new Map<string, Element>();
		// must register the node so it can be placed; buildUnifiedTree skips
		// unknown placed ids, so simulate the excluded-section path instead:
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		// Folder F is empty (ghost skipped: not in byId) -> stub, still visible.
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		expect(vis.get(folderKey(['F']))).toBe('stub');
	});
});
```

Note: the "unloaded tentatively-visible" path is exercised more directly by the excluded-section test in Task A3 (where nodes are registered without bodies). This test pins the folder-stub behaviour; A3 pins the skeleton-row behaviour.

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/view-tree-window.test.ts'`
Expected: FAIL — `flattenVisibleRows` is not exported; the in-folder order test fails (current code name-sorts to `['a','z']`).

- [ ] **Step 3: Edit `view-tree.ts`**

3a. Remove the placed-element name-sort. In `ingestFolder` delete these lines (`view-tree.ts:84-86`):

```ts
		placedElements.sort((a, b) =>
			mv.displayName(mv.elementsById.get(a)!).localeCompare(mv.displayName(mv.elementsById.get(b)!))
		);
```

so the body becomes:

```ts
		const placedElements: string[] = [];
		for (const eid of folder.elements) {
			if (!mv.elementsById.has(eid)) continue; // missing element — warning only
			if (mv.containedIds.has(eid)) continue; // contained elsewhere — warning only
			if (placementOwner.has(eid)) continue; // multi-placement — first wins
			placementOwner.set(eid, key);
			placedElements.push(eid);
			out.placedElementIds.add(eid);
		}
		childKeys.push(...placedElements); // user placement order — no name-sort
```

Update the JSDoc on `buildUnifiedTree` to state in-folder order follows `folder.elements`.

3b. Make `computeVisibility` treat an unloaded element body as tentatively visible. Change the element branch (`view-tree.ts:185-188`) from:

```ts
			if (kind === 'element') {
				const el = elementsById.get(key);
				if (el && typeFilter.has(el.type_name)) any = true;
			}
```

to:

```ts
			if (kind === 'element') {
				const el = elementsById.get(key);
				// Body not loaded yet (windowed fetch pending) -> tentatively visible
				// so the row renders as a skeleton instead of vanishing; re-evaluated
				// once the body arrives.
				if (el === undefined) any = true;
				else if (typeFilter.has(el.type_name)) any = true;
			}
```

3c. Add the pure flatten helper at the end of the file (near `computeVisibility`):

```ts
export interface FlatRow {
	key: string;
	parent: string | null;
	depth: number;
}

/**
 * Pre-order flatten of the visible rows with depth, mirroring the recursion the
 * windowed renderer would otherwise do inline. Hidden rows are skipped; `stub`
 * folders and collapsed nodes are emitted but not descended into.
 */
export function flattenVisibleRows(
	tree: UnifiedTree,
	visibility: Map<string, Visibility>,
	collapsed: ReadonlySet<string>
): FlatRow[] {
	const out: FlatRow[] = [];
	const walk = (key: string, parent: string | null, depth: number): void => {
		const vis = visibility.get(key);
		if (vis === 'hidden' || vis === undefined) return;
		out.push({ key, parent, depth });
		if (vis === 'stub') return;
		if (collapsed.has(key)) return;
		for (const c of tree.children.get(key) ?? []) walk(c, key, depth + 1);
	};
	for (const r of tree.roots) walk(r, null, 0);
	return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/view-tree-window.test.ts src/lib/components/Sidebar/view-tree-build.test.ts'`
Expected: PASS. (Verified: `view-tree-build.test.ts` only asserts single-element in-folder content (`['a']`), so removing the name-sort does **not** regress it — no edit to that file needed.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Sidebar/view-tree.ts frontend/src/lib/components/Sidebar/view-tree-window.test.ts
git commit -m "feat(view-tree): flattenVisibleRows + placement-order folders + skeleton visibility"
```

---

### Task A3: Excluded-pool section node

The "Not in view" pool is not in the view snapshot — it is the backend complement. Add a synthetic section node whose children are the loaded excluded root ids, registered as element nodes even before their bodies load (so they render as skeleton rows).

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/view-tree.ts`
- Test: `frontend/src/lib/components/Sidebar/view-tree-window.test.ts` (extend)

- [ ] **Step 1: Write the failing test (append to `view-tree-window.test.ts`)**

```ts
import {
	appendExcludedSection,
	EXCLUDED_SECTION_KEY,
	isExcludedSectionKey
} from './view-tree';

describe('appendExcludedSection', () => {
	it('adds a section root whose children are the excluded ids, registering unloaded ids as element nodes', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['placed'] }] };
		const byId = new Map([['placed', el('placed')]]); // excluded ids NOT loaded yet
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		appendExcludedSection(tree, ['x1', 'x2']);

		expect(tree.roots.at(-1)).toBe(EXCLUDED_SECTION_KEY);
		expect(isExcludedSectionKey(EXCLUDED_SECTION_KEY)).toBe(true);
		expect(tree.kind.get(EXCLUDED_SECTION_KEY)).toBe('folder');
		expect(tree.children.get(EXCLUDED_SECTION_KEY)).toEqual(['x1', 'x2']);
		// unloaded excluded ids are registered so the renderer can show skeletons
		expect(tree.kind.get('x1')).toBe('element');
		expect(tree.children.get('x1')).toEqual([]);
	});

	it('does not include an id that is already placed in a folder (defensive complement)', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['placed'] }] };
		const byId = new Map([['placed', el('placed')]]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		appendExcludedSection(tree, ['placed', 'x1']);
		expect(tree.children.get(EXCLUDED_SECTION_KEY)).toEqual(['x1']);
	});

	it('makes the section render under the type filter (folder-like, never hidden) with skeleton children visible', () => {
		const view: View = { name: 'v', folders: [] };
		const byId = new Map<string, Element>(); // nothing loaded
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		appendExcludedSection(tree, ['x1']);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		expect(vis.get(EXCLUDED_SECTION_KEY)).toBe('full'); // child tentatively visible
		expect(vis.get('x1')).toBe('full'); // unloaded body -> tentatively visible
		const rows = flattenVisibleRows(tree, vis, new Set());
		expect(rows.map((r) => r.key)).toEqual([EXCLUDED_SECTION_KEY, 'x1']);
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/view-tree-window.test.ts'`
Expected: FAIL — `appendExcludedSection` / `EXCLUDED_SECTION_KEY` / `isExcludedSectionKey` are not exported.

- [ ] **Step 3: Add to `view-tree.ts`**

Near `FOLDER_KEY_PREFIX` / `VIEW_ROOT_DROP_KEY`:

```ts
/**
 * Sentinel key for the "Not in view" excluded-pool section header. Starts with
 * NUL so it can never collide with an element id, and is distinct from any
 * folder key (which start with FOLDER_KEY_PREFIX) and from VIEW_ROOT_DROP_KEY.
 */
export const EXCLUDED_SECTION_KEY = NUL + 'X' + NUL;

export function isExcludedSectionKey(key: string): boolean {
	return key === EXCLUDED_SECTION_KEY;
}
```

After `buildUnifiedTree` (or anywhere top-level), add:

```ts
/**
 * Append the "Not in view" excluded-pool section to a built tree as its last
 * root. `excludedRootIds` are the loaded complement roots (backend order). Ids
 * already placed in a folder are dropped (defensive — the complement endpoint
 * already excludes them). Unloaded ids are registered as empty element nodes so
 * the windowed renderer can show skeleton rows until `ensureElements` fills the
 * body. Mutates `tree` in place (consistent with how buildUnifiedTree seeds).
 */
export function appendExcludedSection(tree: UnifiedTree, excludedRootIds: string[]): void {
	const kids = excludedRootIds.filter((id) => !tree.placedElementIds.has(id));
	tree.kind.set(EXCLUDED_SECTION_KEY, 'folder');
	tree.folderName.set(EXCLUDED_SECTION_KEY, 'Not in view');
	tree.children.set(EXCLUDED_SECTION_KEY, kids);
	for (const id of kids) {
		if (!tree.kind.has(id)) tree.kind.set(id, 'element');
		if (!tree.children.has(id)) tree.children.set(id, []);
	}
	tree.roots.push(EXCLUDED_SECTION_KEY);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/view-tree-window.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Sidebar/view-tree.ts frontend/src/lib/components/Sidebar/view-tree-window.test.ts
git commit -m "feat(view-tree): excluded-pool section node (Not in view)"
```

---

### Task A4: Extract `TreeRow.svelte` (single non-recursive row)

Windowing renders a flat list, so rows can no longer mount their own children recursively. Extract one row's markup from `TreeNode.svelte` into `TreeRow.svelte`. It renders a folder header, the excluded-section header (count badge, no rename/delete menu), or an element row, given a resolved `FlatRow` + flags. It keeps the same `data-drop-key` / `data-drop-path` contract and the `onpointerdown` drag hook. **No `<Self>` recursion, no `<ul>` nesting.**

**Files:**
- Create: `frontend/src/lib/components/Sidebar/TreeRow.svelte`
- Reference (copy markup/idioms from): `frontend/src/lib/components/Sidebar/TreeNode.svelte`

- [ ] **Step 1: Create `TreeRow.svelte`**

Props (one row, fully resolved by the parent):

```ts
type Props = {
	row: { key: string; parent: string | null; depth: number };
	tree: UnifiedTree;
	elementsById: Map<string, Element>;
	visibility: Map<string, Visibility>;
	collapsed: Set<string>;
	childCounts: Map<string, number>;
	excludedTotal: number; // count shown on the "Not in view" header
	folderOptions: { path: string[]; label: string }[];
	warningsByElementId: Set<string>;
	selectedId: string | null;
	multiSelectedIds: Set<string>;
	focusedId: string | null;
	dnd: DndContext;
	onToggle: (key: string) => void;
	onPick: (key: string, e: MouseEvent) => void;
	onMoveToFolder: (elementId: string, path: string[] | null) => Promise<void> | void;
};
```

Row container MUST be a fixed height for windowing. Use `ROW_H = 24` (set on the parent; here apply `class="h-6"` and `style="padding-left: {row.depth * 12 + 4}px"`). Three branches keyed on `row.key`:

1. `isExcludedSectionKey(row.key)` → a header styled like a folder but: label "Not in view", a count badge `({excludedTotal})`, a chevron toggling `collapsed`, `data-drop-key={EXCLUDED_SECTION_KEY}` and `data-drop-path="null"` (drop here = exclude, i.e. place at empty path — see Phase B), **no** dropdown menu. It is NOT a pointer-drag source (no `onpointerdown` drag start).
2. `isFolderKey(row.key)` → the existing folder header markup from `TreeNode.svelte:129-190` (chevron, folder icon, name, `empty` stub badge, the New/Rename/Delete dropdown, `data-drop-*`, `onpointerdown` folder drag). Reuse `createFolder/renameFolder/deleteFolder` imports.
3. element → the existing element row markup from `TreeNode.svelte:216-289` (chevron for unloaded/loaded children, name button, type badge, error/warning icons, the Move-to-folder dropdown, `onpointerdown` element drag). If `el` is undefined (body not yet fetched) render a **skeleton**: a muted bar (`<span class="h-3 w-24 animate-pulse rounded bg-zinc-800">`) instead of name/type, no dropdown, still a valid drag source only if `tree`-movable (skip drag when body unknown — `movableElementIds` already only includes known/placed ids).

Derive the same flags as `TreeNode` (`hasChildren`, `isCollapsed`, `isSelected`, `isMultiSelected`, `isFocused`, `isDropHover`, `hasError`, etc.) but for the single `row.key`. **Do not** render children — the parent's windowed list emits child rows as their own `TreeRow`.

Chevron `onToggle`, name `onPick`, indentation via `row.depth` — identical semantics to today. Import the helpers from `./view-tree` (`isFolderKey`, `isExcludedSectionKey`, `folderPathFromKey`, types).

- [ ] **Step 2: Type-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors. (TreeRow is not yet mounted anywhere; this only checks it compiles. If `npm run check` errors because TreeRow is unreferenced, that's fine — `svelte-check` does not error on unused components; resolve any real type errors.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/Sidebar/TreeRow.svelte
git commit -m "feat(view-tree): TreeRow — single non-recursive row component"
```

---

### Task A5: Windowed render + windowed body fetch (replace recursion & eager fetch & "Show more")

Rewire `ContainmentTree.svelte` to render the flattened `visibleRows` as a windowed list of `TreeRow`s, fetch only on-screen bodies via `ensureElements`, and delete the eager per-element fetch effect and the "Show more" button. This is the central integration task — verified by `svelte-check` + the existing/updated e2e.

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`
- Delete: `frontend/src/lib/components/Sidebar/TreeNode.svelte` (after the windowed render replaces it)

- [ ] **Step 1: Replace the `visibleRows` derivation with the pure flatten**

Replace the inline walk (`ContainmentTree.svelte:291-304`) with:

```ts
	import { flattenVisibleRows, type FlatRow } from './view-tree';
	// ...
	const visibleRows = $derived<FlatRow[]>(flattenVisibleRows(tree, visibility, collapsedSet));
```

(`focusedIndex`, `moveTo`, `onKeyDown`, the `onPick`/multi-select code already operate on `visibleRows[i].key` — they keep working with `FlatRow`.)

- [ ] **Step 2: Add windowing state + scroll wiring**

Add near the other component state:

```ts
	import { computeWindow, shouldLoadMore } from './windowing';

	const ROW_H = 24;
	const OVERSCAN = 8;
	const LOAD_THRESHOLD = OVERSCAN * 2;

	let scrollEl: HTMLElement | null = $state(null);
	let scrollTop = $state(0);
	let viewportH = $state(0);

	const windowSlice = $derived(
		computeWindow({ scrollTop, viewportH, rowH: ROW_H, total: visibleRows.length, overscan: OVERSCAN })
	);
	const windowedRows = $derived(visibleRows.slice(windowSlice.start, windowSlice.end));

	function onScroll(): void {
		if (scrollEl) scrollTop = scrollEl.scrollTop;
	}

	// Track viewport height (ResizeObserver) so the window sizes itself.
	$effect(() => {
		if (!scrollEl) return;
		viewportH = scrollEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (scrollEl) viewportH = scrollEl.clientHeight;
		});
		ro.observe(scrollEl);
		return () => ro.disconnect();
	});
```

- [ ] **Step 3: Windowed body fetch — replace the eager fetch effect**

Delete the eager view-walk effect (`ContainmentTree.svelte:178-191`). Add an effect that fetches only the on-screen element bodies:

```ts
	import { ensureElements } from '$lib/state';
	// ...
	$effect(() => {
		const ids = windowedRows.map((r) => r.key).filter((k) => !isFolderKey(k) && !isExcludedSectionKey(k));
		if (ids.length > 0) void ensureElements(ids);
	});
```

`ensureElements` already dedups against the cache and in-flight batches, so re-running on every scroll is cheap. Import `isExcludedSectionKey` from `./view-tree` and add `ensureElements` to the `$lib/state` import. **Verified:** `ensureElement` is used in `ContainmentTree.svelte` *only* by the eager effect being deleted (line 190) — so remove the `ensureElement` name from the `$lib/state` import too (it stays exported for the Inspector/other callers).

- [ ] **Step 4: Replace the markup — windowed list of `TreeRow`**

Replace the `<ul>…{#each tree.roots}…<TreeNode/>…</ul>` block plus the "Show more" button (`ContainmentTree.svelte:709-741`) with a spacer-padded windowed list. Bind the scroll container:

```svelte
	<div
		bind:this={scrollEl}
		class="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2 outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
		tabindex="0"
		role="tree"
		aria-label="Containment tree"
		onkeydown={onKeyDown}
		onclickcapture={onTreeClickCapture}
		onscroll={onScroll}
	>
		{#if mm === null}
			<p class="text-xs text-zinc-600">Load a metamodel and model to begin.</p>
		{:else if (summary?.element_count ?? 0) === 0 && tree.roots.length === 0}
			<p class="text-xs text-zinc-600">Model is empty.</p>
		{:else}
			{#if view !== null && draggingPayload !== null}
				<!-- keep the existing VIEW_ROOT_DROP_KEY dropzone block here -->
			{/if}
			<div style="height: {windowSlice.padTop}px"></div>
			<ul class="flex flex-col text-xs" role="group">
				{#each windowedRows as row (row.key)}
					<TreeRow
						{row}
						{tree}
						{elementsById}
						{visibility}
						collapsed={collapsedSet}
						{childCounts}
						excludedTotal={excludedTotal}
						{folderOptions}
						{warningsByElementId}
						selectedId={selection?.kind === 'element' ? selection.id : null}
						multiSelectedIds={multiSelected}
						{focusedId}
						dnd={dndContext}
						onToggle={toggleCollapsed}
						{onPick}
						{onMoveToFolder}
					/>
				{/each}
			</ul>
			<div style="height: {windowSlice.padBottom}px"></div>
		{/if}
	</div>
```

Notes:
- The scroll container was previously the `class="… gap-1 …"` flex column; **remove `gap-1`** — windowing needs deterministic row heights (the gap would desync `padTop/padBottom`). `TreeRow` carries its own `h-6`.
- `excludedTotal` is introduced in Task A6; until then pass `0`.
- Import `TreeRow` and delete the `TreeNode` import. Once nothing imports `TreeNode.svelte`, `git rm` it.

- [ ] **Step 5: Type-check + existing e2e author-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

Run the full frontend unit suite to catch collateral breakage:
`pixi run -e frontend bash -c 'cd frontend && npx vitest run'`
Expected: PASS (the existing `view-tree`/store tests still green; no test imports `TreeNode`).

If a browser is available: `pixi run -e frontend bash -c 'cd frontend && npx playwright test e2e/view.spec.ts'` — the existing curated-scope test should still pass (Beta still absent until A6). If no browser, note it.

- [ ] **Step 6: Commit**

```bash
git rm frontend/src/lib/components/Sidebar/TreeNode.svelte
git add -A frontend/src/lib/components/Sidebar/ContainmentTree.svelte
git commit -m "feat(view-tree): virtualized windowed render + windowed body fetch; drop Show more & eager fetch"
```

---

### Task A6: Excluded-pool fetch, section wiring & auto-load on scroll

Load the excluded complement when a view is active, append the section, and auto-page it as the window nears the end. Also auto-page the no-view containment roots (replacing the removed "Show more"), and auto-page expanded containment child levels.

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`
- Modify: `frontend/src/lib/api/model-read.ts` reference (already has `listExcludedRootsPaged`)

- [ ] **Step 1: Add excluded-pool state + fetch**

```ts
	import { listExcludedRootsPaged } from '$lib/api/model-read';

	let excludedRoots: ContainmentItem[] = $state([]);
	let excludedTotal = $state(0);
	let excludedLimit = $state(PAGE_LIMIT);

	async function refreshExcluded(seq: number, limit: number): Promise<void> {
		try {
			const page = await listExcludedRootsPaged(limit);
			if (seq !== loadSeq) return;
			seedElements(page.items.map((i) => i.element));
			excludedRoots = page.items;
			excludedTotal = page.total;
		} catch (err) {
			if (seq === loadSeq) console.error('Excluded pool load failed', err);
		}
	}
```

Wire it into the existing fetch effect (`ContainmentTree.svelte:158-176`): when `view !== null`, call `refreshExcluded(seq, excludedLimit)` (track `excludedLimit`); when `view === null`, clear `excludedRoots`/`excludedTotal`. Keep the existing `refreshLevels` for no-view roots + expanded child levels. The excluded roots' `child_count` must feed `childCounts` so their expanders work — extend the `childCounts` derivation (`:221-228`) to also iterate `excludedRoots`.

- [ ] **Step 2: Append the section to the tree**

After the `buildUnifiedTree` derivation (`:230-239`), append the section when a view is active:

```ts
	import { appendExcludedSection } from './view-tree';

	const tree = $derived.by(() => {
		const t = buildUnifiedTree(view, rootElementIds, elementsById, containmentChildren, containedIds, displayName);
		if (view !== null) {
			const ids = excludedRoots.map((i) => i.element.id);
			appendExcludedSection(t, ids);
		}
		return t;
	});
```

Pass `excludedTotal` to `TreeRow` (Task A5 placeholder → real value).

- [ ] **Step 3: Auto-load on scroll (no buttons)**

Add an effect that grows the relevant limit when the window nears the end of the loaded rows:

```ts
	$effect(() => {
		const end = windowSlice.end;
		if (view !== null) {
			// excluded pool is the last region; grow it when the window nears its tail
			if (shouldLoadMore({ windowEnd: end, loadedCount: excludedRoots.length, total: excludedTotal, threshold: LOAD_THRESHOLD })) {
				excludedLimit = excludedRoots.length + PAGE_LIMIT;
			}
		} else {
			if (shouldLoadMore({ windowEnd: end, loadedCount: roots.length, total: rootsTotal, threshold: LOAD_THRESHOLD })) {
				rootsLimit = roots.length + PAGE_LIMIT;
			}
		}
	});
```

`rootsLimit`/`excludedLimit` are tracked by the fetch effect, which re-pages via the `…Paged` helpers. Because `windowSlice.end` is in flattened-row space and the excluded section sits at the tail, "window near end" ⇒ "near the end of the pool", which is the intended trigger. (Expanded containment child-level auto-paging beyond the first 500 remains a known limit — deeper levels render their first page, same as today; do not silently hide that — keep the existing inline note.)

- [ ] **Step 4: Structural-refetch reset**

The existing effects already reset `rootsLimit = PAGE_LIMIT` on model swap (`:153-156`) and refetch on `structureRev` (`:158`). Add the parallel reset for the pool: in the model-swap effect set `excludedLimit = PAGE_LIMIT`, and on each structural refetch the `refreshExcluded` call re-pages from the current `excludedLimit` (which the user may have grown) — acceptable; to fully reset on structural change instead, also reset `excludedLimit = PAGE_LIMIT` in an effect tracking `getStructureRev()`. Choose the reset-to-first-page behaviour (matches the spec's "reset … to their first page" decision) — add:

```ts
	$effect(() => {
		void getStructureRev();
		void getModelGeneration();
		excludedLimit = PAGE_LIMIT; // structural change / swap -> pool back to page 1
	});
```

- [ ] **Step 5: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'` → 0 errors.
Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run'` → PASS.

- [ ] **Step 6: Update the e2e curated-scope assertion (Beta now visible in the pool)**

In `frontend/e2e/view.spec.ts`, replace the `TODO(plan-2)` block (currently `await expect(tree.getByText('Beta')).toHaveCount(0)`) with an assertion that Beta now renders under the "Not in view" section:

```ts
	// Beta is unplaced -> it lives in the auto-loaded "Not in view" pool.
	await expect(tree.getByText('Not in view')).toBeVisible();
	await expect(tree.getByText('Beta')).toBeVisible();
```

Run (if browser available): `pixi run -e frontend bash -c 'cd frontend && npx playwright test e2e/view.spec.ts'`. If no browser, author the change and report it was not executed.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/src/lib/components/Sidebar/ContainmentTree.svelte frontend/e2e/view.spec.ts
git commit -m "feat(view-tree): excluded pool section + auto-load on scroll (no Show more)"
```

**Phase A is complete and shippable here:** the curated view renders, the pool shows all unplaced roots and auto-loads, only on-screen bodies are fetched, no "Show more" remains. Existing append-on-drop curation still works.

---

# Phase B — DnD curation & search-to-curate

Phase B adds positional curation gestures and makes drags reach off-screen targets under virtualization, plus dragging a search result into a folder.

### Task B1: Positional place mutator

`placeElements` appends. Add a positional variant so a drop can land at a specific index (include-at-index and intra-folder reorder).

**IMPORTANT — no existing store-mutator test harness.** Verified: the only view test is `frontend/src/lib/state/__tests__/view-ops.test.ts`, which already covers the **pure** transform `placeElementsInViewAt` exhaustively (positional insert, reorder, cross-folder move, clamp, exclude, dedup, no-mutation). There is no MSW test for the `view.svelte.ts` store mutators — `placeElements`/`placeElement` themselves ship validated only by the pure helper + e2e. `placeElementsAt` is a 3-line wrapper (`placeElementsInViewAt` + `pushView`) identical in shape to the already-shipped `placeElements`. So this task does **not** invent a new MSW harness for one trivial wrapper: it adds the wrapper and relies on the existing pure-helper coverage plus the B5 e2e (include-at-index + reorder + persist-across-reload). This is a deliberate, consistent exception to TDD for a trivial delegation over a fully-tested function — not a coverage gap.

**Files:**
- Modify: `frontend/src/lib/state/view.svelte.ts`
- Modify: `frontend/src/lib/state/index.ts` (export)

- [ ] **Step 1: Sanity-check the pure helper is already covered**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/view-ops.test.ts'`
Expected: PASS — confirms `placeElementsInViewAt` behaviour the wrapper delegates to is locked in.

- [ ] **Step 2: Implement in `view.svelte.ts`**

```ts
import { /* … */ placeElementsInViewAt } from './view-ops';

/**
 * Positional variant of {@link placeElements}: move every id in `ids` into the
 * folder at `path`, inserted at `index` among that folder's elements (used by
 * drag-to-reorder and include-at-drop-index). Empty `path` excludes the ids.
 */
export async function placeElementsAt(path: string[], ids: string[], index: number): Promise<void> {
	if (_view === null) throw new Error('No active view');
	await pushView(placeElementsInViewAt(_view, path, ids, index));
}
```

Export `placeElementsAt` from `src/lib/state/index.ts` (next to `placeElements`).

- [ ] **Step 3: Type-check**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/state/view.svelte.ts frontend/src/lib/state/index.ts
git commit -m "feat(view-store): placeElementsAt positional mutator"
```

---

### Task B2: Drop-target resolution helper (folder vs element-row index vs exclude)

A drop can land on a folder header (append), on an element row (insert before/after by pointer half), or on the excluded-section header (exclude). Encode the resolution in a pure helper so the rule is testable; the component only supplies pointer geometry.

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/view-tree.ts`
- Test: `frontend/src/lib/components/Sidebar/view-tree-window.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
import { resolveElementDrop } from './view-tree';

describe('resolveElementDrop', () => {
	it('folder header drop -> append into that folder (index at end)', () => {
		const r = resolveElementDrop({ targetKind: 'folder', folderPath: ['F'], folderLen: 3 });
		expect(r).toEqual({ path: ['F'], index: 3 });
	});
	it('excluded-section drop -> exclude (empty path)', () => {
		const r = resolveElementDrop({ targetKind: 'section' });
		expect(r).toEqual({ path: [], index: 0 });
	});
	it('element-row drop, top half -> insert before the sibling', () => {
		const r = resolveElementDrop({ targetKind: 'element', folderPath: ['F'], siblingIndex: 2, half: 'top' });
		expect(r).toEqual({ path: ['F'], index: 2 });
	});
	it('element-row drop, bottom half -> insert after the sibling', () => {
		const r = resolveElementDrop({ targetKind: 'element', folderPath: ['F'], siblingIndex: 2, half: 'bottom' });
		expect(r).toEqual({ path: ['F'], index: 3 });
	});
	it('element-row drop in the excluded pool -> exclude (no reorder in the pool)', () => {
		const r = resolveElementDrop({ targetKind: 'element', folderPath: null, siblingIndex: 0, half: 'top' });
		expect(r).toEqual({ path: [], index: 0 });
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/view-tree-window.test.ts'`
Expected: FAIL — `resolveElementDrop` not exported.

- [ ] **Step 3: Implement in `view-tree.ts`**

```ts
export type ElementDropResolution = { path: string[]; index: number };

/**
 * Resolve where a dragged element selection should land, given the row under
 * the pointer. Folder header -> append (index = folderLen). Excluded section or
 * a row in the pool (`folderPath === null`) -> exclude (empty path). Element row
 * inside a folder -> insert before/after the hovered sibling by pointer half.
 */
export function resolveElementDrop(args: {
	targetKind: 'folder' | 'element' | 'section';
	folderPath?: string[] | null;
	folderLen?: number;
	siblingIndex?: number;
	half?: 'top' | 'bottom';
}): ElementDropResolution {
	const { targetKind, folderPath, folderLen, siblingIndex, half } = args;
	if (targetKind === 'section') return { path: [], index: 0 };
	if (targetKind === 'folder') return { path: folderPath ?? [], index: folderLen ?? 0 };
	// element row
	if (folderPath == null) return { path: [], index: 0 }; // pool row -> exclude
	const base = siblingIndex ?? 0;
	return { path: folderPath, index: half === 'bottom' ? base + 1 : base };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/components/Sidebar/view-tree-window.test.ts'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Sidebar/view-tree.ts frontend/src/lib/components/Sidebar/view-tree-window.test.ts
git commit -m "feat(view-tree): resolveElementDrop — folder/append, row/reorder, pool/exclude"
```

---

### Task B3: Wire positional drop, reorder & exclude into the tree DnD

Make element rows drop targets that carry their folder path + sibling index + the hovered half, the excluded-section header a drop target for exclude, and route the drop through `resolveElementDrop` + `placeElementsAt`. Add edge auto-scroll so off-screen targets reach the window.

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`
- Modify: `frontend/src/lib/components/Sidebar/TreeRow.svelte`

- [ ] **Step 1: Make element rows + the section drop targets in `TreeRow.svelte`**

- On an **element row inside a folder** (it has a `folderPath` from its parent — pass `parentFolderPath: string[] | null` and `siblingIndex: number` as props computed by the parent from the flattened tree), add `data-drop-key={row.key}`, `data-drop-kind="element"`, `data-drop-path={JSON.stringify(parentFolderPath)}`, and `data-sibling-index={siblingIndex}`.
- On the **excluded-section header**, keep `data-drop-key={EXCLUDED_SECTION_KEY}`, add `data-drop-kind="section"`, `data-drop-path="null"`.
- Folder headers already have `data-drop-key`/`data-drop-path`; add `data-drop-kind="folder"` and `data-folder-len={(tree.children.get(row.key)?.length ?? 0)}`.

The parent computes `parentFolderPath` for each flat row: if `row.parent` is a folder key → `folderPathFromKey(row.parent)`; if `row.parent` is the section or null → `null`. Add this to the `FlatRow` consumption (a small map in the component, or extend `flattenVisibleRows` to also emit `parentFolderPath` — prefer computing in the component to keep the pure helper minimal).

- [ ] **Step 2: Resolve drop in `ContainmentTree.svelte`**

Extend `dropTargetAt` (`:469-476`) to also read `data-drop-kind`, `data-sibling-index`, `data-folder-len`, and the pointer's vertical half within the hit row's bounding rect:

```ts
	function dropTargetAt(x: number, y: number): {
		key: string;
		kind: 'folder' | 'element' | 'section';
		path: string[] | null;
		folderLen: number;
		siblingIndex: number;
		half: 'top' | 'bottom';
	} | null {
		const hit = document.elementFromPoint(x, y);
		const el = hit?.closest<HTMLElement>('[data-drop-key]') ?? null;
		if (el === null) return null;
		const raw = el.dataset.dropPath ?? 'null';
		const path = raw === 'null' ? null : (JSON.parse(raw) as string[]);
		const rect = el.getBoundingClientRect();
		const half: 'top' | 'bottom' = y < rect.top + rect.height / 2 ? 'top' : 'bottom';
		return {
			key: el.dataset.dropKey ?? '',
			kind: (el.dataset.dropKind as 'folder' | 'element' | 'section') ?? 'folder',
			path,
			folderLen: Number(el.dataset.folderLen ?? '0'),
			siblingIndex: Number(el.dataset.siblingIndex ?? '0'),
			half
		};
	}
```

In `onWindowPointerUp` (`:525-546`), for an element payload route through the resolver:

```ts
	if (payload.kind === 'element') {
		const res = resolveElementDrop({
			targetKind: target.kind,
			folderPath: target.path,
			folderLen: target.folderLen,
			siblingIndex: target.siblingIndex,
			half: target.half
		});
		await placeElementsAt(res.path, payload.ids, res.index);
	} else {
		await moveFolder(payload.path, target.path ?? []);
	}
```

Import `resolveElementDrop`, `placeElementsAt`. `dropAllowed`/`canDropElement` are unchanged (validity is destination-independent; a pool row and a folder row are both valid element targets — the resolver picks the semantics).

- [ ] **Step 3: Edge auto-scroll during drag**

In `onWindowPointerMove` (`:510-523`), after computing hover, drive an rAF loop that scrolls `scrollEl` by `edgeScrollDelta` while the pointer sits in an edge band:

```ts
	import { edgeScrollDelta } from './windowing';
	const EDGE_PX = 36;
	const MAX_SCROLL_SPEED = 18;
	let autoScrollRaf = 0;
	let lastPointerY = 0;

	function tickAutoScroll(): void {
		autoScrollRaf = 0;
		if (!dragging || !scrollEl) return;
		const rect = scrollEl.getBoundingClientRect();
		const dy = edgeScrollDelta({ pointerY: lastPointerY, top: rect.top, bottom: rect.bottom, edge: EDGE_PX, maxSpeed: MAX_SCROLL_SPEED });
		if (dy !== 0) {
			scrollEl.scrollTop += dy;
			scrollTop = scrollEl.scrollTop;
			// re-hit-test after the scroll so hover follows the moving content
			const t = dropTargetAt(lastPointerX, lastPointerY);
			dragHoverKey = t?.key ?? null;
			dragHoverValid = t !== null && dropAllowed(t.path);
		}
		autoScrollRaf = requestAnimationFrame(tickAutoScroll);
	}
```

Track `lastPointerX`/`lastPointerY` in `onWindowPointerMove`; start the rAF loop there if not running; cancel it in `endGesture` (`cancelAnimationFrame(autoScrollRaf); autoScrollRaf = 0`). Use `requestAnimationFrame` directly (no `Date.now`/timers).

- [ ] **Step 4: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'` → 0 errors.
Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run'` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A frontend/src/lib/components/Sidebar/ContainmentTree.svelte frontend/src/lib/components/Sidebar/TreeRow.svelte
git commit -m "feat(view-tree): DnD include-at-index, reorder, exclude + edge auto-scroll"
```

---

### Task B4: Shared drag controller + drag-from-search

Lift the pointer-drag state so a `Search` result can start an element drag that the tree completes. Extract the controller into `tree-drag.svelte.ts`; `ContainmentTree` owns the drop surface (its `data-drop-*` rows) and consumes the controller; `Search` result rows call `beginDrag` with the element payload.

**Files:**
- Create: `frontend/src/lib/state/tree-drag.svelte.ts`
- Test: `frontend/src/lib/state/__tests__/tree-drag.test.ts`
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`, `frontend/src/lib/components/Sidebar/Search.svelte`

Design: keep the geometry/DOM hit-testing in `ContainmentTree` (it owns `scrollEl` and the rows). The shared module holds only the **payload + lifecycle state** both components need:

```ts
// tree-drag.svelte.ts
export type DragPayload = { kind: 'element'; ids: string[] } | { kind: 'folder'; path: string[] };
let _payload = $state<DragPayload | null>(null);
let _active = $state(false);
export function getDragPayload(): DragPayload | null { return _payload; }
export function isDragActive(): boolean { return _active; }
export function beginDrag(p: DragPayload): void { _payload = p; _active = true; }
export function endDrag(): void { _payload = null; _active = false; }
```

- [ ] **Step 1: Write the failing test**

```ts
// tree-drag.test.ts — pin the lifecycle state transitions
import { describe, expect, it } from 'vitest';
import { beginDrag, endDrag, getDragPayload, isDragActive } from '../tree-drag.svelte';

describe('tree-drag controller', () => {
	it('begins and ends an element drag', () => {
		expect(isDragActive()).toBe(false);
		beginDrag({ kind: 'element', ids: ['a', 'b'] });
		expect(isDragActive()).toBe(true);
		expect(getDragPayload()).toEqual({ kind: 'element', ids: ['a', 'b'] });
		endDrag();
		expect(isDragActive()).toBe(false);
		expect(getDragPayload()).toBeNull();
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run src/lib/state/__tests__/tree-drag.test.ts'`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the module** (as above), then refactor `ContainmentTree.svelte` to use it for the shared payload: replace its local `draggingPayload` writes with `beginDrag`/`endDrag` + `getDragPayload()`, keeping all geometry (pointer move/up, hit-testing, auto-scroll) local. The window pointer-move/up listeners must be attached when a drag starts from **either** source, so move the `window.addEventListener(...)` registration into a shared `attachDragListeners()` that `ContainmentTree` mounts once (e.g. in an `$effect` that runs while `isDragActive()` and `view !== null`).

- [ ] **Step 4: Make search results drag sources**

In `Search.svelte`, add to each result `<li>`/button: `style="touch-action: none"` and `onpointerdown` that, on primary button + threshold, calls `beginDrag({ kind: 'element', ids: [el.id] })` and seeds the element (already seeded via `seedElements(page.items)` on search). Reuse the same 4px threshold idiom. The element must be known to the tree's `knownIds` for `canDropElement` to accept it — since search `seedElements` the results into the cache, and the tree's `knownIds = new SvelteSet(elementsById.keys())`, dropped search elements are known. Confirm: a search result that is a **containment root** (movable) drops into a folder; a contained element is rejected by `canDropElement` (not movable) — acceptable and correct.

Because the drop completion (pointermove/up + `placeElementsAt`) lives in `ContainmentTree`, ensure its drag listeners are active whenever `isDragActive()` (Step 3). When the drag starts from search, `ContainmentTree`'s `$effect` sees `isDragActive()` flip true and attaches the listeners; the existing `dropTargetAt`/`onWindowPointerUp` then resolve the drop over the tree rows.

- [ ] **Step 5: Verify**

Run: `pixi run -e frontend bash -c 'cd frontend && npm run check'` → 0 errors.
Run: `pixi run -e frontend bash -c 'cd frontend && npx vitest run'` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src/lib/state/tree-drag.svelte.ts frontend/src/lib/state/__tests__/tree-drag.test.ts frontend/src/lib/components/Sidebar/ContainmentTree.svelte frontend/src/lib/components/Sidebar/Search.svelte
git commit -m "feat(view-tree): shared drag controller + drag-from-search into folders"
```

---

### Task B5: e2e coverage for curation

Author Playwright coverage for the curation gestures. Run if a browser is available; otherwise author and report not-executed (consistent with Plan 1).

**Files:**
- Modify: `frontend/e2e/view.spec.ts`

- [ ] **Step 1: Add a curation e2e test**

Bootstrap as the existing tests (load metamodel + the Alpha/Beta model + the Operational view with `Grouped = [Alpha]`). Then, driving pointer events (Playwright `mouse.move/down/up`, since the app uses pointer-DnD — use `page.mouse` with `dispatchEvent` for `pointerdown/move/up` on the row elements, matching how any existing DnD e2e drives it; check the repo for an existing pointer-DnD helper before hand-rolling):

- **Include:** drag Beta from "Not in view" onto the "Grouped" folder header → assert Beta now renders under Grouped and is gone from "Not in view"; reload the page and assert it persisted (the view was pushed).
- **Exclude:** drag Alpha from "Grouped" onto the "Not in view" header → assert Alpha appears in the pool and Grouped no longer lists it.
- **Reorder:** with two elements placed in one folder, drag the second above the first → assert order flips; reload → assert persisted.
- **Search-to-curate:** type Beta's name in Search, drag the result onto "Grouped" → assert Beta placed.

- [ ] **Step 2: Run if possible**

Run: `pixi run -e frontend bash -c 'cd frontend && npx playwright test e2e/view.spec.ts'`
Expected: PASS. If no browser, report not-executed.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/view.spec.ts
git commit -m "test(e2e): view curation — include, exclude, reorder, search-to-curate"
```

---

## Final verification (after all tasks)

- [ ] Full frontend unit suite: `pixi run -e frontend bash -c 'cd frontend && npx vitest run'` → all PASS.
- [ ] `pixi run -e frontend bash -c 'cd frontend && npm run check'` → 0 errors.
- [ ] Backend unchanged — sanity: `pixi run -e core-dev pytest tests/api/test_read_routes.py -q` still green.
- [ ] e2e authored; run if browser available and report status.
- [ ] Dispatch the final holistic code review (subagent-driven-development terminal step), then **superpowers:finishing-a-development-branch** — the branch is feature-complete only after Phase B.

## Risks & known limits (carry forward into review)

- **Fixed row height** (`ROW_H = 24`) is assumed uniform; a row that wraps would desync the spacers. Keep rows single-line (`truncate`) — they already are. The skeleton row must also be `h-6`.
- **Window-end ⇒ pool-end** auto-load relies on the excluded section being the last region. If future work adds regions below it, revisit `shouldLoadMore` wiring.
- **Deep expanded containment levels** still render only their first 500 children (pre-existing limit) — keep the inline note; do not silently truncate.
- **e2e pointer-DnD** is environment-sensitive (the app deliberately uses pointer events, not native HTML5 DnD); verify the chosen Playwright pointer-driving approach against any existing DnD e2e helper in the repo.
- **Drag-from-search** depends on `ContainmentTree` being mounted with an active view (the drop surface). Dragging a search result with no active view has nowhere to drop — guard `beginDrag` from search on `getView() !== null` (or simply let `dropTargetAt` return null and the drag no-op).
