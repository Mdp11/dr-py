<script lang="ts">
	// Script-column evaluation error: a snippet's value()/step() raised while
	// building this cell (core/script/embed.py's "degraded, not failed" stance
	// — the row still renders, just with this cell in place of a value). The
	// traceback (when the backend includes one) is the hover detail; otherwise
	// the message itself repeats as the tooltip.
	import type { TableCell } from '$lib/api/types';

	let { cell }: { cell: Extract<TableCell, { kind: 'error' }> } = $props();
</script>

<div
	data-testid="error-cell"
	class="flex h-7 max-w-full min-w-0 items-center gap-1 truncate text-destructive"
	title={cell.traceback ?? cell.message}
>
	<span aria-hidden="true">⚠</span>
	<span class="truncate">{cell.message}</span>
</div>
