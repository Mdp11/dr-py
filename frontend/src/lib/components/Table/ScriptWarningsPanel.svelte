<script lang="ts">
	// The script-warnings recap: every non-fatal degradation the last table
	// evaluation reported, one readable line each.
	//
	// It exists because these are WHOLE-EVALUATION facts with no cell to
	// attach to — a pruned chain, a sort that fell back to build order — so
	// unlike ScriptErrorsPanel there is nothing to fetch, no loading phase,
	// and no jump target. A dumb presenter: it owns no state, so TableView's
	// badge keeps the open/closed decision.
	import type { ScriptWarning } from '$lib/api/types';
	import { formatScriptWarning } from '$lib/script/warnings';

	let {
		id,
		warnings
	}: {
		/** DOM id, so the badge that opens this can point `aria-controls` at it. */
		id: string;
		warnings: ScriptWarning[];
	} = $props();
</script>

<!-- NON-MODAL: it names itself and Escape dismisses it (handled by the wrapper
     in TableView, where the badge's keydown lands too), but it does not trap
     focus — the grid behind it stays usable. -->
<div
	{id}
	data-testid="script-warnings-panel"
	role="dialog"
	aria-label="Script warnings in this table"
	class="absolute top-full left-0 z-20 mt-1 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded border border-warning/40 bg-card shadow-lg"
>
	<ul class="max-h-64 overflow-y-auto">
		{#each warnings as warning, i (i)}
			<li
				data-testid="script-warning-entry"
				class="border-b border-border/40 px-2 py-1.5 text-xs text-foreground last:border-b-0"
			>
				{formatScriptWarning(warning)}
			</li>
		{/each}
	</ul>
</div>
