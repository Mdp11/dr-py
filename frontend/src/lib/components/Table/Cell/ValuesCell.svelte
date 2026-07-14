<script lang="ts">
	// Multi-value (read-only) property cell. The row is a fixed-height,
	// overflow-hidden strip, so everything must stay on ONE line: a leading
	// count badge (always visible, so a clipped tail can't hide how many values
	// there are), then each value as its own chip — visually separated instead
	// of a comma-joined run-on string. The full list lives in the container's
	// `title` for hover.
	import type { TableCell } from '$lib/api/types';

	let { cell }: { cell: Extract<TableCell, { kind: 'values' }> } = $props();

	const texts = $derived(cell.values.map((v) => String(v ?? '')));
	const tooltip = $derived(texts.join(', ') + (cell.truncated ? ` … (${cell.total} total)` : ''));
</script>

<div
	class="flex w-full min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap"
	title={tooltip}
>
	{#if cell.values.length === 0}
		<span class="text-muted-foreground/50">—</span>
	{:else if cell.values.length === 1}
		<span class="truncate" class:text-muted-foreground={!cell.present}>{texts[0]}</span>
	{:else}
		<span
			data-testid="cell-count"
			class="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
		>
			{cell.total}
		</span>
		{#each texts as text, i (i)}
			<span
				class="max-w-40 shrink-0 truncate rounded bg-muted/50 px-1.5 py-0.5"
				class:text-muted-foreground={!cell.present}
			>
				{text}
			</span>
		{/each}
		{#if cell.truncated}
			<span class="shrink-0 text-[10px] text-muted-foreground/70">…</span>
		{/if}
	{/if}
</div>
