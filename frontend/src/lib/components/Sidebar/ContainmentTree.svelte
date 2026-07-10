<script lang="ts">
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import type { TreeItem } from '$lib/api/types';
	import {
		listContainmentChildren,
		listContainmentRootsPaged,
		listExcludedRootsPaged
	} from '$lib/api/model-read';
	import { NotFoundError } from '$lib/api/errors';
	import {
		artifactHeaderById,
		createFolder,
		createTempId,
		dropTreeItems,
		emit,
		ensureTreeItems,
		ensureTypeFilterInitialized,
		getTreeElements,
		getIssues,
		getMetamodel,
		getMissingElementIds,
		getModelGeneration,
		getModelSummary,
		getStructureRev,
		getSelection,
		getTypeFilter,
		getView,
		getViewWarnings,
		indexIssues,
		isProjectOpening,
		isViewResolved,
		moveArtifact,
		moveFolder,
		openNavigationTab,
		placeArtifact,
		placeElement,
		placeElementsAt,
		removeElement,
		seedTreeItems,
		select,
		setTypeFilter,
		toggleType
	} from '$lib/state';
	import { ChevronDown, ChevronRight, Filter, FolderPlus, Plus } from '@lucide/svelte';
	import { elementDisplayName as displayName } from '$lib/util/element-name';
	import StereotypePicker from './StereotypePicker.svelte';
	import TreeRow from './TreeRow.svelte';
	import VerticalSplit from './VerticalSplit.svelte';
	import {
		computeWindow,
		edgeScrollDelta,
		shouldLoadMore,
		shouldLoadMoreExcluded
	} from './windowing';
	import { treeBodyState } from './tree-empty-state';
	import {
		beginDrag,
		endDrag,
		getDragPayload,
		isDragActive,
		isMovableBypassed,
		type DragPayload
	} from '$lib/state/tree-drag.svelte';
	import {
		buildUnifiedTree,
		canDropArtifact,
		canDropElement,
		canDropFolder,
		computeVisibility,
		EXCLUDED_SECTION_KEY,
		flattenVisibleRows,
		folderPathFromKey,
		isArtifactKey,
		isExcludedSectionKey,
		isFolderKey,
		movableElementIds,
		registerExcludedRoots,
		resolveElementDrop,
		VIEW_ROOT_DROP_KEY,
		type DndContext,
		type FlatRow,
		type NodeKind
	} from './view-tree';
	import { findFolderByPath } from '../../state/view-ops';

	const mm = $derived(getMetamodel());
	const typeFilter = $derived(getTypeFilter());
	const view = $derived(getView());
	const viewWarnings = $derived(getViewWarnings());
	const summary = $derived(getModelSummary());

	const concreteTypeNames = $derived.by<string[]>(() => {
		if (mm === null) return [];
		return mm.elements.filter((e) => !e.abstract).map((e) => e.name);
	});

	$effect(() => {
		if (mm !== null) ensureTypeFilterInitialized(concreteTypeNames);
	});

	let filterOpen = $state(false);
	let createOpen = $state(false);

	function onSelectAll(): void {
		setTypeFilter(new SvelteSet(concreteTypeNames));
	}

	function onDeselectAll(): void {
		setTypeFilter(new SvelteSet());
	}

	function onCreateElement(typeName: string): void {
		const tempId = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tempId,
			type_name: typeName,
			properties: {}
		});
		select({ kind: 'element', id: tempId });
	}

	// ----- lazy containment levels (paged read endpoints) -----
	//
	// The tree holds only the FETCHED levels: the roots page plus the child
	// levels the prefetch effect has pulled in. Roots and child levels are
	// fetched by SEPARATE effects so expanding a row never pays for a roots
	// refetch:
	//   * roots — refetched on every acknowledged STRUCTURAL delta (create/
	//     delete/relationship change; property-only acks while typing don't
	//     refetch) and on model swap; grown past PAGE_LIMIT by the scroll
	//     auto-load (offset paging — the backend caps each request at PAGE_LIMIT
	//     and 422s above it).
	//   * child levels — prefetched PREFETCH_DEPTH levels below the on-screen rows
	//     (see the prefetch effect) so expansion is instant; invalidated wholesale
	//     on a structural delta / model swap and refilled. Levels whose parent
	//     disappeared (404) are dropped and auto-collapsed.
	const PAGE_LIMIT = 500;

	let roots: TreeItem[] = $state([]);
	// First roots page for the current model has landed (vs. "roots is empty
	// because the fetch is still in flight") — feeds treeBodyState so the body
	// shows a skeleton, not a blank list, while that first page loads.
	let rootsLoaded = $state(false);
	// rootsTotal/excludedTotal feed scroll auto-load (shouldLoadMore): nearing the
	// last loaded row grows the page limit (no "Show more" button).
	let rootsTotal = $state(0);
	let rootsLimit = $state(PAGE_LIMIT);
	let excludedRoots: TreeItem[] = $state([]);
	let excludedTotal = $state(0);
	let excludedLimit = $state(PAGE_LIMIT);
	const childLevels = new SvelteMap<string, TreeItem[]>();
	const childTotals = new SvelteMap<string, number>();
	/** Element ids the user expanded (folders are tracked by `expandedFolders`). */
	const expandedElements = new SvelteSet<string>();
	/** Folder keys the user expanded. Folders default to COLLAPSED (mirroring
	 * elements): on a large model + view, defaulting them open flattened every
	 * placed element across every folder at once, so loading one folder visibly
	 * churned the whole tree. Collapsed-by-default keeps a fresh view to just its
	 * top-level folders until the user opens one. */
	const expandedFolders = new SvelteSet<string>();

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

	let rootsSeq = 0;
	let excludedSeq = 0;
	// Child levels are fetched independently of the roots page (see the prefetch
	// effect): `childLoadSeq` bumps whenever a structural delta or model swap
	// invalidates them, so an in-flight child fetch that lands afterwards is
	// dropped instead of seeding stale rows.
	let childLoadSeq = 0;
	// Ids with a child-level fetch in flight, so overlapping prefetch passes do
	// not double-request the same level. Plain Set: bookkeeping, never read
	// reactively.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const _childFetching = new Set<string>();

	async function refreshRoots(seq: number, limit: number): Promise<void> {
		try {
			const page = await listContainmentRootsPaged(limit);
			if (seq !== rootsSeq) return;
			seedTreeItems(page.items);
			roots = page.items;
			rootsTotal = page.total;
			rootsLoaded = true;
		} catch (err) {
			if (seq === rootsSeq) console.error('Containment tree load failed', err);
		}
	}

	// Fetch one element's containment children into `childLevels`. Called by the
	// prefetch effect for levels not yet loaded; `seq` guards against a model
	// swap / structural change landing mid-flight.
	async function fetchChildLevel(seq: number, id: string): Promise<void> {
		_childFetching.add(id);
		try {
			const cp = await listContainmentChildren(id, { limit: PAGE_LIMIT });
			if (seq !== childLoadSeq) return;
			seedTreeItems(cp.items);
			childLevels.set(id, cp.items);
			childTotals.set(id, cp.total);
		} catch (err) {
			if (seq !== childLoadSeq) return;
			if (err instanceof NotFoundError) {
				// parent gone (deleted) — drop and collapse its level
				childLevels.delete(id);
				childTotals.delete(id);
				expandedElements.delete(id);
			} else {
				// transient failure — keep the stale level rather than collapsing
				console.error(`Containment children load failed for ${id}`, err);
			}
		} finally {
			_childFetching.delete(id);
		}
	}

	async function refreshExcluded(seq: number, limit: number): Promise<void> {
		try {
			const page = await listExcludedRootsPaged(limit);
			if (seq !== excludedSeq) return;
			seedTreeItems(page.items);
			excludedRoots = page.items;
			excludedTotal = page.total;
		} catch (err) {
			if (seq === excludedSeq) console.error('Excluded pool load failed', err);
		}
	}

	// `hasModel` is a derived boolean (not the summary object) so the periodic
	// summary refreshes — which replace the object but not the fact that a
	// model is loaded — don't retrigger the fetch effect.
	const hasModel = $derived(getModelSummary() !== null);

	// View gate: never paint (or fetch) the first roots page until the view
	// question is answered — painting raw roots and collapsing to the view a
	// beat later is the "flash of all elements" bug (spec §5).
	const viewResolved = $derived(isViewResolved());

	// Model swap: a different model starts from the default page size again.
	// Declared before the fetch effect so the reset is visible to its run.
	$effect(() => {
		void getModelGeneration();
		rootsLimit = PAGE_LIMIT;
	});

	// Structural change or model swap resets the excluded pool to its first page.
	$effect(() => {
		void getStructureRev();
		void getModelGeneration();
		excludedLimit = PAGE_LIMIT;
	});

	// Roots page: refetched on structural deltas / model swap and grown by the
	// roots scroll auto-load. Deliberately does NOT depend on `poolCollapsed` — the
	// excluded pool's collapse state must never cost an in-view roots refetch.
	$effect(() => {
		void getStructureRev(); // tracked: refetch on every STRUCTURAL acked delta
		void getModelGeneration(); // tracked: refetch on model swap/reset
		void view; // tracked: preserve refetch-on-view-change (prior behavior)
		const loaded = hasModel && viewResolved;
		const limit = rootsLimit; // tracked: roots auto-load page size
		const seq = ++rootsSeq;
		if (!loaded) {
			untrack(() => {
				roots = [];
				rootsLoaded = false;
				rootsTotal = 0;
				childLevels.clear();
				childTotals.clear();
				if (expandedElements.size > 0) expandedElements.clear();
			});
			return;
		}
		void refreshRoots(seq, limit);
	});

	// Excluded pool: fetched ONLY in view mode AND while the panel is expanded — a
	// collapsed pool renders nothing, so "no fetch while collapsed" means not even
	// loading the first page. Reading `poolCollapsed` makes expanding the panel
	// re-run this effect and trigger the load; collapsing clears the loaded rows
	// (the body is unmounted anyway) and re-expanding refetches.
	$effect(() => {
		void getStructureRev();
		void getModelGeneration();
		const loaded = hasModel;
		const v = view;
		const exLimit = excludedLimit; // tracked: pool scroll auto-load growth
		const collapsed = poolCollapsed; // tracked: expand triggers the fetch
		const seq = ++excludedSeq;
		if (!loaded || v === null || collapsed) {
			untrack(() => {
				excludedRoots = [];
				excludedTotal = 0;
			});
			return;
		}
		void refreshExcluded(seq, exLimit);
	});

	// Child levels are no longer refetched by the roots effect (expanding a row
	// must not pay for a full roots refetch). A structural delta or model swap
	// instead invalidates every loaded child level here; the prefetch effect then
	// refills them from the new structure. Bumping `childLoadSeq` drops any
	// in-flight child fetch that lands after the invalidation.
	$effect(() => {
		void getStructureRev();
		void getModelGeneration();
		childLoadSeq++;
		untrack(() => {
			if (childLevels.size > 0) childLevels.clear();
			if (childTotals.size > 0) childTotals.clear();
			_childFetching.clear();
			// also drop lite rows for expanded folders so their display_name/child_count
			// refetch fresh after a structural change (edited elements are full entries in
			// _elements and unaffected; only view-only rows are dropped).
			const v = getView();
			if (v !== null) {
				for (const key of expandedFolders) {
					if (!isFolderKey(key)) continue;
					const folder = findFolderByPath(v, folderPathFromKey(key));
					if (folder) dropTreeItems(folder.elements);
				}
			}
		});
	});

	// ----- unified tree over the fetched subset -----

	const elementsById = $derived(getTreeElements());

	const containmentChildren = $derived.by(() => {
		const m = new SvelteMap<string, string[]>();
		for (const [pid, items] of childLevels) {
			m.set(
				pid,
				items.map((i) => i.id).filter((id) => elementsById.has(id))
			);
		}
		return m;
	});

	const containedIds = $derived.by(() => {
		const s = new SvelteSet<string>();
		for (const ids of containmentChildren.values()) {
			for (const id of ids) s.add(id);
		}
		return s;
	});

	const rootElementIds = $derived(roots.map((i) => i.id).filter((id) => elementsById.has(id)));

	/** child_count per element id (drives expanders for unfetched levels). */
	const childCounts = $derived.by(() => {
		const m = new SvelteMap<string, number>();
		for (const i of roots) m.set(i.id, i.child_count);
		for (const i of excludedRoots) m.set(i.id, i.child_count);
		for (const items of childLevels.values()) {
			for (const i of items) m.set(i.id, i.child_count);
		}
		return m;
	});

	const missingElementIds = $derived(getMissingElementIds());

	const tree = $derived.by(() => {
		const t = buildUnifiedTree(
			view,
			rootElementIds,
			elementsById,
			containmentChildren,
			containedIds,
			displayName,
			missingElementIds
		);
		if (view !== null) {
			registerExcludedRoots(
				t,
				excludedRoots.map((i) => i.id)
			);
		}
		return t;
	});

	// What the tree body paints: skeleton during a project open/reload (the
	// warm-open path has no global overlay), the two empty-state messages, or
	// the rows area. Pure decision table in tree-empty-state.ts.
	const bodyState = $derived(
		treeBodyState({
			opening: isProjectOpening(),
			hasMetamodel: mm !== null,
			summaryCount: summary === null ? null : summary.element_count,
			rootsLoaded,
			rootCount: tree.roots.length
		})
	);

	// Visibility is computed over the LOADED subset only: an element whose own
	// type is filtered out is hidden even if an UNFETCHED descendant would
	// match (the old whole-model tree kept such ancestors visible).
	const visibility = $derived.by(() => computeVisibility(tree, elementsById, typeFilter));

	const warningsByElementId = $derived.by(() => {
		const set = new SvelteSet<string>();
		for (const w of viewWarnings) {
			for (const tid of w.target_ids) set.add(tid);
		}
		return set;
	});

	const selection = $derived(getSelection());

	// ----- expansion state (lazy levels) -----

	function isExpandable(key: string): boolean {
		if (isFolderKey(key) || isExcludedSectionKey(key))
			return (tree.children.get(key) ?? []).length > 0;
		return (tree.children.get(key) ?? []).length > 0 || (childCounts.get(key) ?? 0) > 0;
	}

	function isCollapsedKey(key: string): boolean {
		if (isFolderKey(key) || isExcludedSectionKey(key)) return !expandedFolders.has(key);
		return !expandedElements.has(key);
	}

	/** Set passed to TreeRow (its `collapsed.has(key)` contract is unchanged). */
	const collapsedSet = $derived.by(() => {
		const s = new SvelteSet<string>();
		for (const key of tree.kind.keys()) {
			if (isCollapsedKey(key)) s.add(key);
		}
		return s;
	});

	function toggleCollapsed(key: string): void {
		setCollapsed(key, !isCollapsedKey(key));
	}

	function setCollapsed(key: string, value: boolean): void {
		if (isFolderKey(key) || isExcludedSectionKey(key)) {
			if (value) expandedFolders.delete(key);
			else expandedFolders.add(key);
			return;
		}
		if (value) expandedElements.delete(key);
		else expandedElements.add(key);
	}

	const treeVisibleRows = $derived<FlatRow[]>(
		flattenVisibleRows(tree, visibility, collapsedSet, tree.roots)
	);
	const poolVisibleRows = $derived<FlatRow[]>(
		flattenVisibleRows(tree, visibility, collapsedSet, tree.excludedRoots)
	);

	// ----- virtualized windowing -----

	const ROW_H = 24;
	const OVERSCAN = 8;

	let treeScrollEl: HTMLElement | null = $state(null);
	let treeScrollTop = $state(0);
	let treeViewportH = $state(0);
	let poolScrollEl: HTMLElement | null = $state(null);
	let poolScrollTop = $state(0);
	let poolViewportH = $state(0);

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

	// Auto-load the next page when a panel's mounted window nears its last loaded
	// row. Each panel pages independently against its OWN window/visible-rows
	// (tree roots use the tree window; the excluded pool uses the pool window).
	//
	// `loadAhead` is roughly one screenful of rows, so the fetch fires about a
	// viewport BEFORE the user hits the bottom — the next page is usually already
	// in by the time they reach it, keeping the lazy load invisible.
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

	function onTreeScroll(): void {
		if (treeScrollEl) treeScrollTop = treeScrollEl.scrollTop;
	}
	function onPoolScroll(): void {
		if (poolScrollEl) poolScrollTop = poolScrollEl.scrollTop;
	}

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

	// Prebuilt issue index, hoisted so TreeRow rows share one build per render.
	const issueIndex = $derived(indexIssues(getIssues()));

	// Windowed body fetch: pull only the on-screen element bodies into cache.
	$effect(() => {
		const ids = windowedRows
			.map((r) => r.key)
			.filter((k) => !isFolderKey(k) && !isExcludedSectionKey(k));
		if (ids.length > 0) void ensureTreeItems(ids);
	});

	// Whole-folder prefetch: when a view folder is expanded, pull the lite rows for
	// ALL of its placed elements in one request (a folder is <=1k, so this is a
	// single small batch) instead of letting the scroll window fetch them piecemeal
	// — that piecemeal fetch is what flashes skeletons. Full elements still arrive
	// only on selection; this only warms the display cache.
	$effect(() => {
		const v = getView();
		if (v === null) return;
		const ids: string[] = [];
		for (const key of expandedFolders) {
			if (!isFolderKey(key)) continue;
			const folder = findFolderByPath(v, folderPathFromKey(key));
			if (folder) ids.push(...folder.elements);
		}
		if (ids.length > 0) void ensureTreeItems(ids);
	});

	// ----- child-level prefetch -----
	//
	// Children are prefetched PREFETCH_DEPTH levels below every on-screen element
	// so expanding a row reveals its children instantly instead of waiting on a
	// fetch. Seeding the walk from the WINDOWED (on-screen) rows keeps the work
	// proportional to the viewport, not the model size; expanded elements are
	// folded in too so an open level is still fetched when scrolled out of the
	// window. The walk descends through already-loaded levels (`childLevels`), so
	// each newly-arrived level extends the frontier and the next level is fetched
	// on the following pass — capped at PREFETCH_DEPTH.
	const PREFETCH_DEPTH = 1;
	const childPrefetchIds = $derived.by<SvelteSet<string>>(() => {
		const targets = new SvelteSet<string>();
		let frontier: string[] = [
			...windowedRows.map((r) => r.key).filter((k) => !isFolderKey(k) && !isExcludedSectionKey(k)),
			...expandedElements
		];
		for (let depth = 0; depth < PREFETCH_DEPTH; depth++) {
			const next: string[] = [];
			for (const id of frontier) {
				if (targets.has(id)) continue;
				targets.add(id);
				for (const c of childLevels.get(id) ?? []) next.push(c.id);
			}
			frontier = next;
		}
		return targets;
	});

	// Fetch the missing child levels for the prefetch frontier. Re-runs as new
	// on-screen rows mount and as each fetched level extends `childPrefetchIds`,
	// cascading down to PREFETCH_DEPTH; only not-yet-loaded, non-leaf, not-in-flight
	// ids are requested, so it converges.
	$effect(() => {
		if (!hasModel) return;
		const seq = childLoadSeq;
		for (const id of childPrefetchIds) {
			if (childLevels.has(id)) continue; // already loaded
			if ((childCounts.get(id) ?? 0) === 0) continue; // leaf — nothing to fetch
			if (_childFetching.has(id)) continue; // in flight
			void fetchChildLevel(seq, id);
		}
	});

	let focusedId: string | null = $state(null);

	const focusedIndex = $derived.by(() => {
		if (focusedId === null) return -1;
		return treeVisibleRows.findIndex((r) => r.key === focusedId);
	});

	function moveTo(idx: number): void {
		if (idx < 0 || idx >= treeVisibleRows.length) return;
		focusedId = treeVisibleRows[idx].key;
		scrollRowIntoView(idx);
	}

	// Under windowing the focused row may not be mounted; keep it in view so the
	// focus ring stays visible and the row exists in the DOM for assistive tech.
	function scrollRowIntoView(idx: number): void {
		if (treeScrollEl === null) return;
		const top = idx * ROW_H;
		const bottom = top + ROW_H;
		if (top < treeScrollEl.scrollTop) treeScrollEl.scrollTop = top;
		else if (bottom > treeScrollEl.scrollTop + treeScrollEl.clientHeight) {
			treeScrollEl.scrollTop = bottom - treeScrollEl.clientHeight;
		}
		treeScrollTop = treeScrollEl.scrollTop;
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (treeVisibleRows.length === 0) return;
		const cur = focusedIndex;
		const k = e.key;
		if (k === 'ArrowDown') {
			e.preventDefault();
			if (cur < 0) moveTo(0);
			else moveTo(Math.min(treeVisibleRows.length - 1, cur + 1));
		} else if (k === 'ArrowUp') {
			e.preventDefault();
			if (cur < 0) moveTo(treeVisibleRows.length - 1);
			else moveTo(Math.max(0, cur - 1));
		} else if (k === 'ArrowRight') {
			if (cur < 0) return;
			e.preventDefault();
			const row = treeVisibleRows[cur];
			if (!isExpandable(row.key)) return;
			if (isCollapsedKey(row.key)) {
				setCollapsed(row.key, false);
			} else {
				const kids = tree.children.get(row.key) ?? [];
				if (kids.some((c) => visibility.get(c) !== 'hidden')) moveTo(cur + 1);
			}
		} else if (k === 'ArrowLeft') {
			if (cur < 0) return;
			e.preventDefault();
			const row = treeVisibleRows[cur];
			if (isExpandable(row.key) && !isCollapsedKey(row.key)) {
				setCollapsed(row.key, true);
			} else if (row.parent !== null) {
				const pIdx = treeVisibleRows.findIndex((r) => r.key === row.parent);
				if (pIdx >= 0) moveTo(pIdx);
			}
		} else if (k === 'Enter' || k === ' ') {
			if (cur < 0) return;
			e.preventDefault();
			const row = treeVisibleRows[cur];
			if (isArtifactKey(row.key)) {
				// Keyboard equivalent of the artifact row's dblclick-to-open; not a
				// model element, so it must not flow into `select()` below.
				const ref = tree.artifactRef.get(row.key);
				const header = ref ? artifactHeaderById(ref.id) : undefined;
				if (header) openNavigationTab({ artifactId: header.id, title: header.name });
			} else if (!isFolderKey(row.key)) {
				replaceMultiSelected([row.key]);
				anchorId = row.key;
				select({ kind: 'element', id: row.key });
			}
		}
	}

	$effect(() => {
		if (selection?.kind === 'element' && treeVisibleRows.some((r) => r.key === selection.id)) {
			focusedId = selection.id;
		}
	});

	// ----- multi-selection (sidebar-local; the Inspector still tracks the single
	// `selection`, which we keep pointed at the last-touched element) -----
	// SvelteSet is reactive on its own; mutate in place (no `$state` wrapper).
	const multiSelected = new SvelteSet<string>();
	let anchorId: string | null = $state(null);

	function replaceMultiSelected(keys: Iterable<string>): void {
		multiSelected.clear();
		for (const k of keys) multiSelected.add(k);
	}

	function onPick(key: string, e: MouseEvent): void {
		if (isFolderKey(key)) {
			// folders aren't selectable in the inspector; clicking one clears the
			// element multi-selection for predictability.
			multiSelected.clear();
			anchorId = null;
			return;
		}
		if (e.shiftKey && anchorId !== null) {
			const keys = treeVisibleRows.map((r) => r.key);
			const a = keys.indexOf(anchorId);
			const b = keys.indexOf(key);
			if (a >= 0 && b >= 0) {
				const [lo, hi] = a < b ? [a, b] : [b, a];
				replaceMultiSelected(keys.slice(lo, hi + 1).filter((k) => !isFolderKey(k)));
			} else {
				replaceMultiSelected([key]);
			}
		} else if (e.metaKey || e.ctrlKey) {
			if (multiSelected.has(key)) multiSelected.delete(key);
			else multiSelected.add(key);
			anchorId = key;
		} else {
			replaceMultiSelected([key]);
			anchorId = key;
		}
		select({ kind: 'element', id: key });
	}

	// Drop ids that no longer exist (model swap / element deletion).
	$effect(() => {
		for (const id of [...multiSelected]) {
			if (!knownIds.has(id)) multiSelected.delete(id);
		}
	});

	// ----- drag-and-drop (Pointer Events) -----
	//
	// Native HTML5 DnD was deliberately dropped here: it relies on the OS drag
	// loop, which fails to start in some Chromium setups (drag never begins in
	// Chrome/Edge while Firefox works). Pointer events are driven by the browser
	// input pipeline, so they behave the same everywhere and support touch/pen.
	// Drop targets tag themselves with data-drop-key / data-drop-path; we hit-test
	// them with elementFromPoint rather than per-row dragover/drop handlers.

	const movableIds = $derived(movableElementIds(tree));
	const knownIds = $derived(new SvelteSet(elementsById.keys()));

	// Per-row drop metadata passed to TreeRow so the controller can resolve a
	// positional element drop (append/reorder/exclude) from the hovered row.
	function dropParentFolderPath(row: FlatRow): string[] | null {
		if (row.parent !== null && isFolderKey(row.parent)) return folderPathFromKey(row.parent);
		return null; // top-level, under the excluded section, or under an element
	}
	function dropSiblingIndex(row: FlatRow): number {
		if (view === null) return 0;
		const p = dropParentFolderPath(row);
		if (p === null) return 0;
		const folder = findFolderByPath(view, p);
		return folder ? folder.elements.indexOf(row.key) : 0;
	}
	function dropFolderLen(row: FlatRow): number {
		if (view === null || !isFolderKey(row.key)) return 0;
		const folder = findFolderByPath(view, folderPathFromKey(row.key));
		return folder ? folder.elements.length : 0;
	}

	const draggingPayload = $derived(getDragPayload());
	let dragHoverKey: string | null = $state(null);
	let dragHoverValid = $state(false);

	// Press → threshold → drag bookkeeping.
	const DRAG_THRESHOLD_PX = 4;
	let pendingPayload: DragPayload | null = null;
	let activePointerId: number | null = null;
	let startX = 0;
	let startY = 0;
	// Set alongside `pendingPayload` when the drag is an artifact picked up from
	// a tree row (its containing folder path); left null for an artifact drag
	// that began outside the tree (the ArtifactsSection sidebar). At drop time
	// this distinguishes "reparent" (strip from the source folder first) from
	// "place" (the sidebar has no source folder to strip from).
	let dragSourceFolderPath: string[] | null = null;
	let dragging = $state(false);
	let externalDrag = $state(false);
	let dragX = $state(0);
	let dragY = $state(0);
	// Edge auto-scroll: while dragging near a viewport edge, scroll the list so a
	// drag can reach off-window targets. Driven by requestAnimationFrame.
	const EDGE_PX = 36;
	const MAX_SCROLL_SPEED = 18;
	let autoScrollRaf = 0;
	let lastPointerX = 0;
	let lastPointerY = 0;
	// Set on pointerup after a real drag so the click it synthesizes doesn't also
	// select/toggle the row; cleared on the next pointerdown so it never goes stale.
	let suppressClick = false;

	const dragLabel = $derived.by((): string => {
		if (draggingPayload === null) return '';
		if (draggingPayload.kind === 'folder') {
			const p = draggingPayload.path;
			return p.length > 0 ? p[p.length - 1] : 'folder';
		}
		if (draggingPayload.kind === 'artifact') {
			return artifactHeaderById(draggingPayload.id)?.name ?? draggingPayload.artifactKind;
		}
		const ids = draggingPayload.ids;
		if (ids.length === 1) {
			const el = elementsById.get(ids[0]);
			return el ? displayName(el) : ids[0];
		}
		return `${ids.length} elements`;
	});

	function dropAllowed(
		destPath: string[] | null,
		destKind: 'folder' | 'element' | 'section'
	): boolean {
		if (draggingPayload === null) return false;
		if (draggingPayload.kind === 'element') {
			if (isMovableBypassed()) {
				// search-originated: a KNOWN, uncontained element may be placed.
				// Reject already-contained elements — placing one would persist a
				// placement the render layer then skips (it would silently vanish).
				return draggingPayload.ids.every((id) => knownIds.has(id) && !containedIds.has(id));
			}
			return canDropElement({ elementIds: draggingPayload.ids, movableIds, knownIds }).ok;
		}
		if (draggingPayload.kind === 'artifact') {
			return canDropArtifact(destKind);
		}
		return canDropFolder({ sourcePath: draggingPayload.path, destParentPath: destPath ?? [] }).ok;
	}

	/** Resolve the drop target under a viewport point to its key + destination path. */
	function dropTargetAt(
		x: number,
		y: number
	): {
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

	function buildPayload(key: string, kind: NodeKind, folderPath: string[]): DragPayload | null {
		if (kind === 'folder') return { kind: 'folder', path: folderPath };
		if (kind === 'artifact') {
			const ref = tree.artifactRef.get(key);
			if (!ref) return null;
			return { kind: 'artifact', id: ref.id, artifactKind: ref.kind };
		}
		const base = multiSelected.has(key) && multiSelected.size > 1 ? [...multiSelected] : [key];
		const ids = base.filter((id) => movableIds.has(id));
		if (ids.length === 0) return null;
		return { kind: 'element', ids };
	}

	function onPointerDown(e: PointerEvent, key: string, kind: NodeKind, folderPath: string[]): void {
		if (e.button !== 0 || !e.isPrimary) return;
		suppressClick = false;
		const payload = buildPayload(key, kind, folderPath);
		if (payload === null) return; // nothing movable under this press
		pendingPayload = payload;
		// Only an artifact row picked up FROM the tree carries a source folder path
		// (see `dragSourceFolderPath`'s doc comment) — the ArtifactsSection sidebar
		// begins its drag via `beginDrag` directly, bypassing this handler.
		dragSourceFolderPath = payload.kind === 'artifact' ? folderPath : null;
		activePointerId = e.pointerId;
		startX = e.clientX;
		startY = e.clientY;
		window.addEventListener('pointermove', onWindowPointerMove);
		window.addEventListener('pointerup', onWindowPointerUp);
		window.addEventListener('pointercancel', onWindowPointerUp);
		window.addEventListener('keydown', onWindowKeyDown);
	}

	function onWindowPointerMove(e: PointerEvent): void {
		if (!externalDrag && (pendingPayload === null || e.pointerId !== activePointerId)) return;
		dragX = e.clientX;
		dragY = e.clientY;
		if (!dragging) {
			if (pendingPayload === null) return; // in-tree threshold needs a pending payload
			if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
			dragging = true;
			beginDrag(pendingPayload);
			document.body.style.userSelect = 'none'; // no text selection mid-drag
		}
		const target = dropTargetAt(e.clientX, e.clientY);
		dragHoverKey = target?.key ?? null;
		dragHoverValid = target !== null && dropAllowed(target.path, target.kind);
		lastPointerX = e.clientX;
		lastPointerY = e.clientY;
		if (dragging && autoScrollRaf === 0) autoScrollRaf = requestAnimationFrame(tickAutoScroll);
	}

	function viewportUnder(y: number): HTMLElement | null {
		for (const vp of [treeScrollEl, poolScrollEl]) {
			if (!vp) continue;
			const r = vp.getBoundingClientRect();
			if (y >= r.top && y <= r.bottom) return vp;
		}
		return null;
	}

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
			dragHoverValid = t !== null && dropAllowed(t.path, t.kind);
		}
		autoScrollRaf = requestAnimationFrame(tickAutoScroll);
	}

	async function onWindowPointerUp(e: PointerEvent): Promise<void> {
		if (!externalDrag && e.pointerId !== activePointerId) return;
		if (!dragging) {
			endGesture();
			return; // a plain click — let it select/toggle normally
		}
		const target = dropTargetAt(e.clientX, e.clientY);
		const payload = draggingPayload;
		const valid = target !== null && dropAllowed(target.path, target.kind);
		const sourceFolderPath = dragSourceFolderPath;
		suppressClick = true;
		endGesture();
		if (!valid || payload === null || target === null) return;
		try {
			if (payload.kind === 'element') {
				const res = resolveElementDrop({
					targetKind: target.kind,
					folderPath: target.path,
					folderLen: target.folderLen,
					siblingIndex: target.siblingIndex,
					half: target.half
				});
				await placeElementsAt(res.path, payload.ids, res.index);
			} else if (payload.kind === 'folder') {
				await moveFolder(payload.path, target.path ?? []);
			} else {
				// 'artifact': dropAllowed() already restricted the target to a folder
				// row, so `target.path` is a real folder path here. A row picked up
				// from a tree folder (`sourceFolderPath` set) reparents; one picked up
				// from the ArtifactsSection sidebar (no source folder) places anew.
				const destPath = target.path ?? [];
				const ref = { id: payload.id, kind: payload.artifactKind };
				if (sourceFolderPath !== null) {
					await moveArtifact(sourceFolderPath, destPath, ref);
				} else {
					await placeArtifact(destPath, ref);
				}
			}
		} catch (err) {
			console.error('Drop failed', err);
		}
	}

	function onWindowKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape') endGesture();
	}

	// A drag started outside the tree (e.g. from Search) flips isDragActive without
	// going through our onPointerDown. Adopt it so the tree's pointer handlers drive
	// hover, edge auto-scroll and drop for it.
	$effect(() => {
		if (isDragActive() && pendingPayload === null && !dragging) {
			externalDrag = true;
			dragging = true;
			window.addEventListener('pointermove', onWindowPointerMove);
			window.addEventListener('pointerup', onWindowPointerUp);
			window.addEventListener('pointercancel', onWindowPointerUp);
			window.addEventListener('keydown', onWindowKeyDown);
		}
	});

	function endGesture(): void {
		if (autoScrollRaf !== 0) {
			cancelAnimationFrame(autoScrollRaf);
			autoScrollRaf = 0;
		}
		pendingPayload = null;
		activePointerId = null;
		dragSourceFolderPath = null;
		dragging = false;
		externalDrag = false;
		endDrag();
		dragHoverKey = null;
		dragHoverValid = false;
		document.body.style.userSelect = '';
		window.removeEventListener('pointermove', onWindowPointerMove);
		window.removeEventListener('pointerup', onWindowPointerUp);
		window.removeEventListener('pointercancel', onWindowPointerUp);
		window.removeEventListener('keydown', onWindowKeyDown);
	}

	// Tear down a mid-flight drag if the component unmounts.
	$effect(() => endGesture);

	// Capturing click handler on the tree: swallow the click a finished drag
	// synthesizes so it doesn't also select/toggle the row it landed on.
	function onTreeClickCapture(e: MouseEvent): void {
		if (!suppressClick) return;
		suppressClick = false;
		e.preventDefault();
		e.stopPropagation();
	}

	const dndContext = $derived<DndContext>({
		onPointerDown,
		hoverKey: dragHoverKey,
		hoverValid: dragHoverValid
	});

	const isViewRootHover = $derived(dragHoverKey === VIEW_ROOT_DROP_KEY);

	// ----- folder targets for "Move to folder…" picker -----

	type FolderOption = { path: string[]; label: string };
	const folderOptions = $derived.by<FolderOption[]>(() => {
		const opts: FolderOption[] = [];
		const walk = (key: string): void => {
			if (!isFolderKey(key)) return;
			const path = folderPathFromKey(key);
			opts.push({ path, label: path.join(' / ') });
			for (const c of tree.children.get(key) ?? []) walk(c);
		};
		for (const r of tree.roots) walk(r);
		return opts;
	});

	async function onNewRootFolder(): Promise<void> {
		const name = window.prompt('New top-level folder name');
		if (name === null || name.trim() === '') return;
		try {
			await createFolder([], name.trim());
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to create folder');
		}
	}

	async function onMoveToFolder(elementId: string, path: string[] | null): Promise<void> {
		try {
			if (path === null) await removeElement(elementId);
			else await placeElement(path, elementId);
		} catch (err) {
			console.error('Move element failed', err);
		}
	}
