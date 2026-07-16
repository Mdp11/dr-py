<script lang="ts">
	import type { TableCell } from '$lib/api/types';
	import { select } from '$lib/state';
	import { getStagedNameOverride } from '$lib/state/model.svelte';

	let { cell }: { cell: Extract<TableCell, { kind: 'element' }> } = $props();

	// Staged overlay (ValueCell's rule, applied to the display name): an
	// uncommitted rename must win over the last-loaded page's display_name so
	// the scope column reflects the edit as immediately as the value cells do.
	const label = $derived(
		cell.item ? (getStagedNameOverride(cell.item.id) ?? cell.item.display_name) : ''
	);
</script>

{#if cell.item}
	<button
		type="button"
		class="rounded bg-card px-1.5 py-0.5 text-left transition-colors hover:bg-muted"
		title={cell.item.type_name}
		onclick={() => cell.item && select({ kind: 'element', id: cell.item.id })}
	>
		{label}
	</button>
{:else}
	<span class="text-muted-foreground/50">—</span>
{/if}
