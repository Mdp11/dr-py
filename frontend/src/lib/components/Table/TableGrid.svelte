<script lang="ts">
	// The read-only table body: a sticky header row (labels, sort carets,
	// drag-resize handles) plus a windowed body over the store's currently
	// loaded page. The store REPLACES `page.rows` wholesale on every
	// `loadTablePage` (offset paging, not append), so this windows over
	// exactly what's loaded — it never merges pages across loads (mirrors the
	// module doc in `table-editor.svelte.ts`).
	import type { TableColumn } from '$lib/api/types';
	import {
		getTableDraft,
		getTableError,
		getTableLoading,
		getTablePage,
		getTableSort,
		setTableSort,
		updateTableDefinition
	} from '$lib/state';
	import { setColumnWidth } from '$lib/table/columns';
	import { computeWindow } from '$lib/components/Sidebar/windowing';
	import ElementCell from './Cell/ElementCell.svelte';
	import ElementsCell from './Cell/ElementsCell.svelte';
	import ValueCell from './Cell/ValueCell.svelte';
	import ValuesCell from './Cell/ValuesCell.svelte';

	let { tabId }: { tabId: string } = $props();

	const ROW_H = 28;
	const OVERSCAN = 8;
	const DEFAULT_WIDTH = 180;
	const MIN_WIDTH = 80;

	const page = $derived(getTablePage(tabId));
	const loading = $derived(getTableLoading(tabId));
	const sort = $derived(getTableSort(tabId));
	const error = $derived(getTableError(tabId));
	const rows = $derived(page?.rows ?? []);

	let scrollEl: HTMLElement | null = $state(null);
	let scrollTop = $state(0);
	let viewportH = $state(0);

	const win = $derived(
		computeWindow({ scrollTop, viewportH, rowH: ROW_H, total: rows.length, overscan: OVERSCAN })
	);
	const windowedRows = $derived(rows.slice(win.start, win.end));

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

	function toggleSort(index: number): void {
		const direction = sort?.column === index && sort.direction === 'asc' ? 'desc' : 'asc';
		setTableSort(tabId, { column: index, direction });
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
				<span class="truncate">{col.header || col.kind}</span>
				<button
					type="button"
					class="ml-auto shrink-0 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
					aria-label="Sort by {col.header || col.kind}"
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
		{#each windowedRows as row (JSON.stringify(row.key))}
			<div
				role="row"
				data-testid="table-row"
				class="flex border-b border-border/60"
				style="height:{ROW_H}px"
			>
				{#each row.cells as cell, ci (ci)}
					<div
						class="flex shrink-0 items-center overflow-hidden border-r border-border/40 px-2 text-xs"
						style="width:{widthFor(page.columns[ci], ci)}px"
					>
						{#if cell.kind === 'element'}
							<ElementCell {cell} />
						{:else if cell.kind === 'value'}
							<ValueCell {cell} {tabId} />
						{:else if cell.kind === 'values'}
							<ValuesCell {cell} />
						{:else}
							<ElementsCell {cell} />
						{/if}
					</div>
				{/each}
			</div>
		{/each}
		<div style="height:{win.padBottom}px"></div>
		{#if rows.length === 0}
			<p class="p-4 text-xs text-muted-foreground/70">No rows.</p>
		{/if}
		{#if loading}
			<p class="p-2 text-xs text-muted-foreground/70">Loading…</p>
		{/if}
	{/if}
</div>
