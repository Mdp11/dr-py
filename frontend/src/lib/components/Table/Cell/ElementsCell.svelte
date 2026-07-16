<script lang="ts">
	// Multi-element navigation cell. The row is a fixed-height, overflow-hidden
	// strip, so the chips must NOT wrap (a wrapped second line is vertically
	// clipped into unreadable half-rows). Everything stays on one line: a
	// leading count badge — always visible even when the chip tail is clipped —
	// then one chip per element; hover shows the full name list via `title`.
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

<div
	class="flex w-full min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap"
	title={tooltip}
>
	{#if cell.items.length === 0}
		<span class="text-muted-foreground/50">—</span>
	{:else}
		{#if cell.total > 1}
			<span
				data-testid="cell-count"
				class="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
			>
				{cell.total}
			</span>
		{/if}
		{#each cell.items as item (item.id)}
			<button
				type="button"
				class="max-w-40 shrink-0 truncate rounded bg-card px-1.5 py-0.5 transition-colors hover:bg-muted"
				title={item.type_name}
				onclick={() => select({ kind: 'element', id: item.id })}
			>
				{nameFor(item)}
			</button>
		{/each}
		{#if cell.truncated}
			<span class="shrink-0 text-[10px] text-muted-foreground/70">
				+{cell.total - cell.items.length} more
			</span>
		{/if}
	{/if}
</div>
