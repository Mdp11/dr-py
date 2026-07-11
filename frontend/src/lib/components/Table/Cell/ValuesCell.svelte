<script lang="ts">
	import type { TableCell } from '$lib/api/types';

	let { cell }: { cell: Extract<TableCell, { kind: 'values' }> } = $props();

	const text = $derived(cell.values.map((v) => String(v ?? '')).join(', '));
</script>

<span class:text-muted-foreground={!cell.present}>
	{text}{#if cell.truncated}<span class="text-[10px] text-muted-foreground/70"> …</span>{/if}
</span>
