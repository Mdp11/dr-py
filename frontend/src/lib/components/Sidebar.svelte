<script lang="ts">
	import { Separator } from '$lib/components/ui/separator';
	import { getMetamodel, getModelSummary } from '$lib/state';
	import ArtifactsSection from './Sidebar/ArtifactsSection.svelte';
	import ContainmentTree from './Sidebar/ContainmentTree.svelte';
	import Search from './Sidebar/Search.svelte';
	import ViewSelector from './Sidebar/ViewSelector.svelte';

	const mm = $derived(getMetamodel());
	const summary = $derived(getModelSummary());
</script>

<aside
	class="flex h-full flex-col overflow-hidden border-r border-border bg-background text-sm text-foreground/80"
>
	{#if mm === null || summary === null}
		<section class="flex flex-col items-center gap-1 px-3 py-6 text-center">
			<p class="font-display text-base font-light text-muted-foreground">Nothing loaded</p>
			<p class="text-xs text-muted-foreground/70">Load a metamodel and model to begin.</p>
		</section>
	{:else}
		<Search />
		<Separator class="bg-border" />
		<ViewSelector />
		<ArtifactsSection />
		<ContainmentTree />
	{/if}
</aside>
