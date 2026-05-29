<script lang="ts">
	import type { Diff } from '$lib/state/diff';
	import CompareEntityCard from './CompareEntityCard.svelte';

	type Props = { diff: Diff; unchangedHidden: number };
	let { diff, unchangedHidden }: Props = $props();

	let mode: 'split' | 'unified' = $state('split');
</script>

<div>
	<div
		class="flex items-center gap-3 rounded-t-lg border border-zinc-700 bg-zinc-800/40 px-3 py-2 text-xs"
	>
		<span class="text-green-300">+{diff.counts.added} added</span>
		<span class="text-yellow-200">~{diff.counts.modified} modified</span>
		<span class="text-red-300">−{diff.counts.deleted} deleted</span>
		<span class="text-zinc-500">{unchangedHidden} unchanged hidden</span>
		<div class="ml-auto flex overflow-hidden rounded border border-zinc-700">
			<button
				type="button"
				class={`px-3 py-1 ${mode === 'split' ? 'bg-indigo-500 text-white' : 'text-zinc-300 hover:bg-zinc-700'}`}
				onclick={() => (mode = 'split')}
			>Split</button>
			<button
				type="button"
				class={`px-3 py-1 ${mode === 'unified' ? 'bg-indigo-500 text-white' : 'text-zinc-300 hover:bg-zinc-700'}`}
				onclick={() => (mode = 'unified')}
			>Unified</button>
		</div>
	</div>

	<div class="rounded-b-lg border border-t-0 border-zinc-700">
		{#if diff.elements.length > 0}
			<div class="px-3 pt-2 text-[11px] uppercase tracking-wide text-zinc-500">Elements</div>
			{#each diff.elements as d (d.id)}
				<CompareEntityCard diff={d} {mode} />
			{/each}
		{/if}
		{#if diff.relationships.length > 0}
			<div class="px-3 pt-2 text-[11px] uppercase tracking-wide text-zinc-500">Relationships</div>
			{#each diff.relationships as d (d.id)}
				<CompareEntityCard diff={d} {mode} />
			{/each}
		{/if}
		{#if diff.elements.length === 0 && diff.relationships.length === 0}
			<div class="px-3 py-6 text-center text-sm text-zinc-500">No differences.</div>
		{/if}
	</div>
</div>
