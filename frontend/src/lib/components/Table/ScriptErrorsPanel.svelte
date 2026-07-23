<script lang="ts">
	// The script-error recap panel: every failing script cell in the WHOLE
	// table, each entry a jump to its position in the grid.
	//
	// This exists because the grid is virtualized — the client only ever holds
	// a window of rows, so a user whose table has failing cells has no way to
	// find them by scrolling. The list comes from the backend's whole-table
	// recap (`POST /tables/script-errors`), which is the only complete answer.
	//
	// Deliberately a dumb presenter: it owns no fetching and no open/closed
	// state (TableView's badge does), so it can be mounted from anywhere the
	// recap is available.
	import type { ScriptErrorsRecap } from '$lib/api/types';

	let {
		recap,
		onJump
	}: {
		recap: ScriptErrorsRecap;
		onJump: (rowIndex: number, columnIndex: number) => void;
	} = $props();

	// The recap is capped server-side: `errors` may be shorter than
	// `total_errors`, and saying so is the difference between "6 failures" and
	// "6 of 4021 failures".
	const shown = $derived(recap.errors.length);
</script>

<div
	data-testid="script-errors-panel"
	class="absolute top-full left-0 z-20 mt-1 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded border border-destructive/40 bg-card shadow-lg"
>
	<div
		class="flex items-baseline gap-1.5 border-b border-border bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
	>
		<span class="font-medium">
			{recap.total_errors} script error{recap.total_errors === 1 ? '' : 's'}
		</span>
		{#if recap.truncated}
			<span class="text-destructive/70">(showing first {shown})</span>
		{/if}
	</div>
	<ul class="max-h-64 overflow-y-auto">
		{#each recap.errors as err, i (i)}
			<li>
				<button
					type="button"
					data-testid="script-error-entry"
					class="flex w-full flex-col items-start gap-0.5 border-b border-border/40 px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
					title={err.message}
					onclick={() => onJump(err.row_index, err.column_index)}
				>
					<span class="flex w-full items-baseline gap-1.5">
						<!-- The row's own label, falling back to its element id and then
						     to the 1-based grid position — a chains row source can have
						     neither, and "row 412" is still a usable address. -->
						<span class="truncate font-medium text-foreground">
							{err.row_label ?? err.row_element_id ?? `row ${err.row_index + 1}`}
						</span>
						<span class="shrink-0 text-muted-foreground/70">{err.column_label}</span>
					</span>
					<span class="w-full truncate text-destructive">{err.message}</span>
				</button>
			</li>
		{/each}
	</ul>
</div>
