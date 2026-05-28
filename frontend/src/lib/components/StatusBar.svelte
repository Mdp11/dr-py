<script lang="ts">
	import {
		getDiff,
		getFilename,
		getIssues,
		getTypeFilter,
		getWorkingModel,
		indexIssues
	} from '$lib/state';

	const working = $derived(getWorkingModel());
	const filename = $derived(getFilename());
	const diff = $derived(getDiff());
	const totalChanges = $derived(
		diff.counts.added + diff.counts.modified + diff.counts.deleted
	);
	const issueIndex = $derived(indexIssues(getIssues()));
	const errorCount = $derived(issueIndex.errorIds.size);
	const warningCount = $derived(issueIndex.warningIds.size);

	const typeFilter = $derived(getTypeFilter());
	const shownCount = $derived(
		working.elements.reduce(
			(n, el) => (typeFilter.has(el.type_name) ? n + 1 : n),
			0
		)
	);
</script>

<footer
	class="col-span-5 flex h-6 items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-3 font-mono text-xs text-zinc-400"
>
	<span>Showing {shownCount}/{working.elements.length} elements</span>
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
	<span class="truncate">{filename ?? 'unsaved'}</span>
</footer>
