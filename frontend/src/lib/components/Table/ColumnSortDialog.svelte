<script lang="ts">
	// The Sorting dialog: the definition's `sort` as a priority list. Sorting
	// columns come first, in priority order — the first key orders the rows,
	// each later one breaks the ties of the one before — with a direction
	// toggle, grip drag and ↑/↓; the remaining columns follow in display order
	// with only a checkbox to join the list (as the last, ascending key). It
	// edits `sort` on the definition through `updateTableDefinition`, since a
	// new order needs a re-evaluation. Modal, like the Reorder dialog: there
	// is nothing to look up in the model while sorting.
	import { getTableDraft, updateTableDefinition } from '$lib/state';
	import {
		columnKindLabel,
		columnLabel,
		moveSortKey,
		resetSort,
		setSortDirection,
		sortKeys,
		toggleSortColumn
	} from '$lib/table/columns';
	import { displayOrder } from '$lib/table/export-layout';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import { portal } from '$lib/util/portal';
	import * as Dialog from '$lib/components/ui/dialog';
	import { EyeOff } from '@lucide/svelte';

	let { tabId, open = $bindable(false) }: { tabId: string; open?: boolean } = $props();

	const defn = $derived(getTableDraft(tabId)?.definition);
	const keys = $derived(defn ? sortKeys(defn) : []);
	/** Definition indices of the columns that do NOT sort, in display order. */
	const rest = $derived.by(() => {
		if (!defn) return [];
		const sorting = new Set(keys.map((k) => k.column));
		return displayOrder(defn).filter((i) => !sorting.has(i));
	});

	function move(from: number, to: number): void {
		if (!defn) return;
		if (to < 0 || to >= keys.length) return;
		updateTableDefinition(tabId, moveSortKey(defn, from, to));
	}

	function toggle(index: number): void {
		if (!defn) return;
		updateTableDefinition(tabId, toggleSortColumn(defn, index));
	}

	function flip(index: number, direction: 'asc' | 'desc'): void {
		if (!defn) return;
		updateTableDefinition(
			tabId,
			setSortDirection(defn, index, direction === 'asc' ? 'desc' : 'asc')
		);
	}

	function reset(): void {
		if (!defn) return;
		updateTableDefinition(tabId, resetSort(defn));
	}

	const drag = createColumnDrag({
		attr: 'data-sort-drop',
		axis: 'y',
		validate: () => true,
		onDrop: move
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content data-testid="column-sort-dialog" class="flex max-h-[85vh] flex-col sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">Sort rows</Dialog.Title>
			<Dialog.Description class="text-xs">
				Tick the columns to sort by. The first one orders the rows; each next one breaks the ties of
				the one above. Drag a row, or use the arrows, to change the priority.
			</Dialog.Description>
		</Dialog.Header>
		{#if defn}
			<ol data-testid="column-sort-list" class="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
				{#each keys as key, pos (key.column)}
					{@const col = defn.columns[key.column]}
					<!-- The reflow transform is applied ONLY while a drag is live — a
					     permanent one would make each row a stacking context (see
					     ColumnManager's card for the popup-clipping history). -->
					<li
						data-sort-drop={pos}
						data-testid="sort-row-{key.column}"
						class="flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs"
						style:transform={drag.dragging ? `translateY(${drag.offsetOf(pos)}px)` : undefined}
						class:transition-transform={drag.dragging}
						class:duration-150={drag.dragging}
						class:opacity-50={drag.from === pos}
					>
						<span
							role="button"
							tabindex="-1"
							data-testid="sort-grip-{key.column}"
							aria-label="Drag to change priority"
							class="shrink-0 cursor-grab touch-none select-none text-muted-foreground/50"
							onpointerdown={(e) => drag.onPointerDown(e, pos)}
							onpointermove={(e) => drag.onPointerMove(e)}
							onpointerup={(e) => drag.onPointerUp(e)}
							onpointercancel={(e) => drag.onPointerCancel(e)}>⠿</span
						>
						<input
							type="checkbox"
							data-testid="sort-toggle-{key.column}"
							aria-label="Sort by {col.header || columnLabel(col)}"
							checked={true}
							onchange={() => toggle(key.column)}
						/>
						<span class="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground/70">
							{pos + 1}
						</span>
						<span class="min-w-0 flex-1 truncate" class:text-muted-foreground={col.hidden}>
							{col.header || columnLabel(col)}
						</span>
						{#if col.hidden}
							<EyeOff class="size-3 shrink-0 text-muted-foreground/60" aria-label="Hidden column" />
						{/if}
						<span class="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/60">
							{columnKindLabel(col.kind)}
						</span>
						<button
							type="button"
							data-testid="sort-dir-{key.column}"
							aria-label={key.direction === 'asc'
								? 'Ascending, click for descending'
								: 'Descending, click for ascending'}
							title={key.direction === 'asc' ? 'Ascending' : 'Descending'}
							class="w-6 rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted"
							onclick={() => flip(key.column, key.direction)}
						>
							{key.direction === 'asc' ? '▲' : '▼'}
						</button>
						<button
							type="button"
							data-testid="sort-up-{key.column}"
							aria-label="Raise priority"
							class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted disabled:opacity-30"
							disabled={pos === 0}
							onclick={() => move(pos, pos - 1)}
						>
							&uarr;
						</button>
						<button
							type="button"
							data-testid="sort-down-{key.column}"
							aria-label="Lower priority"
							class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted disabled:opacity-30"
							disabled={pos === keys.length - 1}
							onclick={() => move(pos, pos + 1)}
						>
							&darr;
						</button>
					</li>
				{/each}
				{#each rest as i (i)}
					{@const col = defn.columns[i]}
					<li
						data-testid="sort-row-{i}"
						class="flex items-center gap-2 rounded border border-dashed border-border/70 px-2 py-1 text-xs text-muted-foreground"
					>
						<span class="w-3 shrink-0"></span>
						<input
							type="checkbox"
							data-testid="sort-toggle-{i}"
							aria-label="Sort by {col.header || columnLabel(col)}"
							checked={false}
							onchange={() => toggle(i)}
						/>
						<span class="w-4 shrink-0"></span>
						<span class="min-w-0 flex-1 truncate">{col.header || columnLabel(col)}</span>
						{#if col.hidden}
							<EyeOff class="size-3 shrink-0 text-muted-foreground/60" aria-label="Hidden column" />
						{/if}
						<span class="shrink-0 font-mono text-[10px] uppercase text-muted-foreground/60">
							{columnKindLabel(col.kind)}
						</span>
					</li>
				{/each}
			</ol>
		{/if}
		{#if drag.dragging && drag.ghost && drag.ghost.w > 0 && drag.from !== null && defn}
			{@const dragCol = defn.columns[keys[drag.from].column]}
			<div
				use:portal
				data-testid="sort-drag-ghost"
				class="pointer-events-none fixed z-[60] flex items-center gap-2 rounded border border-primary/40 bg-card px-2 py-1 text-xs opacity-90 shadow-lg"
				style="left:{drag.ghost.x}px; top:{drag.ghost.y}px; width:{drag.ghost.w}px"
			>
				<span class="text-muted-foreground/50">⠿</span>
				<span class="truncate">{dragCol ? dragCol.header || columnLabel(dragCol) : ''}</span>
			</div>
		{/if}
		<Dialog.Footer class="flex-row items-center justify-between sm:justify-between">
			<button
				type="button"
				data-testid="sort-reset"
				class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
				disabled={keys.length === 0}
				title="Show the rows in the order they are computed"
				onclick={reset}
			>
				Clear sorting
			</button>
			<Dialog.Close
				data-testid="sort-done"
				class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
			>
				Done
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
