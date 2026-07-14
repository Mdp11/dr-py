<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import { Separator } from '$lib/components/ui/separator';
	import {
		ensureElement,
		getCachedElements,
		getCachedRelationships,
		getMissingElementIds,
		getSelection,
		isTempId
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

	// An uncached element selection is LOADING until the cache-or-fetch settles:
	// only a confirmed miss (404 / deleted — tracked in the missing-ids set) or
	// an uncached temp id (the server never heard of it) is truly "not found".
	const loading = $derived(
		entity === null &&
			selection?.kind === 'element' &&
			!getMissingElementIds().has(selection.id) &&
			!isTempId(selection.id)
	);
</script>

<aside
	data-testid="inspector"
	class="flex h-full flex-col overflow-hidden border-l border-border bg-background text-sm text-foreground/80"
>
	{#if selection === null}
		<section
			class="flex flex-1 flex-col items-center justify-center gap-1 overflow-auto px-3 py-6 text-center"
		>
			<p class="font-display text-base font-light text-muted-foreground">No element selected</p>
			<p class="text-xs text-muted-foreground/70">Select an entity from the tree to inspect it.</p>
		</section>
	{:else if loading}
		<section
			data-testid="inspector-loading"
			class="flex flex-1 flex-col gap-3 overflow-hidden px-3 py-3"
			aria-busy="true"
		>
			<span class="h-3 w-20 animate-pulse rounded bg-muted"></span>
			<span class="h-6 w-40 animate-pulse rounded bg-muted"></span>
			<span class="h-4 w-full animate-pulse rounded bg-muted"></span>
			<span class="h-4 w-3/4 animate-pulse rounded bg-muted"></span>
			<span class="h-4 w-5/6 animate-pulse rounded bg-muted"></span>
		</section>
	{:else if entity === null}
		<section
			class="flex flex-1 flex-col items-center justify-center gap-1 overflow-auto px-3 py-6 text-center"
		>
			<p class="font-display text-base font-light text-muted-foreground">Selection not found</p>
			<p class="text-xs text-muted-foreground/70">This selection no longer exists.</p>
		</section>
	{:else}
		<div class="flex-1 overflow-auto">
			<section class="px-3 py-2">
				<div class="mb-2 flex items-center justify-between gap-2">
					<h2 class="microlabel">Properties</h2>
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
				<Separator class="bg-border" />
				<section class="px-3 py-2">
					<h2 class="mb-2 microlabel">Relationships</h2>
					<RelationshipsList elementId={selection.id} />
					<div class="mt-3">
						<NewRelationshipPicker sourceId={selection.id} />
					</div>
				</section>
			{/if}
		</div>
	{/if}
</aside>
