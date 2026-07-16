<script lang="ts">
	// Multi-element navigation cell. The row is sized to its tallest cell, so
	// each element renders on its own line: a leading count badge on the first
	// line (when there's more than one), then one chip per element, one per
	// line; a truncation marker gets its own final line. Hover shows the full
	// name list via `title`.
	import type { TableCell } from '$lib/api/types';
	import { select } from '$lib/state';
	import { getStagedNameOverride } from '$lib/state/model.svelte';

	let { cell }: { cell: Extract<TableCell, { kind: 'elements' }> } = $props();

	// Staged overlay: an uncommitted rename wins over the page's display_name
	// (same rule as ElementCell/ValueCell), chip and tooltip alike.
	function nameFor(item: { id: string; display_name: string }): string {
		return getStagedNameOverride(item.id) ?? item.display_name;
	}

	const tooltip = $derived(
		cell.items.map((i) => nameFor(i)).join(', ') +
			(cell.truncated ? ` … (${cell.total} total)` : '')
	);
</script>

<div class="flex w-full min-w-0 flex-col overflow-hidden" title={tooltip}>
	{#if cell.items.length === 0}
		<span class="flex h-7 items-center text-muted-foreground/50">—</span>
	{:else}
		{#each cell.items as item, i (item.id)}
			<span data-testid="cell-line" class="flex h-7 min-w-0 items-center gap-1 whitespace-nowrap">
				{#if i === 0 && cell.total > 1}
					<span
						data-testid="cell-count"
						class="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
						>{cell.total}</span
					>
				{/if}
				<button
					type="button"
					class="min-w-0 max-w-full shrink-0 truncate rounded bg-card px-1.5 py-0.5 transition-colors hover:bg-muted"
					title={item.type_name}
					onclick={() => select({ kind: 'element', id: item.id })}
				>
					{nameFor(item)}
				</button>
			</span>
		{/each}
		{#if cell.truncated}
			<span
				data-testid="cell-line"
				class="flex h-7 items-center text-[10px] text-muted-foreground/70"
			>
				+{cell.total - cell.items.length} more
			</span>
		{/if}
	{/if}
</div>
