# Excluded-pool Split Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the "Not in view" excluded pool out of the containment tree into a separate, collapsible, resizable panel pinned to the bottom of the tree region, with cross-panel drag-and-drop and no fetching while collapsed.

**Architecture:** Keep one component (`ContainmentTree`) owning the tree machinery (unified tree, element cache, DnD controller, child prefetch); render its rows into two independent scroll viewports. Extract the new, isolated logic into a pure `split.ts` (sizing math, unit-tested) and a controlled presentational `VerticalSplit.svelte`. Cross-panel DnD reuses the existing `document.elementFromPoint` hit-testing and the global drag store.

**Tech Stack:** SvelteKit 5 (runes), TypeScript, Tailwind, Vitest (happy-dom), Playwright. Run everything through `pixi`.

---

## Reference commands

- Single vitest file: `pixi run -e frontend npm --prefix frontend test -- --run <file>`
- Full vitest suite: `pixi run -e frontend npm --prefix frontend test -- --run`
- Type check: `pixi run -e frontend npm --prefix frontend run check`
- A single E2E spec: `pixi run -e frontend npm --prefix frontend run test:e2e -- view.spec.ts`
- Lint a file: `pixi run -e frontend bash -c "cd frontend && npx eslint <path>"`

All file paths below are relative to the repo root.

---

## File structure

**Create:**
- `frontend/src/lib/components/Sidebar/split.ts` — pure sizing geometry (`panelHeights`, `clampRatio`).
- `frontend/src/lib/components/Sidebar/split.test.ts` — unit tests for `split.ts`.
- `frontend/src/lib/components/Sidebar/VerticalSplit.svelte` — controlled split shell (divider + collapse).

**Modify:**
- `frontend/src/lib/components/Sidebar/view-tree.ts` — add `excludedRoots` to `UnifiedTree`; replace `appendExcludedSection` with `registerExcludedRoots`; let `computeVisibility` cover excluded roots; add a `roots` param to `flattenVisibleRows`; point `movableElementIds` at `excludedRoots`.
- `frontend/src/lib/components/Sidebar/view-tree-window.test.ts` — replace the `appendExcludedSection` tests with `registerExcludedRoots` tests; update the flatten expectation.
- `frontend/src/lib/components/Sidebar/ContainmentTree.svelte` — two viewports + windowing, pool fetch gate, localStorage persistence, edge-scroll viewport selection, render restructure with `VerticalSplit`.
- `frontend/e2e/view.spec.ts` — update for the collapsed-by-default pool panel and add coverage for collapse/persist/no-fetch.

`TreeRow.svelte` is intentionally left unchanged — its `isExcludedSection` branch becomes dead (no `EXCLUDED_SECTION_KEY` row is ever produced) but is harmless; ripping out the `excludedTotal` prop is unrelated churn (YAGNI).

---

## Task 1: Pure split sizing math (`split.ts`)

**Files:**
- Create: `frontend/src/lib/components/Sidebar/split.ts`
- Test: `frontend/src/lib/components/Sidebar/split.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/lib/components/Sidebar/split.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { panelHeights, clampRatio } from './split';

const BASE = { headerH: 28, dividerH: 4, minPanelH: 60 };

describe('panelHeights', () => {
	it('collapsed: pool shows only its header, tree gets the rest', () => {
		const h = panelHeights({ containerH: 400, ratio: 0.5, collapsed: true, ...BASE });
		expect(h).toEqual({ topH: 372, bottomH: 0 });
	});

	it('expanded 0.5: splits the expandable area evenly', () => {
		// expandable = 428 - 28 - 4 = 396; topH = round(396*0.5) = 198
		const h = panelHeights({ containerH: 428, ratio: 0.5, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 198, bottomH: 198 });
	});

	it('clamps the top panel to the min so the pool keeps minPanelH', () => {
		const h = panelHeights({ containerH: 428, ratio: 0.99, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 336, bottomH: 60 }); // 396 - 60
	});

	it('clamps the top panel up to the min', () => {
		const h = panelHeights({ containerH: 428, ratio: 0.01, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 60, bottomH: 336 });
	});

	it('container too short for two mins: the top panel yields first', () => {
		// expandable = 80 - 28 - 4 = 48 <= minPanelH(60) -> bottomH = 48, topH = 0
		const h = panelHeights({ containerH: 80, ratio: 0.5, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 0, bottomH: 48 });
	});
});

describe('clampRatio', () => {
	it('maps a mid-container pointer to ~0.5', () => {
		const r = clampRatio({ pointerY: 198, containerH: 428, ...BASE });
		expect(r).toBeCloseTo(0.5, 5);
	});

	it('clamps a near-top pointer to the min-panel ratio', () => {
		const r = clampRatio({ pointerY: 5, containerH: 428, ...BASE });
		expect(r).toBeCloseTo(60 / 396, 5);
	});

	it('clamps a past-bottom pointer to the max-panel ratio', () => {
		const r = clampRatio({ pointerY: 9999, containerH: 428, ...BASE });
		expect(r).toBeCloseTo(336 / 396, 5);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend npm --prefix frontend test -- --run split.test.ts`
Expected: FAIL — `split.ts` does not exist / `panelHeights is not a function`.

- [ ] **Step 3: Write the implementation**

Create `frontend/src/lib/components/Sidebar/split.ts`:

