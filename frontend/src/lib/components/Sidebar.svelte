<script lang="ts">
	import { Separator } from '$lib/components/ui/separator';
	import { getBaseline, getMetamodel } from '$lib/state';
	import ContainmentTree from './Sidebar/ContainmentTree.svelte';
	import Search from './Sidebar/Search.svelte';

	const mm = $derived(getMetamodel());
	const baseline = $derived(getBaseline());
</script>

<aside
	class="flex h-full flex-col overflow-hidden border-r border-zinc-800 bg-zinc-950 text-sm text-zinc-300"
>
	{#if mm === null || baseline === null}
		<section class="px-3 py-3">
			<p class="text-xs text-zinc-500">Load a metamodel and model to begin.</p>
		</section>
	{:else}
		<Search />
		<Separator class="bg-zinc-800" />
		<ContainmentTree />
	{/if}
</aside>
