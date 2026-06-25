<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import { Separator } from '$lib/components/ui/separator';
	import {
		ensureElement,
		getCachedElements,
		getCachedRelationships,
		getSelection
	} from '$lib/state';
	import LockControl from './Inspector/LockControl.svelte';
	import NewRelationshipPicker from './Inspector/NewRelationshipPicker.svelte';
	import PropertyForm from './Inspector/PropertyForm.svelte';
	import RelationshipsList from './Inspector/RelationshipsList.svelte';

	const selection = $derived(getSelection());
	const elements = $derived(getCachedElements());
	const relationships = $derived(getCachedRelationships());

	// cache-or-fetch on selection change (see DetailView for the same pattern)
	$effect(() => {
		if (selection?.kind === 'element') void ensureElement(selection.id);
	});

	const entity = $derived.by((): Element | Relationship | null => {
		if (selection === null) return null;
		if (selection.kind === 'element') {
			return elements.get(selection.id) ?? null;
		}
		return relationships.get(selection.id) ?? null;
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
				<div class="mb-2 flex items-center justify-between gap-2">
					<h2 class="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
						Properties
					</h2>
					{#if selection.kind === 'element'}
						<LockControl elementId={selection.id} />
					{/if}
				</div>
				<PropertyForm {entity} kind={selection.kind} />
			</section>
			{#if selection.kind === 'element'}
				<!-- Pass the id from `selection` (stable across edits), NOT `entity.id`:
				     props are live getters, so binding to `entity.id` would make these
				     children's fetch effects depend on the `entity` derived, whose object
				     identity churns on every optimistic property edit — refetching this
				     element's relationships on every keystroke. `selection.id` only
				     changes on re-selection (mirrors GraphView's `centerId`). -->
				<Separator class="bg-zinc-800" />
				<section class="px-3 py-2">
					<h2 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
						Relationships
					</h2>
					<RelationshipsList elementId={selection.id} />
					<div class="mt-3">
						<NewRelationshipPicker sourceId={selection.id} />
					</div>
				</section>
			{/if}
		</div>
	{/if}
</aside>