```ts
// frontend/src/lib/components/Sidebar/split.ts
//
// Pure geometry for the tree / excluded-pool vertical split. No Svelte, no DOM,
// so the divider sizing/clamping can be unit-tested without a browser (mirrors
// windowing.ts).
//
// `ratio` is the fraction of the EXPANDABLE area (container minus the pool
// header bar and the divider strip) given to the TOP (in-view tree) panel.

export interface SplitHeights {
	/** In-view tree viewport height, px. */
	topH: number;
	/** Excluded-pool body height (below its header), px; 0 when collapsed. */
	bottomH: number;
}

/**
 * Resolve the two panel heights. Collapsed: the pool shows only its fixed header
 * bar and the tree takes the rest. Expanded: the area left after the header and
 * divider is split by `ratio`, clamped so neither panel drops below `minPanelH`.
 * If the container is too short to hold two mins, the top panel yields first so
 * the pool keeps as much of `minPanelH` as fits.
 */
export function panelHeights(args: {
	containerH: number;
	ratio: number;
	collapsed: boolean;
	headerH: number;
	dividerH: number;
	minPanelH: number;
}): SplitHeights {
	const { containerH, ratio, collapsed, headerH, dividerH, minPanelH } = args;
	if (collapsed) {
		return { topH: Math.max(0, containerH - headerH), bottomH: 0 };
	}
	const expandable = containerH - headerH - dividerH;
	if (expandable <= minPanelH) {
		const bottomH = Math.max(0, Math.min(minPanelH, expandable));
		return { topH: Math.max(0, expandable - bottomH), bottomH };
	}
	const rawTop = Math.round(expandable * ratio);
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, rawTop));
	return { topH, bottomH: expandable - topH };
}

/**
 * Translate a divider drag (pointer Y measured from the container top) into a
 * new top-panel ratio, clamped to keep both panels >= minPanelH.
 */
export function clampRatio(args: {
	pointerY: number;
	containerH: number;
	headerH: number;
	dividerH: number;
	minPanelH: number;
}): number {
	const { pointerY, containerH, headerH, dividerH, minPanelH } = args;
	const expandable = containerH - headerH - dividerH;
	if (expandable <= 0) return 0.5;
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, pointerY));
	return Math.max(0, Math.min(1, topH / expandable));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend npm --prefix frontend test -- --run split.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/components/Sidebar/split.ts frontend/src/lib/components/Sidebar/split.test.ts
git commit -m "feat(tree): pure sizing math for tree/excluded split panel"
```

---

