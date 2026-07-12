<script lang="ts">
	import type { TableCell } from '$lib/api/types';
	import { select } from '$lib/state';

	let { cell }: { cell: Extract<TableCell, { kind: 'elements' }> } = $props();
</script>

<div class="flex flex-wrap items-center gap-1">
	{#each cell.items as item (item.id)}
		<button
			type="button"
			class="rounded bg-card px-1.5 py-0.5 transition-colors hover:bg-muted"
			title={item.type_name}
			onclick={() => select({ kind: 'element', id: item.id })}
		>
			{item.display_name}
		</button>
	{/each}
	{#if cell.truncated}
		<span class="text-[10px] text-muted-foreground/70">
			+{cell.total - cell.items.length} more
		</span>
	{/if}
	{#if cell.items.length === 0}
		<span class="text-muted-foreground/50">—</span>
	{/if}
</div>
