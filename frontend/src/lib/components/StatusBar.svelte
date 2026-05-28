<script lang="ts">
	import { getBaseline, getWorkingModel } from '$lib/state';

	const working = $derived(getWorkingModel());
	const baseline = $derived(getBaseline());
</script>

<footer
	class="col-span-3 flex h-6 items-center gap-3 border-t border-zinc-800 bg-zinc-950 px-3 font-mono text-xs text-zinc-400"
>
	<span>{working.elements.length} elements</span>
	<span class="text-zinc-700">·</span>
	<span>0 modified</span>
	<span class="text-zinc-700">·</span>
	<span>0 errors</span>
	<span class="text-zinc-700">·</span>
	<span>rev {baseline?.rev ?? '—'}</span>
</footer>
