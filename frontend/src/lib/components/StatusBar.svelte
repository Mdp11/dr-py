<script lang="ts">
	import {
		getChangesBadgeTotal,
		getFilename,
		getIssueCounts,
		getModelSummary,
		getTypeFilter,
		hasPendingOps
	} from '$lib/state';

	const summary = $derived(getModelSummary());
	const filename = $derived(getFilename());
	const totalChanges = $derived(getChangesBadgeTotal());
	const pending = $derived(hasPendingOps());

	// null = not validated yet; render zeros, matching the pre-validation UX.
	const issueCounts = $derived(getIssueCounts());
	const errorCount = $derived(issueCounts?.error ?? 0);
	const warningCount = $derived(issueCounts?.warning ?? 0);

	const typeFilter = $derived(getTypeFilter());
	const totalElements = $derived(summary?.element_count ?? 0);
	// shown/total now comes from the summary's per-type counts (the client no
	// longer holds the whole model to count it directly)
	const shownCount = $derived.by(() => {
		if (summary === null) return 0;
		let n = 0;
		for (const [typeName, count] of Object.entries(summary.elements_by_type)) {
			if (typeFilter.has(typeName)) n += count;
		}
		return n;
	});
</script>

<footer
	class="col-span-5 flex h-6 items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-3 font-mono text-xs text-zinc-400"
>
	<span>Showing {shownCount}/{totalElements} elements</span>
	<span class="text-zinc-700">·</span>
	<span>{totalChanges} unsaved</span>
	{#if pending}
		<span class="text-amber-400" title="Local edits are being sent to the backend">syncing…</span>
	{/if}
	<span class="text-zinc-700">·</span>
	<span class={errorCount > 0 ? 'text-red-400' : ''}>
		{errorCount}
		{errorCount === 1 ? 'error' : 'errors'}
	</span>
	<span class="text-zinc-700">·</span>
	<span class={warningCount > 0 ? 'text-amber-400' : ''}>
		{warningCount}
		{warningCount === 1 ? 'warning' : 'warnings'}
	</span>
	<span class="text-zinc-700">·</span>
	<span class="truncate">{filename ?? 'unsaved'}</span>
</footer>
