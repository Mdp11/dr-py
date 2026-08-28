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
		consumeScrollRequest,
		ensureTableRange,
		getTableDraft,
		getTableError,
		getTableLoading,
		getTablePage,
		getTableSort,
		lockBadgeFor,
		setTableSort,
		updateTableDefinition,
		updateTableDisplayOrder
	} from '$lib/state';
	import { columnKindLabel, moveDisplayColumn, setColumnWidth } from '$lib/table/columns';
	import { displayOrder } from '$lib/table/export-layout';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import { portal } from '$lib/util/portal';
	import { computeWindowVariable } from '$lib/components/Sidebar/windowing';
	import { Pencil, Plus } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import ElementCell from './Cell/ElementCell.svelte';
	import ElementsCell from './Cell/ElementsCell.svelte';
	import ErrorCell from './Cell/ErrorCell.svelte';
	import PendingCell from './Cell/PendingCell.svelte';
	import ValueCell from './Cell/ValueCell.svelte';
	import ValuesCell from './Cell/ValuesCell.svelte';

	let {
		tabId,
		onEditColumn,
		onAddColumn,
		onInsertColumn
	}: {
		tabId: string;
		onEditColumn?: (index: number) => void;
		onAddColumn?: (kind: ColumnKind) => void;
		/** Insert a fresh column of `kind` before/after DEFINITION column
		 * `index` (the header menu's "Insert before/after"). */
		onInsertColumn?: (index: number, place: 'before' | 'after', kind: ColumnKind) => void;
	} = $props();

	type ColumnKind = 'property' | 'navigation' | 'script';
	const ADDABLE_KINDS: { kind: ColumnKind; label: string }[] = [
		{ kind: 'property', label: 'Property' },
		{ kind: 'navigation', label: 'Navigation' },
		{ kind: 'script', label: 'Script' }
	];
	const INSERT_PLACES: { place: 'before' | 'after'; label: string }[] = [
		{ place: 'before', label: 'Insert before' },
		{ place: 'after', label: 'Insert after' }
	];

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
	/** How long a jumped-to cell keeps its outline. Long enough to find with
	 * the eye after the scroll settles, short enough not to be mistaken for a
	 * persistent state of the cell. */
	const HIGHLIGHT_MS = 2_000;

	const page = $derived(getTablePage(tabId));
	const loading = $derived(getTableLoading(tabId));
	const sort = $derived(getTableSort(tabId));
	const error = $derived(getTableError(tabId));
	const rows = $derived(page?.rows ?? []);

	// Hidden columns are evaluated server-side (ColumnRefs may target them)
	// but never rendered. Pairs keep the DEFINITION index i — sort, resize,
	// width and cells all speak definition indices; only DOM order differs:
	// it follows the definition's DISPLAY order (`display_order`, the grid's
	// own permutation, decoupled from the computation order) with hidden
	// columns compacted out. `pos` is the on-screen position, what the header
	// drag speaks.
	const visibleCols = $derived.by(() => {
		const cols = page?.columns ?? [];
		const defn = getTableDraft(tabId)?.definition;
		const order = defn ? displayOrder(defn) : cols.map((_, i) => i);
		return order
			.filter((i) => i < cols.length && !defn?.columns[i]?.hidden)
			.map((i, pos) => ({ col: cols[i], i, pos }));
	});

	// Item 10: a presentation-only "#" gutter. NOT a definition column — it
	// never enters visibleCols, so ColumnRef indices, sort, resize and reorder
	// are untouched. The number is the row's 1-based absolute index in the
	// CURRENT (post-sort) result set, which the virtualizer already knows as
	// `win.start + i`.
	const showRowNumbers = $derived(getTableDraft(tabId)?.definition.show_row_numbers ?? false);

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

	// Jump-to-cell, driven by the script-error panel through the store (see
	// `requestScrollToCell`). The panel lives in TableView's fixed chrome and
	// the scroll container is here, so the request is handed over as state
	// rather than a prop chain; `consumeScrollRequest` CLEARS it, which is what
	// makes this effect converge — it re-runs once on the clear, finds nothing,
	// and stops. Anything else that re-runs it (rows streaming in) finds
	// nothing too, so the user is never scrolled somewhere they didn't ask for.
	//
	// BEST EFFORT by construction: row heights are estimated for rows the
	// sparse cache hasn't fetched (see `offsets` above — one line each), so a
	// jump far past the loaded window can land slightly off. That is the same
	// tradeoff the virtualizer already makes; the temporary outline is what
	// makes the target findable when it does.
	let highlight = $state<{ rowIndex: number; columnIndex: number } | null>(null);
	let highlightTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const request = consumeScrollRequest(tabId);
		if (!request) return;
		if (scrollEl) {
			// `offsets` is measured from the FIRST ROW's top (`offsets[0] === 0`),
			// while the sticky header sits inside the same scroll container and
			// precedes the rows in normal flow — so row i's content-box top is
			// `headerHeight + offsets[i]`, and `scrollTop = offsets[i]` already
			// parks row i flush BELOW the sticky header. No header correction:
			// subtracting one would push the target a header's height further
			// down the viewport, not clear of it.
			const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
			const top = Math.max(0, Math.min(offsets[request.rowIndex] ?? 0, max));
			scrollEl.scrollTop = top;
			scrollTop = top;
		}
		highlight = request;
		if (highlightTimer !== null) clearTimeout(highlightTimer);
		highlightTimer = setTimeout(() => {
			highlight = null;
			highlightTimer = null;
		}, HIGHLIGHT_MS);
	});
	$effect(() => () => {
		if (highlightTimer !== null) clearTimeout(highlightTimer);
	});

	function isHighlighted(rowIndex: number, columnIndex: number): boolean {
		return (
			highlight !== null && highlight.rowIndex === rowIndex && highlight.columnIndex === columnIndex
		);
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

	// Intrinsic width of one rendered cell, measured on a hidden CLONE with
	// every width cap lifted. Measuring the live node cannot work: the cell
	// content sits under a max-w-full/truncate chain, so a truncating child's
	// border box is capped at the CURRENT column width and the wrapper's
	// scrollWidth reports that cap, not the full text — which is what made each
	// auto-fit grow the column by its padding constant instead of converging.
	// The clone carries the cell's own classes (text-xs, px-2), so styling —
	// and therefore text metrics — match the live cell.
	function measureCellWidth(cell: Element): number {
		const probe = document.createElement('div');
		probe.style.cssText =
			'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none';
		const clone = cell.cloneNode(true) as HTMLElement;
		clone.style.width = 'max-content'; // override the inline width:{...}px
		for (const n of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
			n.style.maxWidth = 'none';
			n.style.overflow = 'visible';
		}
		probe.appendChild(clone);
		document.body.appendChild(probe);
		const w = Math.ceil(clone.getBoundingClientRect().width);
		probe.remove();
		return w;
	}

	// Double-click auto-fit: size the column to its widest RENDERED content —
	// the header label plus the cells the window currently shows (the sparse
	// row cache means off-screen rows can't be measured).
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
			const cell = row.children[domIndex];
			// the measured clone already includes the cell's px-2 padding;
			// +2 covers the right border and a rounding safety px
			if (cell) max = Math.max(max, measureCellWidth(cell) + 2);
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

	// Header-cell drag-to-reorder: the same pointer-driven controller as
	// ColumnManager's grip, but it reorders the DISPLAY order, not the
	// definition — so it speaks on-screen positions (`data-col-hdr-drop={pos}`,
	// compacted over hidden columns) and carries none of `moveColumn`'s
	// backward-ref constraints (`validate: () => true`): what the user sees
	// can be arranged freely, computation order is the Columns panel's job.
	// `moveDisplayColumn` takes positions in `displayOrder(defn)`, which still
	// lists HIDDEN columns, so the visible positions are mapped back through
	// `visibleCols`. Display order needs no re-evaluation, hence
	// `updateTableDisplayOrder` rather than `updateTableDefinition`.
	const hdrDrag = createColumnDrag({
		attr: 'data-col-hdr-drop',
		validate: () => true,
		onDrop: (fromPos, toPos) => {
			const draft = getTableDraft(tabId);
			const from = visibleCols[fromPos]?.i;
			const to = visibleCols[toPos]?.i;
			if (!draft || from === undefined || to === undefined) return;
			const order = displayOrder(draft.definition);
			updateTableDisplayOrder(
				tabId,
				moveDisplayColumn(draft.definition, order.indexOf(from), order.indexOf(to))
			);
		}
	});

	/** The live-reflow translation for the column at display position `pos`,
	 * applied ONLY while a drag is live: a permanent `transform` (even an
	 * identity one) makes every cell a stacking context and a containing
	 * block for `position: fixed` descendants, which is how popups rendered
	 * inside a cell ended up clipped and painted under later cells. */
	function dragTransform(pos: number): string | undefined {
		return hdrDrag.dragging ? `translateX(${hdrDrag.offsetOf(pos)}px)` : undefined;
	}

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
	<!-- `min-w-max`: the strip is a block-level flex, so without it its box
	     — and its background — is only ever as wide as the scroll container,
	     while the header CELLS run as wide as the rows. Past the container's
	     width the cells overflowed a background-less strip, and the rows
	     scrolled straight through the column names. Each cell paints its own
	     `bg-card` too, so a cell mid-drag (translated out of the strip) stays
	     opaque as well. -->
	<div
		data-testid="table-header"
		role="row"
		class="sticky top-0 z-10 flex min-w-max border-b border-border bg-card text-xs font-medium text-muted-foreground"
	>
		{#if showRowNumbers}
			<div
				role="columnheader"
				data-testid="row-number-header"
				class="flex w-12 shrink-0 items-center justify-end border-r border-border bg-card px-2 py-1.5 tabular-nums text-muted-foreground/70"
			>
				#
			</div>
		{/if}
		{#each visibleCols as v (v.i)}
			<div
				role="columnheader"
				tabindex="-1"
				class="relative flex shrink-0 cursor-grab items-center gap-1 border-r border-border bg-card px-2 py-1.5 touch-none select-none"
				style="width:{widthFor(v.col, v.i)}px"
				style:transform={dragTransform(v.pos)}
				data-col-hdr-drop={v.pos}
				data-col-index={v.i}
				class:transition-transform={hdrDrag.dragging}
				class:duration-150={hdrDrag.dragging}
				class:opacity-50={hdrDrag.from === v.pos}
				onpointerdown={(e) => onHeaderPointerDown(e, v.pos)}
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
					<!-- One menu per header: edit this column, or insert a fresh one
					     of any kind right before/after it — the grid-side twin of the
					     Columns panel's per-card insert menu. -->
					<DropdownMenu.Root>
						<DropdownMenu.Trigger
							data-testid="header-edit-{v.i}"
							aria-label="Edit column {v.col.header || columnKindLabel(v.col.kind)}"
							title="Edit this column, or insert a column beside it"
							class="shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
						>
							<Pencil class="size-3" />
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start">
							<DropdownMenu.Item
								data-testid="header-edit-column-{v.i}"
								onSelect={() => onEditColumn?.(v.i)}
							>
								Edit column…
							</DropdownMenu.Item>
							{#if onInsertColumn}
								{#each INSERT_PLACES as { place, label } (place)}
									<DropdownMenu.Separator />
									<DropdownMenu.Group>
										<DropdownMenu.GroupHeading>{label}</DropdownMenu.GroupHeading>
										{#each ADDABLE_KINDS as k (k.kind)}
											<DropdownMenu.Item
												data-testid="header-insert-{place}-{k.kind}-{v.i}"
												onSelect={() => onInsertColumn?.(v.i, place, k.kind)}
											>
												+ {k.label}
											</DropdownMenu.Item>
										{/each}
									</DropdownMenu.Group>
								{/each}
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
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
							+ Property
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => onAddColumn?.('navigation')}>
							+ Navigation
						</DropdownMenu.Item>
						<DropdownMenu.Item onSelect={() => onAddColumn?.('script')}>+ Script</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			</div>
		{/if}
	</div>

	{#if error}
		<p class="p-4 text-xs text-destructive">{error}</p>
	{:else if loading && !page}
		<!-- First load: pulsing skeleton rows, not a static "Loading…" line. A
		     table whose script columns are still being computed can sit here for
		     a while, and a word that never moves reads as a hung UI. -->
		<div data-testid="table-loading-skeleton" class="p-2">
			{#each { length: 8 }, i (i)}
				<div class="flex gap-2 border-b border-border/40 py-2" style="opacity:{1 - i * 0.1}">
					<div class="h-3 w-1/4 animate-pulse rounded bg-muted"></div>
					<div class="h-3 w-1/3 animate-pulse rounded bg-muted"></div>
					<div class="h-3 w-1/6 animate-pulse rounded bg-muted"></div>
				</div>
			{/each}
		</div>
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
					{#if showRowNumbers}
						<!-- items-start on the gutter + items-center on an inner h-7 span
						     (not items-center on the gutter itself, unlike the placeholder
						     gutter below): a data row's HEIGHT IS VARIABLE (wrapped cell
						     content), so the number must top-align to line 1 at the
						     ROW_H-tall first line, not center across the whole row. The
						     placeholder gutter below is always exactly ROW_H tall, where
						     top-align and center-align are the same thing. -->
						<div
							data-testid="row-number-cell"
							class="flex w-12 shrink-0 items-start justify-end border-r border-border/40 px-2 text-xs tabular-nums text-muted-foreground/60"
						>
							<span class="flex h-7 items-center">{win.start + i + 1}</span>
						</div>
					{/if}
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
								data-highlight={isHighlighted(win.start + i, v.i) ? 'true' : undefined}
								class:ring-2={isHighlighted(win.start + i, v.i)}
								class:ring-destructive={isHighlighted(win.start + i, v.i)}
								class:ring-inset={isHighlighted(win.start + i, v.i)}
								title={lock.state === 'mine'
									? 'Locked by you'
									: lock.state === 'theirs'
										? `Locked by ${lock.holder}`
										: undefined}
								style="width:{widthFor(v.col, v.i)}px"
								style:transform={dragTransform(v.pos)}
								class:transition-transform={hdrDrag.dragging}
								class:duration-150={hdrDrag.dragging}
								class:opacity-50={hdrDrag.from === v.pos}
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
								{:else if cell.kind === 'error'}
									<ErrorCell {cell} />
								{:else if cell.kind === 'elements'}
									<ElementsCell {cell} />
								{:else if cell.kind === 'pending'}
									<PendingCell />
								{:else}
									<!-- Exhaustiveness guard: `cell` is `never` here, so a new
									     TableCell kind fails `npm run check` at THIS line instead
									     of silently rendering a blank cell (which is exactly how
									     `pending` shipped invisible). Renders nothing at runtime,
									     so an unknown kind from a newer backend degrades to an
									     empty cell rather than throwing. -->
									<!-- eslint-disable-next-line @typescript-eslint/no-unused-vars -->
									{@const _exhaustive = cell satisfies never}
								{/if}
							</div>
						{:else}
							<div
								class="shrink-0 border-r border-border/40 px-2"
								class:transition-transform={hdrDrag.dragging}
								class:duration-150={hdrDrag.dragging}
								style="width:{widthFor(v.col, v.i)}px"
								style:transform={dragTransform(v.pos)}
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
					{#if showRowNumbers}
						<div
							data-testid="row-number-cell"
							class="flex w-12 shrink-0 items-center justify-end border-r border-border/40 px-2 text-xs tabular-nums text-muted-foreground/60"
						>
							{win.start + i + 1}
						</div>
					{/if}
					{#each visibleCols as v (v.i)}
						<div
							class="flex shrink-0 items-center border-r border-border/40 px-2"
							class:transition-transform={hdrDrag.dragging}
							class:duration-150={hdrDrag.dragging}
							style="width:{widthFor(v.col, v.i)}px"
							style:transform={dragTransform(v.pos)}
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
			<p class="flex items-center gap-2 p-2 text-xs text-muted-foreground/70">
				<span
					class="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted border-t-primary"
				></span>
				Loading…
			</p>
		{/if}
	{:else}
		<!-- A brand-new table: never evaluated (see ensureTableDraft — the untyped
		     default scope would show EVERY element, so it opens empty instead). -->
		<p data-testid="table-empty-hint" class="p-4 text-xs text-muted-foreground/70">
			This table is empty. Open <span class="font-medium">Columns</span> to choose its scope — the elements
			(or navigation) its rows come from.
		</p>
	{/if}
	{#if hdrDrag.dragging && hdrDrag.ghost && hdrDrag.ghost.w > 0 && hdrDrag.from !== null}
		{@const dragCol = visibleCols[hdrDrag.from]?.col}
		<!-- Detached drag ghost: a copy of the grabbed header cell following the
		     pointer. Portaled to <body> (position:fixed alone is not enough: a
		     transformed ancestor would make it scroll and clip with the grid). -->
		<div
			use:portal
			data-testid="header-drag-ghost"
			class="pointer-events-none fixed z-50 flex items-center rounded border border-primary/40 bg-card px-2 py-1.5 text-xs font-medium text-foreground opacity-90 shadow-lg"
			style="left:{hdrDrag.ghost.x}px; top:{hdrDrag.ghost.y}px; width:{hdrDrag.ghost
				.w}px; height:{hdrDrag.ghost.h}px"
		>
			<span class="truncate">{dragCol ? dragCol.header || columnKindLabel(dragCol.kind) : ''}</span>
		</div>
	{/if}
</div>
