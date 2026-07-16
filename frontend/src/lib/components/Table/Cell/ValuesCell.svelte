<script lang="ts">
	// Multi-value (read-only) property cell. The row is sized to its tallest
	// cell, so each value renders on its own line: a leading count badge on the
	// first line (always visible, so scrolling past it can't hide how many
	// values there are), then each value as its own chip on its own line —
	// visually separated instead of a comma-joined run-on string. The full
	// list lives in the container's `title` for hover.
	import type { TableCell } from '$lib/api/types';

	let { cell }: { cell: Extract<TableCell, { kind: 'values' }> } = $props();

	const texts = $derived(cell.values.map((v) => String(v ?? '')));
	const tooltip = $derived(texts.join(', ') + (cell.truncated ? ` … (${cell.total} total)` : ''));
</script>

<div class="flex w-full min-w-0 flex-col overflow-hidden" title={tooltip}>
	{#if cell.values.length === 0}
		<span class="flex h-7 items-center text-muted-foreground/50">—</span>
	{:else if cell.values.length === 1}
		<span
			data-testid="cell-line"
			class="flex h-7 items-center truncate"
			class:text-muted-foreground={!cell.present}>{texts[0]}</span
		>
		{#if cell.truncated}
			<span data-testid="cell-line" class="flex h-7 items-center text-[10px] text-muted-foreground/70"
				>…</span
			>
		{/if}
	{:else}
		{#each texts as text, i (i)}
			<span
				data-testid="cell-line"
				class="flex h-7 min-w-0 items-center gap-1 whitespace-nowrap"
			>
				{#if i === 0}
					<span
						data-testid="cell-count"
						class="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
						>{cell.total}</span
					>
				{/if}
				<span
					class="min-w-0 truncate rounded bg-muted/50 px-1.5 py-0.5"
					class:text-muted-foreground={!cell.present}>{text}</span
				>
			</span>
		{/each}
		{#if cell.truncated}
			<span data-testid="cell-line" class="flex h-7 items-center text-[10px] text-muted-foreground/70"
				>…</span
			>
		{/if}
	{/if}
</div>
