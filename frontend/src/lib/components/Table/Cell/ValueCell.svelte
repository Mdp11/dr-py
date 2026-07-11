<script lang="ts">
	// Read-only render only — inline editing lands in Task 6. `tabId` is
	// accepted so the call site in TableGrid.svelte doesn't need to change
	// shape once editing is wired in; for now it's only threaded onto a data
	// attribute (kept "used" without capturing it into a closure-only
	// reference, which svelte-check otherwise flags).
	import type { TableCell } from '$lib/api/types';

	let { cell, tabId }: { cell: Extract<TableCell, { kind: 'value' }>; tabId: string } = $props();

	const text = $derived(cell.present ? String(cell.value ?? '') : '');
</script>

<span data-tab-id={tabId} class:text-muted-foreground={!cell.present}>{text}</span>