## Task 2: `view-tree.ts` — excluded roots as a separate region

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/view-tree.ts`
- Test: `frontend/src/lib/components/Sidebar/view-tree-window.test.ts`

- [ ] **Step 1: Update the tests (they will fail)**

In `frontend/src/lib/components/Sidebar/view-tree-window.test.ts`, change the import line:

```ts
import {
	registerExcludedRoots,
	buildUnifiedTree,
	computeVisibility,
	flattenVisibleRows,
	folderKey,
	resolveElementDrop
} from './view-tree';
```

(Removed `appendExcludedSection`, `EXCLUDED_SECTION_KEY`, `isExcludedSectionKey`; added `registerExcludedRoots`.)

Replace the **entire** `describe('appendExcludedSection', ...)` block (the three `it(...)` cases) with:

```ts
describe('registerExcludedRoots', () => {
	it('exposes the excluded ids as a separate root region, registering unloaded ids as element nodes', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['placed'] }] };
		const byId = new Map([['placed', el('placed')]]); // excluded ids NOT loaded yet
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		registerExcludedRoots(tree, ['x1', 'x2']);

		expect(tree.excludedRoots).toEqual(['x1', 'x2']);
		expect(tree.roots).not.toContain('x1'); // pool is NOT a tree root
		expect(tree.kind.get('x1')).toBe('element');
		expect(tree.children.get('x1')).toEqual([]);
	});

	it('drops an id already placed in a folder (defensive complement)', () => {
		const view: View = { name: 'v', folders: [{ name: 'F', folders: [], elements: ['placed'] }] };
		const byId = new Map([['placed', el('placed')]]);
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		registerExcludedRoots(tree, ['placed', 'x1']);
		expect(tree.excludedRoots).toEqual(['x1']);
	});

	it('excluded roots are visible (skeleton) under the type filter and flatten on their own roots', () => {
		const view: View = { name: 'v', folders: [] };
		const byId = new Map<string, Element>(); // nothing loaded
		const tree = buildUnifiedTree(view, [], byId, new Map(), new Set(), displayName);
		registerExcludedRoots(tree, ['x1']);
		const vis = computeVisibility(tree, byId, new Set(['Block']));
		expect(vis.get('x1')).toBe('full'); // unloaded body -> tentatively visible
		const rows = flattenVisibleRows(tree, vis, new Set(), tree.excludedRoots);
		expect(rows.map((r) => r.key)).toEqual(['x1']);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pixi run -e frontend npm --prefix frontend test -- --run view-tree-window.test.ts`
Expected: FAIL — `registerExcludedRoots` is not exported / `tree.excludedRoots` undefined.

- [ ] **Step 3: Implement the `view-tree.ts` changes**

3a. Add `excludedRoots` to the `UnifiedTree` interface (after the `roots` field, around line 43):

```ts
export interface UnifiedTree {
	/** Ordered list of root-level keys (top-level folder keys and unplaced root element ids). */
	roots: string[];
	/** Excluded-pool roots ("Not in view"): rendered in a separate panel, NOT in `roots`. */
	excludedRoots: string[];
	/** For each node key, the ordered list of child keys to render under it. */
	children: Map<string, string[]>;
```

3b. Initialise it in `buildUnifiedTree` where `out` is created (around line 124):

```ts
	const out: UnifiedTree = {
		roots: [],
		excludedRoots: [],
		children: new Map(),
		kind: new Map(),
		folderName: new Map(),
		placedElementIds: new Set()
	};
```

3c. Replace the whole `appendExcludedSection` function (and its doc comment) with:

```ts
/**
 * Register the "Not in view" excluded-pool roots on a built tree. `excludedRootIds`
 * are the loaded complement roots (backend order). Ids already placed in a folder
 * are dropped (defensive — the complement endpoint already excludes them). Unloaded
 * ids are registered as empty element nodes so the windowed renderer can show
 * skeleton rows until `ensureElements` fills the body. The pool is exposed as
 * `tree.excludedRoots` (a SEPARATE region) and is deliberately NOT added to
 * `tree.roots`, so it renders in its own panel rather than inside the tree.
 * Mutates `tree` in place (consistent with how buildUnifiedTree seeds).
 */
export function registerExcludedRoots(tree: UnifiedTree, excludedRootIds: string[]): void {
	const kids = excludedRootIds.filter((id) => !tree.placedElementIds.has(id));
	for (const id of kids) {
		if (!tree.kind.has(id)) tree.kind.set(id, 'element');
		if (!tree.children.has(id)) tree.children.set(id, []);
	}
	tree.excludedRoots = kids;
}
```

3d. In `computeVisibility`, make both passes cover the excluded roots. Replace the two `for (const r of tree.roots)` loops (the `visit` seeding loop near line 234 and the `decide` loop near line 249) so they iterate a combined list. Add this line just before the `visit` seeding loop:

```ts
	const allRoots = [...tree.roots, ...tree.excludedRoots];
```

Then change `for (const r of tree.roots) visit(r);` to `for (const r of allRoots) visit(r);` and `for (const r of tree.roots) decide(r);` to `for (const r of allRoots) decide(r);`.

3e. Give `flattenVisibleRows` an explicit `roots` parameter (default keeps existing 3-arg callers working). Replace its signature and the final loop:

```ts
export function flattenVisibleRows(
	tree: UnifiedTree,
	visibility: Map<string, Visibility>,
	collapsed: ReadonlySet<string>,
	roots: string[] = tree.roots
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
	for (const r of roots) walk(r, null, 0);
	return out;
}
```

3f. Point `movableElementIds` at the new region. Replace the excluded-pool line (around line 327, `for (const id of tree.children.get(EXCLUDED_SECTION_KEY) ?? []) out.add(id);`) with:

```ts
	// excluded-pool roots are draggable: dragging one into a folder includes it.
	for (const id of tree.excludedRoots) out.add(id);
```

Leave `EXCLUDED_SECTION_KEY` / `isExcludedSectionKey` exported — `ContainmentTree` still uses `EXCLUDED_SECTION_KEY` as the drop-target sentinel for the pool panel.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pixi run -e frontend npm --prefix frontend test -- --run view-tree-window.test.ts view-tree-build.test.ts view-tree-dnd.test.ts`
Expected: PASS. If `view-tree-build.test.ts` or `view-tree-dnd.test.ts` reference `appendExcludedSection`, update those references to `registerExcludedRoots` the same way and re-run.

- [ ] **Step 5: Type-check**

Run: `pixi run -e frontend npm --prefix frontend run check`
Expected: 0 errors. (`ContainmentTree.svelte` still calls `appendExcludedSection` at this point — it is updated in Task 4. If you are running tasks strictly in order, `check` will report errors in `ContainmentTree.svelte` only; that is expected and resolved by Task 4. The vitest run above must be clean.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/components/Sidebar/view-tree.ts frontend/src/lib/components/Sidebar/view-tree-window.test.ts
git commit -m "feat(tree): expose excluded pool as a separate root region"
```

---

## Task 3: `VerticalSplit.svelte` shell

**Files:**
- Create: `frontend/src/lib/components/Sidebar/VerticalSplit.svelte`

- [ ] **Step 1: Create the component**

Create `frontend/src/lib/components/Sidebar/VerticalSplit.svelte`:

```svelte
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { panelHeights, clampRatio } from './split';

	// Controlled split: the parent owns `collapsed`/`ratio` (and their persistence).
	// `ratio` is the fraction of the expandable area given to the TOP panel.
	type Props = {
		collapsed: boolean;
		ratio: number;
		headerH?: number;
		dividerH?: number;
		minPanelH?: number;
		/** In-view tree viewport. */
		top: Snippet;
		/** Pool header bar (collapse toggle + count). Rendered in BOTH states. */
		header: Snippet;
		/** Pool body viewport. Rendered only when expanded. */
		body: Snippet;
	};
	let {
		collapsed = $bindable(),
		ratio = $bindable(),
		headerH = 28,
		dividerH = 6,
		minPanelH = 80,
		top,
		header,
		body
	}: Props = $props();

	let containerEl: HTMLElement | null = $state(null);
	let containerH = $state(0);

	$effect(() => {
		if (!containerEl) return;
		containerH = containerEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (containerEl) containerH = containerEl.clientHeight;
		});
		ro.observe(containerEl);
		return () => ro.disconnect();
	});

	const heights = $derived(
		panelHeights({ containerH, ratio, collapsed, headerH, dividerH, minPanelH })
	);

	let dragging = false;

	function onDividerPointerDown(e: PointerEvent): void {
		if (e.button !== 0) return;
		e.preventDefault();
		dragging = true;
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
	}
	function onPointerMove(e: PointerEvent): void {
		if (!dragging || containerEl === null) return;
		const rect = containerEl.getBoundingClientRect();
		ratio = clampRatio({
			pointerY: e.clientY - rect.top,
			containerH: rect.height,
			headerH,
			dividerH,
			minPanelH
		});
	}
	function onPointerUp(): void {
		dragging = false;
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
	}
	$effect(() => onPointerUp); // remove window listeners on unmount
</script>

<div bind:this={containerEl} class="flex min-h-0 flex-1 flex-col">
	<div class="min-h-0 overflow-hidden" style="height: {heights.topH}px">
		{@render top()}
	</div>
	{#if !collapsed}
		<div
			class="shrink-0 cursor-row-resize bg-zinc-800 transition-colors hover:bg-indigo-500/50"
			style="height: {dividerH}px"
			role="separator"
			aria-orientation="horizontal"
			aria-label="Resize tree and excluded panels"
			onpointerdown={onDividerPointerDown}
		></div>
	{/if}
	<div class="shrink-0" style="height: {headerH}px">
		{@render header()}
	</div>
	{#if !collapsed}
		<div class="min-h-0 overflow-hidden" style="height: {heights.bottomH}px">
			{@render body()}
		</div>
	{/if}
</div>
```

- [ ] **Step 2: Type-check the component in isolation**

Run: `pixi run -e frontend npm --prefix frontend run check`
Expected: no NEW errors originating in `VerticalSplit.svelte`. (Errors in `ContainmentTree.svelte` from Task 2 may still be present until Task 4.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/components/Sidebar/VerticalSplit.svelte
git commit -m "feat(tree): controlled VerticalSplit shell for the tree/pool panels"
```

---

## Task 4: Wire `ContainmentTree.svelte` into two panels

This task has no unit test (the repo has no Svelte component unit tests; component behaviour is covered by type-check + the Playwright E2E in Task 5 + the pure tests already written). Make the edits, then verify with `check` and the full vitest suite, then proceed to Task 5 for behavioural coverage.

**Files:**
- Modify: `frontend/src/lib/components/Sidebar/ContainmentTree.svelte`

- [ ] **Step 1: Update imports**

4.1a. Add the SvelteKit `browser` flag at the top of the `<script>` (after the `import { untrack } from 'svelte';` line):

```ts
	import { browser } from '$app/environment';
```

4.1b. Add `VerticalSplit` to the component imports (next to the `TreeRow` import):

```ts
	import TreeRow from './TreeRow.svelte';
	import VerticalSplit from './VerticalSplit.svelte';
```

4.1c. In the `./view-tree` import block, replace `appendExcludedSection` with `registerExcludedRoots` (keep `EXCLUDED_SECTION_KEY`, drop nothing else):

```ts
	import {
		buildUnifiedTree,
		canDropElement,
		canDropFolder,
		computeVisibility,
		EXCLUDED_SECTION_KEY,
		flattenVisibleRows,
		folderPathFromKey,
		isExcludedSectionKey,
		isFolderKey,
		movableElementIds,
		registerExcludedRoots,
		resolveElementDrop,
		VIEW_ROOT_DROP_KEY,
		type DndContext,
		type FlatRow
	} from './view-tree';
```

- [ ] **Step 2: Add pool panel state + persistence**

Insert, just after the `collapsedFolders` declaration (the `const collapsedFolders = new SvelteSet<string>();` block):

```ts
	// ----- excluded-pool panel (collapsed-by-default, resizable) -----
	const LS_POOL_COLLAPSED = 'ui.treePoolCollapsed';
	const LS_POOL_RATIO = 'ui.treePoolRatio';

	function readPoolCollapsed(): boolean {
		if (!browser) return true; // default collapsed
		return localStorage.getItem(LS_POOL_COLLAPSED) !== 'false';
	}
	function readPoolRatio(): number {
		if (!browser) return 0.5;
		const n = Number(localStorage.getItem(LS_POOL_RATIO));
		return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.5;
	}

	let poolCollapsed = $state(readPoolCollapsed());
	let poolRatio = $state(readPoolRatio());

	$effect(() => {
		if (browser) localStorage.setItem(LS_POOL_COLLAPSED, String(poolCollapsed));
	});
	$effect(() => {
		if (browser) localStorage.setItem(LS_POOL_RATIO, String(poolRatio));
	});
```

- [ ] **Step 3: Build the tree without a section root**

Replace the `tree` derived (the `const tree = $derived.by(() => { ... });` block that currently calls `appendExcludedSection`) with:

```ts
	const tree = $derived.by(() => {
		const t = buildUnifiedTree(
			view,
			rootElementIds,
			elementsById,
			containmentChildren,
			containedIds,
			displayName
		);
		if (view !== null) {
			registerExcludedRoots(
				t,
				excludedRoots.map((i) => i.element.id)
			);
		}
		return t;
	});
```

- [ ] **Step 4: Split the flattened rows into tree vs pool**

Replace the single `visibleRows` derived (`const visibleRows = $derived<FlatRow[]>(flattenVisibleRows(tree, visibility, collapsedSet));`) with two:

```ts
	const treeVisibleRows = $derived<FlatRow[]>(
		flattenVisibleRows(tree, visibility, collapsedSet, tree.roots)
	);
	const poolVisibleRows = $derived<FlatRow[]>(
		flattenVisibleRows(tree, visibility, collapsedSet, tree.excludedRoots)
	);
```

Then update every remaining reference to `visibleRows` in the script to `treeVisibleRows` (keyboard nav, focus, multi-select range, selection sync). The references are in: `focusedIndex`, `moveTo`, `scrollRowIntoView` callers, `onKeyDown`, the selection `$effect` (`treeVisibleRows.some(...)`), and `onPick`'s shift-range (`const keys = treeVisibleRows.map((r) => r.key);`). Do not introduce keyboard nav for the pool.

- [ ] **Step 5: Two windowing states**

5a. Replace the single windowing state block:

```ts
	let scrollEl: HTMLElement | null = $state(null);
	let scrollTop = $state(0);
	let viewportH = $state(0);
```

with:

```ts
	let treeScrollEl: HTMLElement | null = $state(null);
	let treeScrollTop = $state(0);
	let treeViewportH = $state(0);
	let poolScrollEl: HTMLElement | null = $state(null);
	let poolScrollTop = $state(0);
	let poolViewportH = $state(0);
```

5b. Replace the `windowSlice` / `windowedRows` deriveds with per-panel versions:

```ts
	const treeWindow = $derived(
		computeWindow({
			scrollTop: treeScrollTop,
			viewportH: treeViewportH,
			rowH: ROW_H,
			total: treeVisibleRows.length,
			overscan: OVERSCAN
		})
	);
	const treeWindowedRows = $derived(treeVisibleRows.slice(treeWindow.start, treeWindow.end));

	const poolWindow = $derived(
		computeWindow({
			scrollTop: poolScrollTop,
			viewportH: poolViewportH,
			rowH: ROW_H,
			total: poolVisibleRows.length,
			overscan: OVERSCAN
		})
	);
	const poolWindowedRows = $derived(poolVisibleRows.slice(poolWindow.start, poolWindow.end));

	// Combined on-screen rows across both panels — drives the body fetch and child
	// prefetch so either viewport's visible rows are hydrated.
	const windowedRows = $derived([...treeWindowedRows, ...poolWindowedRows]);
```

(`windowedRows` is kept so the existing "windowed body fetch" and "child prefetch" effects continue to reference it unchanged.)

- [ ] **Step 6: Auto-load — roots use the tree window, pool uses the pool window + gate**

Replace the whole auto-load `$effect` (the one computing `loadAhead` and calling `shouldLoadMore` / `shouldLoadMoreExcluded`) with:

```ts
	$effect(() => {
		const loadAheadTree = Math.ceil(treeViewportH / ROW_H) + OVERSCAN * 2;
		if (view !== null) {
			// Pool paging: gate on the panel being expanded AND sized — a collapsed or
			// zero-height pool can never have a row on screen, so it must not page.
			const loadAheadPool = Math.ceil(poolViewportH / ROW_H) + OVERSCAN * 2;
			const remaining = excludedTotal - excludedRoots.length;
			if (
				shouldLoadMoreExcluded({
					sectionCollapsed: poolCollapsed || poolViewportH === 0,
					windowEnd: poolWindow.end,
					loadedCount: poolVisibleRows.length,
					total: poolVisibleRows.length + remaining,
					threshold: loadAheadPool
				})
			) {
				excludedLimit = excludedRoots.length + PAGE_LIMIT;
			}
		}
		// In-view roots paging (both view and no-view modes use the tree window).
		const remainingRoots = rootsTotal - roots.length;
		if (
			shouldLoadMore({
				windowEnd: treeWindow.end,
				loadedCount: treeVisibleRows.length,
				total: treeVisibleRows.length + remainingRoots,
				threshold: loadAheadTree
			})
		) {
			rootsLimit = roots.length + PAGE_LIMIT;
		}
	});
```

(Note: roots paging now runs in both modes. That is correct — in view mode the roots feed the in-view tree just as before.)

- [ ] **Step 7: Per-viewport scroll + resize handlers**

7a. Replace `onScroll`:

```ts
	function onTreeScroll(): void {
		if (treeScrollEl) treeScrollTop = treeScrollEl.scrollTop;
	}
	function onPoolScroll(): void {
		if (poolScrollEl) poolScrollTop = poolScrollEl.scrollTop;
	}
```

7b. Replace the single viewport `ResizeObserver` `$effect` with two:

```ts
	$effect(() => {
		if (!treeScrollEl) return;
		treeViewportH = treeScrollEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (treeScrollEl) treeViewportH = treeScrollEl.clientHeight;
		});
		ro.observe(treeScrollEl);
		return () => ro.disconnect();
	});
	$effect(() => {
		if (!poolScrollEl) return;
		poolViewportH = poolScrollEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (poolScrollEl) poolViewportH = poolScrollEl.clientHeight;
		});
		ro.observe(poolScrollEl);
		return () => ro.disconnect();
	});
```

7c. Update `scrollRowIntoView` (keyboard nav, tree panel) to use the tree viewport — replace its body's `scrollEl` references with `treeScrollEl` and the trailing `scrollTop = scrollEl.scrollTop;` with `treeScrollTop = treeScrollEl.scrollTop;`. Its guard becomes `if (treeScrollEl === null) return;`.

- [ ] **Step 8: Edge auto-scroll picks the hovered viewport**

8a. Add a helper just above `tickAutoScroll`:

```ts
	function viewportUnder(y: number): HTMLElement | null {
		for (const vp of [treeScrollEl, poolScrollEl]) {
			if (!vp) continue;
			const r = vp.getBoundingClientRect();
			if (y >= r.top && y <= r.bottom) return vp;
		}
		return null;
	}
```

8b. Replace the body of `tickAutoScroll` with a version that scrolls whichever viewport the pointer is over:

```ts
	function tickAutoScroll(): void {
		autoScrollRaf = 0;
		if (!dragging) return;
		const vp = viewportUnder(lastPointerY) ?? treeScrollEl;
		if (vp === null) return;
		const rect = vp.getBoundingClientRect();
		const dy = edgeScrollDelta({
			pointerY: lastPointerY,
			top: rect.top,
			bottom: rect.bottom,
			edge: EDGE_PX,
			maxSpeed: MAX_SCROLL_SPEED
		});
		if (dy !== 0) {
			vp.scrollTop += dy;
			if (vp === treeScrollEl) treeScrollTop = vp.scrollTop;
			else poolScrollTop = vp.scrollTop;
			const t = dropTargetAt(lastPointerX, lastPointerY);
			dragHoverKey = t?.key ?? null;
			dragHoverValid = t !== null && dropAllowed(t.path);
		}
		autoScrollRaf = requestAnimationFrame(tickAutoScroll);
	}
```

- [ ] **Step 9: Restructure the markup with snippets + `VerticalSplit`**

Replace the entire markup block from the scrollable container (the `<div bind:this={scrollEl} ...>` ... matching `</div>` that closes it) — i.e. the tree body that currently lives between the toolbar `</div>` and the floating drag-preview `{#if dragging ...}` — with the snippet-based structure below. Keep the outer wrapper `<div class="flex min-h-0 flex-1 flex-col">`, the toolbar header block, and the floating drag preview exactly as they are; only the body between them changes.

Move the click-capture swallow up to the outer wrapper so it covers BOTH panels: on the outer `<div class="flex min-h-0 flex-1 flex-col">`, add `onclickcapture={onTreeClickCapture}` (and remove `onclickcapture` from the old tree scroll div, which no longer exists).

New body (place between the toolbar `</div>` and `{#if dragging && dragLabel !== ''}`):

```svelte
	{#snippet treeViewport()}
		<div
			bind:this={treeScrollEl}
			class="h-full min-h-0 overflow-auto px-3 py-2 outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
			tabindex="0"
			role="tree"
			aria-label="Containment tree"
			onkeydown={onKeyDown}
			onscroll={onTreeScroll}
		>
			{#if mm === null}
				<p class="text-xs text-zinc-600">Load a metamodel and model to begin.</p>
			{:else if (summary?.element_count ?? 0) === 0 && tree.roots.length === 0}
				<p class="text-xs text-zinc-600">Model is empty.</p>
			{:else}
				{#if view !== null && draggingPayload !== null}
					<div
						role="button"
						tabindex="-1"
						aria-label="Move to top level"
						class="mb-1 rounded border border-dashed border-zinc-700 px-2 py-1 text-[10px] text-zinc-500"
						class:border-emerald-500={isViewRootHover && dragHoverValid}
						class:text-emerald-400={isViewRootHover && dragHoverValid}
						class:border-red-500={isViewRootHover && !dragHoverValid}
						data-drop-key={VIEW_ROOT_DROP_KEY}
						data-drop-kind="section"
						data-drop-path="null"
					>
						Drop here to move to top level
					</div>
				{/if}
				<div style="height: {treeWindow.padTop}px"></div>
				<ul class="flex flex-col text-xs" role="group">
					{#each treeWindowedRows as row (row.key)}
						<TreeRow
							{row}
							{tree}
							{elementsById}
							{visibility}
							collapsed={collapsedSet}
							{childCounts}
							{excludedTotal}
							{folderOptions}
							{warningsByElementId}
							{issueIndex}
							selectedId={selection?.kind === 'element' ? selection.id : null}
							multiSelectedIds={multiSelected}
							{focusedId}
							parentFolderPath={dropParentFolderPath(row)}
							siblingIndex={dropSiblingIndex(row)}
							folderLen={dropFolderLen(row)}
							movable={movableIds.has(row.key)}
							dnd={dndContext}
							onToggle={toggleCollapsed}
							{onPick}
							{onMoveToFolder}
						/>
					{/each}
				</ul>
				<div style="height: {treeWindow.padBottom}px"></div>
			{/if}
		</div>
	{/snippet}

	{#snippet poolHeader()}
		<button
			type="button"
			class="flex h-full w-full select-none items-center gap-1 border-t border-zinc-800 px-3 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
			class:bg-zinc-800={dragHoverKey === EXCLUDED_SECTION_KEY}
			class:ring-1={dragHoverKey === EXCLUDED_SECTION_KEY}
			class:ring-emerald-500={dragHoverKey === EXCLUDED_SECTION_KEY && dragHoverValid}
			class:ring-red-500={dragHoverKey === EXCLUDED_SECTION_KEY && !dragHoverValid}
			data-drop-key={EXCLUDED_SECTION_KEY}
			data-drop-kind="section"
			data-drop-path="null"
			onclick={() => (poolCollapsed = !poolCollapsed)}
		>
			{#if poolCollapsed}
				<ChevronRight class="h-3 w-3" />
			{:else}
				<ChevronDown class="h-3 w-3" />
			{/if}
			<span class="flex-1 text-left">Not in view</span>
			<span class="font-mono text-[10px] normal-case text-zinc-500">{excludedTotal}</span>
		</button>
	{/snippet}

	{#snippet poolBody()}
		<div
			bind:this={poolScrollEl}
			class="h-full min-h-0 overflow-auto px-3 py-1"
			role="tree"
			aria-label="Excluded elements"
			onscroll={onPoolScroll}
			data-drop-key={EXCLUDED_SECTION_KEY}
			data-drop-kind="section"
			data-drop-path="null"
		>
			<div style="height: {poolWindow.padTop}px"></div>
			<ul class="flex flex-col text-xs" role="group">
				{#each poolWindowedRows as row (row.key)}
					<TreeRow
						{row}
						{tree}
						{elementsById}
						{visibility}
						collapsed={collapsedSet}
						{childCounts}
						{excludedTotal}
						{folderOptions}
						{warningsByElementId}
						{issueIndex}
						selectedId={selection?.kind === 'element' ? selection.id : null}
						multiSelectedIds={multiSelected}
						{focusedId}
						parentFolderPath={dropParentFolderPath(row)}
						siblingIndex={dropSiblingIndex(row)}
						folderLen={dropFolderLen(row)}
						movable={movableIds.has(row.key)}
						dnd={dndContext}
						onToggle={toggleCollapsed}
						{onPick}
						{onMoveToFolder}
					/>
				{/each}
			</ul>
			<div style="height: {poolWindow.padBottom}px"></div>
		</div>
	{/snippet}

	{#if view !== null}
		<VerticalSplit
			bind:collapsed={poolCollapsed}
			bind:ratio={poolRatio}
			top={treeViewport}
			header={poolHeader}
			body={poolBody}
		/>
	{:else}
		{@render treeViewport()}
	{/if}
```

9b. Add the chevron icon imports if not already present. The toolbar imports `{ Filter, FolderPlus, Plus }` from `@lucide/svelte`; extend it:

```ts
	import { ChevronDown, ChevronRight, Filter, FolderPlus, Plus } from '@lucide/svelte';
```

- [ ] **Step 10: Type-check + full vitest**

Run: `pixi run -e frontend npm --prefix frontend run check`
Expected: 0 errors, 0 warnings.

Run: `pixi run -e frontend npm --prefix frontend test -- --run`
Expected: all suites PASS (322 existing + new split/view-tree tests).

If `check` flags an unused `isExcludedSectionKey` import in `ContainmentTree.svelte`, confirm it is still referenced by the windowed-body-fetch and child-prefetch effects (`.filter((k) => !isFolderKey(k) && !isExcludedSectionKey(k))`). It is — leave it.

- [ ] **Step 11: Lint the changed files**

Run: `pixi run -e frontend bash -c "cd frontend && npx eslint src/lib/components/Sidebar/ContainmentTree.svelte src/lib/components/Sidebar/VerticalSplit.svelte"`
Expected: exit 0.

- [ ] **Step 12: Format**

Run: `pixi run -e frontend bash -c "cd frontend && npx prettier --write src/lib/components/Sidebar/ContainmentTree.svelte src/lib/components/Sidebar/VerticalSplit.svelte src/lib/components/Sidebar/split.ts src/lib/components/Sidebar/split.test.ts"`

- [ ] **Step 13: Commit**

```bash
git add frontend/src/lib/components/Sidebar/ContainmentTree.svelte
git commit -m "feat(tree): render the excluded pool in a collapsible resizable panel"
```

---

## Task 5: Update + extend E2E coverage

**Files:**
- Modify: `frontend/e2e/view.spec.ts`

The pool is now a panel header (a `button` named "Not in view") OUTSIDE the in-view `role="tree"`, collapsed by default, with its own `role="tree"` named "Excluded elements" when expanded. The existing tests assume "Not in view" and pooled elements live inside the tree and are visible immediately — both change.

- [ ] **Step 1: Add panel helpers**

After the existing `function row(page, text)` helper (around line 148), add:

```ts
/** The "Not in view" pool panel header (collapse toggle + drop target). */
function poolHeader(page: Page): Locator {
	return page.getByRole('button', { name: /not in view/i });
}

/** The expanded pool body (its own tree region) and a row within it. */
function pool(page: Page): Locator {
	return page.getByRole('tree', { name: /excluded elements/i });
}
function poolRow(page: Page, text: string): Locator {
	return pool(page).getByRole('treeitem').filter({ hasText: text }).first();
}

/** Expand the pool panel if it is collapsed (default is collapsed). */
async function expandPool(page: Page): Promise<void> {
	if (await pool(page).count()) return; // already expanded
	await poolHeader(page).click();
	await expect(pool(page)).toBeVisible();
}
```

- [ ] **Step 2: Update the "load a view" test**

Replace the body of `test('load a view: folders render with their placed elements (curated scope)', ...)` assertions after the view loads (the block starting `const tree = page.getByRole('tree', ...)` to the end of the test) with:

```ts
	const treeEl = page.getByRole('tree', { name: /containment tree/i });
	await expect(treeEl.getByText('Grouped')).toBeVisible();
	// Alpha is placed in the 'Grouped' folder -> shows under it.
	await expect(treeEl.getByText('Alpha')).toBeVisible();

	// Beta is unplaced -> it lives in the "Not in view" pool, which is a separate
	// panel, collapsed by default. The header shows; Beta is not rendered yet.
	await expect(poolHeader(page)).toBeVisible();
	await expect(pool(page)).toHaveCount(0);

	// Expanding the pool reveals Beta.
	await expandPool(page);
	await expect(poolRow(page, 'Beta')).toBeVisible();
```

- [ ] **Step 3: Update the include test**

In `test('view curation: include a pooled element into a folder ...')`, Beta now lives in the collapsed pool, so expand it before dragging. Replace the precondition + include block:

```ts
	const t = tree(page);
	// Precondition: Beta sits in the (collapsed) "Not in view" pool; expand to reach it.
	await expect(poolHeader(page)).toBeVisible();
	await expandPool(page);
	await expect(poolRow(page, 'Beta')).toBeVisible();

	// Include: drag the Beta row (in the pool) onto the Grouped folder header.
	const put = viewPut(page);
	await dragRowOnto(page, poolRow(page, 'Beta'), row(page, 'Grouped'));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).toContain(BLOCK_TWO_ID);

	// Beta is now placed under Grouped (folders are not lazily paged).
	await expect(t.getByText('Beta')).toBeVisible();
```

The persistence/reload portion stays as-is, except the final two assertions: after reload the pool is collapsed again, so assert Beta under the tree:

```ts
	const t2 = tree(page);
	await expect(t2.getByText('Grouped')).toBeVisible();
	await expect(t2.getByText('Beta')).toBeVisible();
```

(Beta is placed in Grouped now, so it renders in the in-view tree regardless of pool state — these assertions hold.)

- [ ] **Step 4: Update the exclude test**

In `test('view curation: exclude a placed element back to the pool', ...)`, drop Alpha onto the pool header (it is a valid section drop target even while collapsed), then expand to confirm:

```ts
	// Exclude: drag Alpha from Grouped onto the "Not in view" panel header.
	const put = viewPut(page);
	await dragRowOnto(page, row(page, 'Alpha'), poolHeader(page));
	const body = (await put).postDataJSON() as { folders: Folder[] };
	expect(findFolder(body.folders, 'Grouped')!.elements).not.toContain(BLOCK_ONE_ID);

	// Alpha now lives in the pool: expand and confirm it is listed there.
	await expandPool(page);
	await expect(poolRow(page, 'Alpha')).toBeVisible();
```

- [ ] **Step 5: Update the reorder test**

In `test('view curation: reorder elements within a folder (upward)', ...)`, Beta starts in the collapsed pool — expand and drag from the pool to build the two-element folder. Replace the include block:

```ts
	// Build a two-element folder: include Beta so Grouped = [Alpha, Beta].
	await expandPool(page);
	const include = viewPut(page);
	await dragRowOnto(page, poolRow(page, 'Beta'), row(page, 'Grouped'));
	const afterInclude = (await include).postDataJSON() as { folders: Folder[] };
	expect(findFolder(afterInclude.folders, 'Grouped')!.elements).toEqual([
		BLOCK_ONE_ID,
		BLOCK_TWO_ID
	]);
	await expect(tree(page).getByText('Beta')).toBeVisible();
```

The reorder portion (dragging Beta onto Alpha's top half, both now in the tree) is unchanged.

- [ ] **Step 6: Add a new test for collapse / no-fetch / persistence**

Append this test at the end of the file:

```ts
test('excluded pool: collapsed by default (no fetch), expands, and state persists', async ({
	page
}) => {
	test.setTimeout(120_000);

	// Record excluded-pool fetches across the whole session.
	const excludedHits: string[] = [];
	page.on('request', (r) => {
		if (new URL(r.url()).pathname.endsWith('/model/containment/roots/excluded')) {
			excludedHits.push(r.url());
		}
	});

	await bootstrap(page);
	await loadView(page);

	// Collapsed by default: header visible, body absent, and NO excluded fetch fired.
	await expect(poolHeader(page)).toBeVisible();
	await expect(pool(page)).toHaveCount(0);
	expect(excludedHits).toHaveLength(0);

	// Expanding fetches the first page and shows the pooled element.
	await poolHeader(page).click();
	await expect(poolRow(page, 'Beta')).toBeVisible();
	expect(excludedHits.length).toBeGreaterThan(0);

	// Expanded state persists across a reload.
	await page.reload();
	await expect(pool(page)).toBeVisible();
	await expect(poolRow(page, 'Beta')).toBeVisible();

	// Collapse, reload: stays collapsed.
	await poolHeader(page).click();
	await expect(pool(page)).toHaveCount(0);
	await page.reload();
	await expect(poolHeader(page)).toBeVisible();
	await expect(pool(page)).toHaveCount(0);
});
```

- [ ] **Step 7: Run the E2E spec**

Run: `pixi run -e frontend npm --prefix frontend run test:e2e -- view.spec.ts`
Expected: all tests in `view.spec.ts` PASS. If `dnd.spec.ts` references "Not in view" the same way, update those references with the same `poolHeader`/`expandPool`/`poolRow` helpers and run `... test:e2e -- dnd.spec.ts` too.

- [ ] **Step 8: Format + commit**

```bash
pixi run -e frontend bash -c "cd frontend && npx prettier --write e2e/view.spec.ts"
git add frontend/e2e/view.spec.ts
git commit -m "test(e2e): cover the collapsible excluded-pool panel"
```

---

## Task 6: Manual verification + final sweep

- [ ] **Step 1: Run the app and verify visually**

Run: `pixi run start-frontend` (loads the smart-city example with a view by default). In the browser:
- Pool starts collapsed as a "Not in view (N)" bar at the bottom; the Network tab shows no `/model/containment/roots/excluded` request.
- Click the bar → it expands ~50/50 and fetches the first pool page.
- Drag the divider → tree/pool resize; neither can be dragged to zero (min height holds).
- Drag a pooled element onto a folder → it joins the view; drag a placed element onto the pool bar → it returns to the pool.
- Edge auto-scroll works inside each viewport during a drag.
- Collapse/expand + resize, reload → state restored from localStorage.

- [ ] **Step 2: Full lint/format/typecheck sweep**

Run: `pixi run -e frontend npm --prefix frontend run check`
Run: `pixi run -e frontend npm --prefix frontend test -- --run`
Expected: clean.

- [ ] **Step 3: Confirm no stray references remain**

Run: `pixi run -e frontend bash -c "cd frontend && grep -rn 'appendExcludedSection' src e2e"`
Expected: no matches.

---

## Self-review notes (author)

- **Spec coverage:** separate panel (Task 4 §9), collapsible + no fetch while collapsed (Task 4 §2,6; Task 5 §6), bottom-of-tree placement (Task 4 §9 markup order), default-collapsed (Task 4 §2), expand-to-half + draggable divider (Task 1, Task 3), persistence (Task 4 §2), filter applies to both (computeVisibility covers `excludedRoots`, Task 2 §3d), cross-panel DnD both directions (Task 4 §8 edge-scroll, §9 section drop targets; Task 5 §3,4). All mapped.
- **Type consistency:** `panelHeights`/`clampRatio` signatures identical across Task 1 and Task 3; `registerExcludedRoots(tree, ids)` and `tree.excludedRoots` consistent across Tasks 2 and 4; `flattenVisibleRows(tree, vis, collapsed, roots?)` 4-arg form used consistently.
- **Naming:** `treeScrollEl/treeScrollTop/treeViewportH` and `poolScrollEl/poolScrollTop/poolViewportH` used uniformly after the Task 4 §5 rename; old `scrollEl/scrollTop/viewportH`/`windowSlice`/`visibleRows` fully replaced.
