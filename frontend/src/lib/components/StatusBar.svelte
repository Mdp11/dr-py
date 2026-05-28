<script lang="ts">
	import { getBaseline, getDiff, getWorkingModel } from '$lib/state';

	const working = $derived(getWorkingModel());
	const baseline = $derived(getBaseline());
	const diff = $derived(getDiff());
	const totalChanges = $derived(
		diff.counts.added + diff.counts.modified + diff.counts.deleted
	);
</script>

<footer
	class="col-span-3 flex h-6 items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-3 font-mono text-xs text-zinc-400"
>
	<span>{working.elements.length} elements</span>
	<span class="text-zinc-700">·</span>
	<span>{totalChanges} unsaved</span>
	<span class="text-zinc-700">·</span>
	<span>0 errors</span>
	<span class="text-zinc-700">·</span>
	<span>rev {baseline?.rev ?? '—'}</span>
</footer>
