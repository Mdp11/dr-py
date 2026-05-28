<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import { Separator } from '$lib/components/ui/separator';
	import { getSelection, getWorkingModel } from '$lib/state';
	import NewRelationshipPicker from './Inspector/NewRelationshipPicker.svelte';
	import PropertyForm from './Inspector/PropertyForm.svelte';
	import RelationshipsList from './Inspector/RelationshipsList.svelte';

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
	data-testid="inspector"
	class="flex h-full flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950 text-sm text-zinc-300"
>
	{#if selection === null}
		<section class="flex-1 overflow-auto px-3 py-2">
			<h2 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
				Properties
			</h2>
			<p class="text-xs text-zinc-500">Select an entity from the tree…</p>
		</section>
	{:else if entity === null}
		<section class="flex-1 overflow-auto px-3 py-2">
			<h2 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
				Properties
			</h2>
			<p class="text-xs text-zinc-500">Selection no longer exists.</p>
		</section>
	{:else}
		<div class="flex-1 overflow-auto">
			<section class="px-3 py-2">
				<h2 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
					Properties
				</h2>
				<PropertyForm {entity} kind={selection.kind} />
			</section>
			{#if selection.kind === 'element'}
				<Separator class="bg-zinc-800" />
				<section class="px-3 py-2">
					<h2 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
						Relationships
					</h2>
					<RelationshipsList elementId={entity.id} />
					<div class="mt-3">
						<NewRelationshipPicker sourceId={entity.id} />
					</div>
				</section>
			{/if}
		</div>
	{/if}
</aside>
