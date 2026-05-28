<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import { Separator } from '$lib/components/ui/separator';
	import { getSelection, getWorkingModel } from '$lib/state';
	import PropertyForm from './Inspector/PropertyForm.svelte';

	const selection = $derived(getSelection());
	const working = $derived(getWorkingModel());

	const entity = $derived.by((): Element | Relationship | null => {
		if (selection === null) return null;
		if (selection.kind === 'element') {
			return working.elements.find((e) => e.id === selection.id) ?? null;
		}
		return working.relationships.find((r) => r.id === selection.id) ?? null;
	});
</script>

<aside
	class="flex h-full flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950 text-sm text-zinc-300"
>
	<section class="flex-1 overflow-auto px-3 py-2">
		<h2 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
			Properties
		</h2>
		{#if selection === null}
			<p class="text-xs text-zinc-500">No selection.</p>
		{:else if entity === null}
			<p class="text-xs text-zinc-500">Selection no longer exists.</p>
		{:else}
			<PropertyForm {entity} kind={selection.kind} />
		{/if}
	</section>
	<Separator class="bg-zinc-800" />
	<section class="px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
			Incoming relationships
		</h2>
		<p class="font-mono text-xs text-zinc-500">—</p>
	</section>
	<Separator class="bg-zinc-800" />
	<section class="px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
			Outgoing relationships
		</h2>
		<p class="font-mono text-xs text-zinc-500">—</p>
	</section>
</aside>
