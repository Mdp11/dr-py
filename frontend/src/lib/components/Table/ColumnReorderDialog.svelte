<script lang="ts">
	// The Reorder dialog: the grid's DISPLAY order as a bare list of column
	// names — grip drag plus ↑/↓ — with none of the Columns panel's editors
	// in the way. It edits `display_order` only, which carries no constraint
	// (the definition/computation order is untouched, so a backward-only
	// ColumnRef can never be violated here) and needs no re-evaluation, so
	// every edit goes through `updateTableDisplayOrder`, not
	// `updateTableDefinition`. Modal, unlike the Columns panel: there is
	// nothing to look up in the model while reordering.
	import { getTableDraft, updateTableDisplayOrder } from '$lib/state';
	import {
		columnKindLabel,
		columnLabel,
		moveDisplayColumn,
		resetDisplayOrder
	} from '$lib/table/columns';
	import { displayOrder } from '$lib/table/export-layout';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import { portal } from '$lib/util/portal';
	import * as Dialog from '$lib/components/ui/dialog';
	import { EyeOff } from '@lucide/svelte';

	let { tabId, open = $bindable(false) }: { tabId: string; open?: boolean } = $props();

	const defn = $derived(getTableDraft(tabId)?.definition);
	/** `[definition index]` in display order — the list's own coordinate
	 * space (`pos`), hidden columns included so they can be placed too. */
	const order = $derived(defn ? displayOrder(defn) : []);
	const customized = $derived((defn?.display_order?.length ?? 0) > 0);

	function move(from: number, to: number): void {
		if (!defn) return;
		if (to < 0 || to >= order.length) return;
		updateTableDisplayOrder(tabId, moveDisplayColumn(defn, from, to));
	}

	function reset(): void {
		if (!defn) return;
		updateTableDisplayOrder(tabId, resetDisplayOrder(defn));
	}

	const drag = createColumnDrag({
		attr: 'data-reorder-drop',
		axis: 'y',
		validate: () => true,
		onDrop: move
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		data-testid="column-reorder-dialog"
		class="flex max-h-[85vh] flex-col sm:max-w-md"
	>
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide"
				>Reorder columns</Dialog.Title
			>
			<Dialog.Description class="text-xs">
				Display order only — how columns are computed is unchanged. Drag a row, or use the arrows.
			</Dialog.Description>
		</Dialog.Header>
		{#if defn}
			<ol data-testid="column-reorder-list" class="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
				{#each order as i, pos (i)}
					{@const col = defn.columns[i]}
					<!-- The reflow transform is applied ONLY while a drag is live — a
					     permanent one would make each row a stacking context (see
					     ColumnManager's card for the popup-clipping history). -->
					<li
						data-reorder-drop={pos}
						data-testid="reorder-row-{i}"
						class="flex items-center gap-2 rounded border border-border bg-card px-2 py-1 text-xs"
						style:transform={drag.dragging ? `translateY(${drag.offsetOf(pos)}px)` : undefined}
						class:transition-transform={drag.dragging}
						class:duration-150={drag.dragging}
						class:opacity-50={drag.from === pos}
					>
						<span
							role="button"
							tabindex="-1"
							data-testid="reorder-grip-{i}"
							aria-label="Drag to reorder"
							class="shrink-0 cursor-grab touch-none select-none text-muted-foreground/50"
							onpointerdown={(e) => drag.onPointerDown(e, pos)}
							onpointermove={(e) => drag.onPointerMove(e)}
							onpointerup={(e) => drag.onPointerUp(e)}
							onpointercancel={(e) => drag.onPointerCancel(e)}>⠿</span
						>
						<span class="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground/70">
							{i}
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
							data-testid="reorder-up-{i}"
							aria-label="Move up"
							class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted disabled:opacity-30"
							disabled={pos === 0}
							onclick={() => move(pos, pos - 1)}
						>
							&uarr;
						</button>
						<button
							type="button"
							data-testid="reorder-down-{i}"
							aria-label="Move down"
							class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted disabled:opacity-30"
							disabled={pos === order.length - 1}
							onclick={() => move(pos, pos + 1)}
						>
							&darr;
						</button>
					</li>
				{/each}
			</ol>
		{/if}
		{#if drag.dragging && drag.ghost && drag.ghost.w > 0 && drag.from !== null && defn}
			{@const dragCol = defn.columns[order[drag.from]]}
			<div
				use:portal
				data-testid="reorder-drag-ghost"
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
				data-testid="reorder-reset"
				class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
				disabled={!customized}
				title="Show the columns in their computation order again"
				onclick={reset}
			>
				Reset to computation order
			</button>
			<Dialog.Close
				data-testid="reorder-done"
				class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
			>
				Done
			</Dialog.Close>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
