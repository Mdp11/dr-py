<script lang="ts">
	import {
		getBaseline,
		getDiff,
		getIssues,
		getWorkingModel,
		indexIssues
	} from '$lib/state';

	const working = $derived(getWorkingModel());
	const baseline = $derived(getBaseline());
	const diff = $derived(getDiff());
	const totalChanges = $derived(
		diff.counts.added + diff.counts.modified + diff.counts.deleted
	);
	const issueIndex = $derived(indexIssues(getIssues()));
	const errorCount = $derived(issueIndex.errorIds.size);
	const warningCount = $derived(issueIndex.warningIds.size);
</script>

<footer
	class="col-span-3 flex h-6 items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-3 font-mono text-xs text-zinc-400"
>
	<span>{working.elements.length} elements</span>
	<span class="text-zinc-700">·</span>
	<span>{totalChanges} unsaved</span>
	<span class="text-zinc-700">·</span>
	<span class={errorCount > 0 ? 'text-red-400' : ''}>
		{errorCount} {errorCount === 1 ? 'error' : 'errors'}
	</span>
	<span class="text-zinc-700">·</span>
	<span class={warningCount > 0 ? 'text-amber-400' : ''}>
		{warningCount} {warningCount === 1 ? 'warning' : 'warnings'}
	</span>
	<span class="text-zinc-700">·</span>
	<span>rev {baseline?.rev ?? '—'}</span>
</footer>
