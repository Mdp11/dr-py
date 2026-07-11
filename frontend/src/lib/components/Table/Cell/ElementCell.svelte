<script lang="ts">
	import type { TableCell } from '$lib/api/types';
	import { select } from '$lib/state';

	let { cell }: { cell: Extract<TableCell, { kind: 'element' }> } = $props();
</script>

{#if cell.item}
	<button
		type="button"
		class="rounded bg-card px-1.5 py-0.5 text-left transition-colors hover:bg-muted"
		title={cell.item.type_name}
		onclick={() => cell.item && select({ kind: 'element', id: cell.item.id })}
	>
		{cell.item.display_name}
	</button>
{:else}
	<span class="text-muted-foreground/50">—</span>
{/if}