</script>

<div class="flex min-h-0 flex-1 flex-col" onclickcapture={onTreeClickCapture}>
	<div class="flex items-center justify-between gap-2 px-3 pt-2">
		<h2 class="microlabel">Tree</h2>
		{#if mm !== null}
			<div class="flex items-center gap-0.5">
				<StereotypePicker
					mode="filter"
					names={concreteTypeNames}
					checked={typeFilter}
					onToggle={toggleType}
					{onSelectAll}
					{onDeselectAll}
					open={filterOpen}
					onOpenChange={(v) => (filterOpen = v)}
					searchPlaceholder="Filter stereotypes…"
					emptyLabel="No stereotypes."
				>
					{#snippet trigger()}
						<span
							class="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label="Filter stereotypes"
							title="Filter stereotypes"
						>
							<Filter class="h-3 w-3" />
						</span>
					{/snippet}
				</StereotypePicker>
				{#if view !== null}
					<button
						type="button"
						class="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						aria-label="New top-level folder"
						title="New top-level folder"
						onclick={onNewRootFolder}
					>
						<FolderPlus class="h-3 w-3" />
					</button>
				{/if}
				<StereotypePicker
					mode="create"
					names={concreteTypeNames}
					onPick={onCreateElement}
					open={createOpen}
					onOpenChange={(v) => (createOpen = v)}
					searchPlaceholder="Search stereotypes…"
					emptyLabel="No stereotypes."
				>
					{#snippet trigger()}
						<span
							class="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							aria-label="New element"
							title="New element"
						>
							<Plus class="h-3 w-3" />
						</span>
					{/snippet}
				</StereotypePicker>
			</div>
		{/if}
	</div>
	{#snippet treeViewport()}
		<div
			bind:this={treeScrollEl}
			class="h-full min-h-0 overflow-auto px-3 py-2 outline-none focus:ring-2 focus:ring-inset focus:ring-ring"
			tabindex="0"
			role="tree"
			aria-label="Containment tree"
			onkeydown={onKeyDown}
			onscroll={onTreeScroll}
		>
			{#if bodyState === 'onboarding'}
				<div class="flex flex-col items-center gap-1 py-6 text-center">
					<p class="font-display text-base font-light text-muted-foreground">Nothing loaded</p>
					<p class="text-xs text-muted-foreground/70">Load a metamodel and model to begin.</p>
				</div>
			{:else if bodyState === 'skeleton'}
				<div class="flex flex-col gap-2 py-1" role="status" aria-label="Loading model tree">
					{#each [70, 45, 60, 35, 55, 40, 65, 50] as width (width)}
						<div class="h-3.5 animate-pulse rounded bg-muted" style="width: {width}%"></div>
					{/each}
				</div>
			{:else if bodyState === 'empty'}
				<div class="flex flex-col items-center gap-1 py-6 text-center">
					<p class="font-display text-base font-light text-muted-foreground">Model is empty</p>
					<p class="text-xs text-muted-foreground/70">Create an element to populate the tree.</p>
				</div>
			{:else}
				{#if view !== null && draggingPayload !== null}
					<div
						role="button"
						tabindex="-1"
						aria-label="Move to top level"
						class="mb-1 rounded border border-dashed border-input px-2 py-1 text-[10px] text-muted-foreground"
						class:border-success={isViewRootHover && dragHoverValid}
						class:text-success={isViewRootHover && dragHoverValid}
						class:border-destructive={isViewRootHover && !dragHoverValid}
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
			class="microlabel flex h-full w-full select-none items-center gap-1 border-t border-border px-3 transition-colors hover:bg-card hover:text-foreground/80"
			class:bg-muted={dragHoverKey === EXCLUDED_SECTION_KEY}
			class:ring-1={dragHoverKey === EXCLUDED_SECTION_KEY}
			class:ring-success={dragHoverKey === EXCLUDED_SECTION_KEY && dragHoverValid}
			class:ring-destructive={dragHoverKey === EXCLUDED_SECTION_KEY && !dragHoverValid}
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
			{#if !poolCollapsed}
				<span class="font-mono text-[10px] normal-case text-muted-foreground">{excludedTotal}</span>
			{/if}
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

	{#if dragging && dragLabel !== ''}
		<!-- Floating drag preview following the cursor (pointer-events DnD has no
		     native drag image). pointer-events:none so it never blocks hit-testing. -->
		<div
			class="pointer-events-none fixed z-50 truncate rounded border border-primary/60 bg-card px-2 py-0.5 text-xs text-foreground shadow-lg"
			style="left: {dragX + 12}px; top: {dragY + 8}px; max-width: 220px"
		>
			{dragLabel}
		</div>
	{/if}
</div>
