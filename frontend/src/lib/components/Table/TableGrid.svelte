<script lang="ts">
	// The read-only table body: a sticky header row (labels, sort carets,
	// drag-resize handles) plus a windowed body over the store's SPARSE row
	// cache. The body is sized for the table's full `total`, so the scrollbar
	// reflects the whole result set; rows the cache hasn't fetched yet render
	// as pulse placeholders, and the range effect below asks the store to fill
	// the window (plus a prefetch margin) whenever it moves — normal scrolling
	// should land on already-prefetched rows and never show a placeholder.
	import type { TableCell, TableColumn } from '$lib/api/types';
	import {
		ensureTableRange,
		getTableDraft,
		getTableError,
		getTableLoading,
		getTablePage,
		getTableSort,
		lockBadgeFor,
		setTableSort,
		updateTableDefinition
	} from '$lib/state';
	import { columnKindLabel, setColumnWidth } from '$lib/table/columns';
	import { computeWindowVariable } from '$lib/components/Sidebar/windowing';
	import ElementCell from './Cell/ElementCell.svelte';
	import ElementsCell from './Cell/ElementsCell.svelte';
	import ValueCell from './Cell/ValueCell.svelte';
	import ValuesCell from './Cell/ValuesCell.svelte';

	let { tabId }: { tabId: string } = $props();

	const ROW_H = 28;
	const OVERSCAN = 8;
	// Rows to request beyond the window in each direction: large enough that
	// wheel/keyboard scrolling stays ahead of the fetches, small enough that a
	// scrollbar jump doesn't fan out needless requests.
	const PREFETCH = 100;
	const DEFAULT_WIDTH = 180;
	const MIN_WIDTH = 80;
	/** Upper bound for double-click auto-fit, so one huge cell can't blow the
	 * column out to an unusable width. */
	const MAX_AUTO_WIDTH = 640;

	const page = $derived(getTablePage(tabId));
	const loading = $derived(getTableLoading(tabId));
	const sort = $derived(getTableSort(tabId));
	const error = $derived(getTableError(tabId));
	const rows = $derived(page?.rows ?? []);

	let scrollEl: HTMLElement | null = $state(null);
	let scrollTop = $state(0);
	let viewportH = $state(0);

	// One line per value: the row is as tall as its tallest cell. Sparse
	// (unloaded) rows count 1 line — heights can shift as rows stream in,
	// which is the standard estimated-height virtualization tradeoff.
	function cellLines(cell: TableCell): number {
		if (cell.kind === 'values') return Math.max(1, cell.values.length + (cell.truncated ? 1 : 0));
		if (cell.kind === 'elements') return Math.max(1, cell.items.length + (cell.truncated ? 1 : 0));
		return 1;
	}
	const offsets = $derived.by(() => {
		const out = new Array<number>(rows.length + 1);
		out[0] = 0;
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const lines = r ? Math.max(1, ...r.cells.map(cellLines)) : 1;
			out[i + 1] = out[i] + lines * ROW_H;
		}
		return out;
	});
	const win = $derived(
		computeWindowVariable({ scrollTop, viewportH, offsets, overscan: OVERSCAN })
	);
	const windowedRows = $derived(rows.slice(win.start, win.end));

	// Keep the sparse cache filled around the window. Runs on every window
	// move and whenever the cache changes (a reset drops loaded rows — this
	// re-requests the visible ones); `ensureTableRange` itself is cheap and
	// dedupes in-flight chunks, so eager re-runs cost one array scan.
	$effect(() => {
		if (!page) return;
		ensureTableRange(tabId, Math.max(0, win.start - PREFETCH), win.end + PREFETCH);
	});

	function onScroll(): void {
		if (scrollEl) scrollTop = scrollEl.scrollTop;
	}

	$effect(() => {
		if (!scrollEl) return;
		viewportH = scrollEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (scrollEl) viewportH = scrollEl.clientHeight;
		});
		ro.observe(scrollEl);
		return () => ro.disconnect();
	});

	// Column resize: `resizing` + `liveWidth` hold the IN-FLIGHT drag so header
	// and body cells stay aligned while dragging, without spamming the store
	// (and therefore the network) on every pointermove. The store's
	// `updateTableDefinition` reloads the page, so it is only called once, on
	// pointerup — plain `ResizeHandle.svelte` fires `onchange` continuously
	// during the drag, which doesn't fit that "commit on release" shape, so
	// this is a small purpose-built handler instead.
	let resizing = $state<{ index: number; startX: number; startW: number } | null>(null);
	let liveWidth = $state<number | null>(null);

	function widthFor(col: TableColumn | undefined, index: number): number {
		if (resizing?.index === index && liveWidth !== null) return liveWidth;
		return col?.width_px ?? DEFAULT_WIDTH;
	}

	function onResizeStart(e: PointerEvent, index: number, current: number): void {
		if (e.button !== 0) return;
		resizing = { index, startX: e.clientX, startW: current };
		liveWidth = current;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	}
	function onResizeMove(e: PointerEvent): void {
		if (!resizing) return;
		liveWidth = Math.max(MIN_WIDTH, resizing.startW + (e.clientX - resizing.startX));
	}
	function onResizeEnd(e: PointerEvent): void {
		if (!resizing || liveWidth === null) return;
		const { index } = resizing;
		const width = liveWidth;
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		resizing = null;
		liveWidth = null;
		const draft = getTableDraft(tabId);
		if (draft) updateTableDefinition(tabId, setColumnWidth(draft.definition, index, width));
	}

	// Double-click auto-fit: size the column to its widest RENDERED content —
	// the header label plus the cells the window currently shows (the sparse
	// row cache means off-screen rows can't be measured). Cell wrappers are
	// overflow-hidden, so the inner content's scrollWidth is the full,
	// unclipped content width even when it is currently truncated.
	function autoFitColumn(index: number): void {
		if (!scrollEl) return;
		let max = MIN_WIDTH;
		const headerCell = scrollEl.querySelectorAll('[data-testid="table-header"] > div')[index];
		const label = headerCell?.querySelector('span');
		// label + sort caret + flex gaps + horizontal padding
		if (label) max = Math.max(max, Math.ceil(label.scrollWidth) + 44);
		for (const row of scrollEl.querySelectorAll('[data-testid="table-row"]')) {
			const content = row.children[index]?.firstElementChild;
			// px-2 padding (16) + right border + a rounding safety px
			if (content) max = Math.max(max, Math.ceil(content.scrollWidth) + 18);
		}
		const draft = getTableDraft(tabId);
		if (!draft) return;
		const width = Math.min(max, MAX_AUTO_WIDTH);
		updateTableDefinition(tabId, setColumnWidth(draft.definition, index, width));
	}

	// The lock badge for the element a cell belongs to (element/value cells
	// carry one; values/elements cells are aggregates with no single owner).
	// 'mine' tints the cell orange, 'theirs' red — see the row markup.
	function cellLockBadge(cell: TableCell): { state: 'none' | 'mine' | 'theirs'; holder?: string } {
		const id =
			cell.kind === 'element'
				? (cell.item?.id ?? null)
				: cell.kind === 'value'
					? cell.element_id
					: null;
		return id === null ? { state: 'none' } : lockBadgeFor(id);
	}

	function toggleSort(index: number): void {
		const direction = sort?.column === index && sort.direction === 'asc' ? 'desc' : 'asc';
		setTableSort(tabId, { column: index, direction });
	}

	// The evaluate response's column-out (`page.columns[i]`) carries no
	// property name — only the definition's `property` column does. The two
	// arrays align 1:1 in definition order, so index across into the draft's
	// definition to recover the name a `ValueCell` needs to build its patch key.
	function columnNameFor(index: number): string | undefined {
		const col = getTableDraft(tabId)?.definition.columns[index];
		return col?.kind === 'property' ? col.name : undefined;
	}
