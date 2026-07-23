<script lang="ts">
	// The script-error recap panel: every failing script cell in the WHOLE
	// table, each entry a jump to its position in the grid.
	//
	// This exists because the grid is virtualized — the client only ever holds
	// a window of rows, so a user whose table has failing cells has no way to
	// find them by scrolling. The list comes from the backend's whole-table
	// recap (`POST /tables/script-errors`), which is the only complete answer.
	//
	// That recap is fetched ON DEMAND (the badge click opens this panel AND
	// starts the fetch), so this panel also renders the three non-list outcomes:
	// still checking, checked and clean, and could-not-check. A user who asked
	// must always get an answer — showing nothing would read as "no errors" for
	// a check that never completed.
	//
	// Deliberately a dumb presenter: it owns no fetching and no open/closed
	// state (TableView's badge does), so it can be mounted from anywhere the
	// recap is available.
	import type { ScriptErrorsRecap } from '$lib/api/types';

	let {
		id,
		recap,
		phase,
		onJump
	}: {
		/** DOM id, so the badge that opens this can point `aria-controls` at it. */
		id: string;
		/** `null` until the fetch the badge kicked off has landed (and again if
		 * it failed, or if the page state moved under it). */
		recap: ScriptErrorsRecap | null;
		phase: 'idle' | 'loading' | 'done' | 'error';
		onJump: (rowIndex: number, columnIndex: number) => void;
	} = $props();

	// The recap is capped server-side: `errors` may be shorter than
	// `total_errors`, and saying so is the difference between "6 failures" and
	// "6 of 4021 failures".
	const shown = $derived(recap?.errors.length ?? 0);
	const hasErrors = $derived((recap?.total_errors ?? 0) > 0);
</script>

<!-- A NON-MODAL dialog: it names itself and Escape dismisses it (handled by the
     wrapper in TableView, where the badge's keydown lands too), but it does not
     trap focus — the grid behind it stays usable, which is the point of jumping
     from it. The destructive border is worn ONLY when there really are errors:
     until the recap lands we do not know that there are any. -->
<div
	{id}
	data-testid="script-errors-panel"
	role="dialog"
	aria-label="Script errors in this table"
	class="absolute top-full left-0 z-20 mt-1 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded border bg-card shadow-lg {hasErrors
		? 'border-destructive/40'
		: 'border-border'}"
>
	{#if recap && hasErrors}
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
	{:else}
		<!-- Every non-list outcome. `aria-live` because the panel opens on the very
		     click that starts the fetch: this text changes underneath the user. -->
		<p class="px-2 py-1.5 text-xs text-muted-foreground" aria-live="polite">
			{#if phase === 'loading'}
				Checking the whole table for script errors…
			{:else if phase === 'error'}
				Could not check this table for script errors. Try again.
			{:else if recap}
				No script errors in this table.
			{:else}
				Not checked yet.
			{/if}
		</p>
	{/if}
</div>
