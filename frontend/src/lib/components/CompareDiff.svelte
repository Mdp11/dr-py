<script lang="ts">
	import type { Diff } from '$lib/state/diff';
	import CompareEntityCard from './CompareEntityCard.svelte';

	type Props = { diff: Diff; unchangedHidden: number };
	let { diff, unchangedHidden }: Props = $props();

	let mode: 'split' | 'unified' = $state('split');
</script>

<div>
	<div
		class="flex items-center gap-3 rounded-t-lg border border-input bg-muted/40 px-3 py-2 text-xs"
	>
		<span class="text-success">+{diff.counts.added} added</span>
		<span class="text-warning">~{diff.counts.modified} modified</span>
		<span class="text-destructive">−{diff.counts.deleted} deleted</span>
		<span class="text-muted-foreground/70">{unchangedHidden} unchanged hidden</span>
		<div class="ml-auto flex overflow-hidden rounded border border-input">
			<button
				type="button"
				class={`px-3 py-1 transition-colors ${mode === 'split' ? 'bg-primary text-primary-foreground' : 'text-foreground/80 hover:bg-muted'}`}
				onclick={() => (mode = 'split')}>Split</button
			>
			<button
				type="button"
				class={`px-3 py-1 transition-colors ${mode === 'unified' ? 'bg-primary text-primary-foreground' : 'text-foreground/80 hover:bg-muted'}`}
				onclick={() => (mode = 'unified')}>Unified</button
			>
		</div>
	</div>

	<div class="rounded-b-lg border border-t-0 border-input">
		{#if diff.elements.length > 0}
			<div class="microlabel px-3 pt-2">Elements</div>
			{#each diff.elements as d (d.id)}
				<CompareEntityCard diff={d} {mode} />
			{/each}
		{/if}
		{#if diff.relationships.length > 0}
			<div class="microlabel px-3 pt-2">Relationships</div>
			{#each diff.relationships as d (d.id)}
				<CompareEntityCard diff={d} {mode} />
			{/each}
		{/if}
		{#if diff.elements.length === 0 && diff.relationships.length === 0}
			<div class="px-3 py-6 text-center text-sm text-muted-foreground">No differences.</div>
		{/if}
	</div>
</div>