</script>

<div
	data-testid="table-grid"
	bind:this={scrollEl}
	onscroll={onScroll}
	class="relative h-full overflow-auto"
>
	<div
		data-testid="table-header"
		role="row"
		class="sticky top-0 z-10 flex border-b border-border bg-card text-xs font-medium text-muted-foreground"
	>
		{#each page?.columns ?? [] as col, i (i)}
			<div
				class="relative flex shrink-0 items-center gap-1 border-r border-border px-2 py-1.5"
				style="width:{widthFor(col, i)}px"
			>
				<span class="truncate">{col.header || columnKindLabel(col.kind)}</span>
				<button
					type="button"
					class="ml-auto shrink-0 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
					aria-label="Sort by {col.header || columnKindLabel(col.kind)}"
					onclick={() => toggleSort(i)}
				>
					{#if sort?.column === i}{sort.direction === 'asc' ? '▲' : '▼'}{:else}↕{/if}
				</button>
				<div
					role="separator"
					aria-orientation="vertical"
					tabindex="-1"
					class="absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none select-none hover:bg-primary/50"
					class:bg-primary={resizing?.index === i}
					onpointerdown={(e) => onResizeStart(e, i, widthFor(col, i))}
					onpointermove={onResizeMove}
					onpointerup={onResizeEnd}
					onpointercancel={onResizeEnd}
					ondblclick={() => autoFitColumn(i)}
				></div>
			</div>
		{/each}
	</div>

	{#if error}
		<p class="p-4 text-xs text-destructive">{error}</p>
	{:else if loading && !page}
		<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
	{:else if page}
		<div style="height:{win.padTop}px"></div>
		{#each windowedRows as row, i (win.start + i)}
			{#if row}
				<div
					role="row"
					data-testid="table-row"
					class="flex border-b border-border/60"
					style="height:{offsets[win.start + i + 1] - offsets[win.start + i]}px"
				>
					{#each row.cells as cell, ci (ci)}
						{@const lock = cellLockBadge(cell)}
						<div
							class="flex shrink-0 items-start overflow-hidden border-r border-border/40 px-2 text-xs {lock.state ===
							'mine'
								? 'bg-warning/20'
								: lock.state === 'theirs'
									? 'bg-destructive/15'
									: ''}"
							data-lock={lock.state === 'none' ? undefined : lock.state}
							title={lock.state === 'mine'
								? 'Locked by you'
								: lock.state === 'theirs'
									? `Locked by ${lock.holder}`
									: undefined}
							style="width:{widthFor(page.columns[ci], ci)}px"
						>
							{#if cell.kind === 'element'}
								<div class="flex h-7 w-full min-w-0 items-center">
									<ElementCell {cell} />
								</div>
							{:else if cell.kind === 'value'}
								<div class="flex h-7 w-full min-w-0 items-center">
									<ValueCell {cell} {tabId} columnName={columnNameFor(ci)} />
								</div>
							{:else if cell.kind === 'values'}
								<ValuesCell {cell} />
							{:else}
								<ElementsCell {cell} />
							{/if}
						</div>
					{/each}
				</div>
			{:else}
				<!-- A row the sparse cache hasn't fetched yet (the range effect
				     has already requested it): same geometry, pulsing bars. -->
				<div
					role="row"
					data-testid="table-row-placeholder"
					class="flex border-b border-border/60"
					style="height:{ROW_H}px"
				>
					{#each page.columns as col, ci (ci)}
						<div
							class="flex shrink-0 items-center border-r border-border/40 px-2"
							style="width:{widthFor(col, ci)}px"
						>
							<div class="h-3 w-3/5 animate-pulse rounded bg-muted"></div>
						</div>
					{/each}
				</div>
			{/if}
		{/each}
		<div style="height:{win.padBottom}px"></div>
		{#if rows.length === 0}
			<p class="p-4 text-xs text-muted-foreground/70">No rows.</p>
		{/if}
		{#if loading}
			<p class="p-2 text-xs text-muted-foreground/70">Loading…</p>
		{/if}
	{:else}
		<!-- A brand-new table: never evaluated (see ensureTableDraft — the untyped
		     default scope would show EVERY element, so it opens empty instead). -->
		<p data-testid="table-empty-hint" class="p-4 text-xs text-muted-foreground/70">
			This table is empty. Open <span class="font-medium">Settings</span> to choose its scope — the elements
			(or navigation) its rows come from.
		</p>
	{/if}
</div>
