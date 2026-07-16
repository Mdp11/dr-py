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
		remapTableSortForMove,
		setTableSort,
		updateTableDefinition
	} from '$lib/state';
	import { columnKindLabel, moveColumn, setColumnWidth } from '$lib/table/columns';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import { computeWindowVariable } from '$lib/components/Sidebar/windowing';
	import { Pencil, Plus } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import ElementCell from './Cell/ElementCell.svelte';
	import ElementsCell from './Cell/ElementsCell.svelte';
	import ValueCell from './Cell/ValueCell.svelte';
	import ValuesCell from './Cell/ValuesCell.svelte';

	let {
		tabId,
		onEditColumn,
		onAddColumn
	}: {
		tabId: string;
		onEditColumn?: (index: number) => void;
		onAddColumn?: (kind: 'property' | 'navigation') => void;
	} = $props();

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

	// Hidden columns are evaluated server-side (ColumnRefs may target them)
	// but never rendered. Pairs keep the DEFINITION index i — sort, resize and
	// width all speak definition indices; only DOM order is compacted.
	const visibleCols = $derived.by(() => {
		const cols = page?.columns ?? [];
		const defCols = getTableDraft(tabId)?.definition.columns;
		return cols.map((col, i) => ({ col, i })).filter(({ i }) => !defCols?.[i]?.hidden);
	});

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
		const cols = visibleCols;
		const out = new Array<number>(rows.length + 1);
		out[0] = 0;
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const lines = r
				? Math.max(
						1,
						...cols
							.map(({ i: ci }) => r.cells[ci])
							.filter((c) => c !== undefined)
							.map(cellLines)
					)
				: 1;
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
	// `defIndex` is the definition index (what sort/resize/width speak);
	// `domIndex` is the compacted on-screen position hidden columns leave
	// behind — DOM lookups use it, `setColumnWidth` uses `defIndex`.
	function autoFitColumn(defIndex: number, domIndex: number): void {
		if (!scrollEl) return;
		let max = MIN_WIDTH;
		const headerCell = scrollEl.querySelectorAll('[data-testid="table-header"] > div')[domIndex];
		const label = headerCell?.querySelector('span');
		// label + sort caret + flex gaps + horizontal padding
		if (label) max = Math.max(max, Math.ceil(label.scrollWidth) + 44);
		for (const row of scrollEl.querySelectorAll('[data-testid="table-row"]')) {
			const content = row.children[domIndex]?.firstElementChild;
			// px-2 padding (16) + right border + a rounding safety px
			if (content) max = Math.max(max, Math.ceil(content.scrollWidth) + 18);
		}
		const draft = getTableDraft(tabId);
		if (!draft) return;
		const width = Math.min(max, MAX_AUTO_WIDTH);
		updateTableDefinition(tabId, setColumnWidth(draft.definition, defIndex, width));
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

	// Header-cell drag-to-reorder (Task 10): the same pointer-driven controller
	// as ColumnManager's grip, hit-testing DEFINITION indices via
	// `data-col-hdr-drop` so a drop onto a visible header still resolves to the
	// right column even with hidden columns compacting the DOM order.
	const hdrDrag = createColumnDrag({
		attr: 'data-col-hdr-drop',
		getDefinition: () => getTableDraft(tabId)?.definition,
		onDrop: (fromIdx, toIdx) => {
			const draft = getTableDraft(tabId);
			if (!draft) return;
			try {
				const next = moveColumn(draft.definition, fromIdx, toIdx);
				remapTableSortForMove(tabId, fromIdx, toIdx);
				updateTableDefinition(tabId, next);
			} catch {
				/* forward-ref move: the hover highlight already showed invalid */
			}
		}
	});

	// The header cell's own pointerdown starts the reorder drag, EXCEPT when the
	// press originates on the sort/edit buttons or the resize handle — those own
	// their own pointer gestures and must not also arm a column drag.
	function onHeaderPointerDown(e: PointerEvent, index: number): void {
		const t = e.target as HTMLElement;
		if (t.closest('button, [role="separator"]')) return;
		hdrDrag.onPointerDown(e, index);
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
		{#each visibleCols as v (v.i)}
			<div
				role="columnheader"
				tabindex="-1"
				class="relative flex shrink-0 cursor-grab items-center gap-1 border-r border-border px-2 py-1.5 touch-none select-none"
				style="width:{widthFor(v.col, v.i)}px"
				data-col-hdr-drop={v.i}
				class:ring-1={hdrDrag.over === v.i && hdrDrag.from !== null}
				class:ring-primary={hdrDrag.over === v.i && hdrDrag.from !== null && hdrDrag.valid}
				class:ring-destructive={hdrDrag.over === v.i && hdrDrag.from !== null && !hdrDrag.valid}
				class:opacity-50={hdrDrag.from === v.i}
				onpointerdown={(e) => onHeaderPointerDown(e, v.i)}
				onpointermove={(e) => hdrDrag.onPointerMove(e)}
				onpointerup={(e) => hdrDrag.onPointerUp(e)}
				onpointercancel={(e) => hdrDrag.onPointerCancel(e)}
			>
				<span class="truncate">{v.col.header || columnKindLabel(v.col.kind)}</span>
				<button
					type="button"
					class="ml-auto shrink-0 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
					aria-label="Sort by {v.col.header || columnKindLabel(v.col.kind)}"
					onclick={() => toggleSort(v.i)}
				>
					{#if sort?.column === v.i}{sort.direction === 'asc' ? '▲' : '▼'}{:else}↕{/if}
				</button>
				{#if onEditColumn}
					<button
						type="button"
						data-testid="header-edit-{v.i}"
						aria-label="Edit column {v.col.header || columnKindLabel(v.col.kind)}"
						title="Edit this column's settings"
						class="shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
						onclick={() => onEditColumn?.(v.i)}
					>
						<Pencil class="size-3" />
					</button>
				{/if}
				<div
					role="separator"
					aria-orientation="vertical"
					tabindex="-1"
					class="absolute top-0 right-0 h-full w-1 cursor-col-resize touch-none select-none hover:bg-primary/50"
					class:bg-primary={resizing?.index === v.i}
					onpointerdown={(e) => onResizeStart(e, v.i, widthFor(v.col, v.i))}
					onpointermove={onResizeMove}
					onpointerup={onResizeEnd}
					onpointercancel={onResizeEnd}
					ondblclick={() =>
						autoFitColumn(
							v.i,
							visibleCols.findIndex((vv) => vv.i === v.i)
						)}
				></div>
			</div>
		{/each}
		{#if onAddColumn}
			<div class="flex shrink-0 items-center px-1">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						data-testid="header-add-column"
						aria-label="Add a column"
						title="Add a column"
						class="rounded border border-dashed border-input px-1.5 py-0.5 text-muted-foreground/70 transition-colors hover:text-foreground"
					>
						<Plus class="size-3" />
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start">
						<DropdownMenu.Item onSelect={() => onAddColumn?.('property')}>
							Property column
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => onAddColumn?.('navigation')}>
							Navigation column
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		{/if}
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
					{#each visibleCols as v (v.i)}
						{@const cell = row.cells[v.i]}
						{#if cell}
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
								style="width:{widthFor(v.col, v.i)}px"
							>
								{#if cell.kind === 'element'}
									<div class="flex h-7 max-w-full min-w-0 items-center">
										<ElementCell {cell} />
									</div>
								{:else if cell.kind === 'value'}
									<div class="flex h-7 max-w-full min-w-0 items-center">
										<ValueCell {cell} {tabId} columnName={columnNameFor(v.i)} />
									</div>
								{:else if cell.kind === 'values'}
									<ValuesCell {cell} />
								{:else}
									<ElementsCell {cell} />
								{/if}
							</div>
						{:else}
							<div
								class="shrink-0 border-r border-border/40 px-2"
								style="width:{widthFor(v.col, v.i)}px"
							></div>
						{/if}
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
					{#each visibleCols as v (v.i)}
						<div
							class="flex shrink-0 items-center border-r border-border/40 px-2"
							style="width:{widthFor(v.col, v.i)}px"
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
