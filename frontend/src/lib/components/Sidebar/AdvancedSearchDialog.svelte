<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Button } from '$lib/components/ui/button';
	import {
		addSearchCriterion,
		availableCriterionTypes,
		clearSearchCriteria,
		commitSearchResults,
		getCachedElements,
		getDraftQuery,
		getSearchCriteria,
		getSearchDialogOpen,
		getSearchTarget,
		removeSearchCriterion,
		seedElements,
		seedRelationships,
		setSearchDialogOpen,
		setSearchTarget,
		updateSearchCriterion
	} from '$lib/state';
	import { getElementsBatch, READ_PAGE_LIMIT, searchModel } from '$lib/api/model-read';
	import { isValidRegex } from '$lib/search/evaluate';
	import { CRITERION_LABELS, type Criterion, type SearchResultItem } from '$lib/search/types';
	import CriterionRow from './CriterionRow.svelte';

	// Writable $derived mirror of the global search-dialog store, matching the
	// pattern +page.svelte uses for DiffDrawer: it tracks the store, Dialog's
	// `bind:open` can override it locally, and the effect pushes that override
	// back to the store.
	let open = $derived(getSearchDialogOpen());

	$effect(() => {
		if (open !== getSearchDialogOpen()) setSearchDialogOpen(open);
	});

	const target = $derived(getSearchTarget());
	const criteria = $derived(getSearchCriteria());

	const hasInvalidRegex = $derived(
		criteria.some(
			(c) =>
				(c.type === 'property' && c.op === 'matches' && !isValidRegex(c.value)) ||
				(c.type === 'name_id' && c.op === 'matches' && !isValidRegex(c.value))
		)
	);

	function onOpenChange(next: boolean): void {
		open = next;
	}

	let searching = $state(false);

	// Server-side evaluation over the WHOLE model (POST /model/search). The
	// matched entities come back hydrated and are seeded into the cache the
	// results panel renders from; `total` lets us flag when the match set was
	// capped to a single page.
	async function onSearch(): Promise<void> {
		if (hasInvalidRegex || searching) return;
		searching = true;
		try {
			const page = await searchModel(getDraftQuery());

			let results: SearchResultItem[];
			if (page.target === 'element') {
				seedElements(page.elements);
				results = page.elements.map((e) => ({ kind: 'element', id: e.id }));
			} else {
				seedRelationships(page.relationships);
				await hydrateEndpoints(page.relationships);
				results = page.relationships.map((r) => ({ kind: 'relationship', id: r.id }));
			}

			const note =
				page.total > results.length ? `showing ${results.length} of ${page.total} matches` : null;
			commitSearchResults(results, page.target, note);
			setSearchDialogOpen(false);
		} catch {
			// transport/validation failure: keep the dialog open so the user can
			// retry or amend criteria rather than committing an empty result set.
		} finally {
			searching = false;
		}
	}

	// Relationship rows label their source → target by display name, which the
	// results panel resolves from the element cache; seed any endpoint elements
	// not already cached so the labels render (best-effort — they fall back to
	// raw ids on failure).
	async function hydrateEndpoints(
		relationships: { source_id: string; target_id: string }[]
	): Promise<void> {
		const cached = getCachedElements();
		const missing = [...new Set(relationships.flatMap((r) => [r.source_id, r.target_id]))].filter(
			(id) => !cached.has(id)
		);
		try {
			for (let i = 0; i < missing.length; i += READ_PAGE_LIMIT) {
				seedElements(await getElementsBatch(missing.slice(i, i + READ_PAGE_LIMIT)));
			}
		} catch {
			// endpoint labels fall back to ids
		}
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-4xl">
		<Dialog.Header>
			<Dialog.Title>Advanced search</Dialog.Title>
			<Dialog.Description>
				Search for {target === 'element' ? 'elements' : 'relationships'} matching all criteria.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex items-center gap-2">
			<span class="text-xs text-muted-foreground">Search for:</span>
			<div class="inline-flex overflow-hidden rounded border border-input">
				<button
					type="button"
					class="px-3 py-1 text-xs {target === 'element'
						? 'bg-primary text-primary-foreground'
						: 'bg-card text-muted-foreground hover:bg-muted'}"
					onclick={() => setSearchTarget('element')}
				>
					Elements
				</button>
				<button
					type="button"
					class="px-3 py-1 text-xs {target === 'relationship'
						? 'bg-primary text-primary-foreground'
						: 'bg-card text-muted-foreground hover:bg-muted'}"
					onclick={() => setSearchTarget('relationship')}
				>
					Relationships
				</button>
			</div>
		</div>

		<div class="flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
			{#if criteria.length === 0}
				<p class="text-xs text-muted-foreground/70">
					No criteria — search will list every {target === 'element' ? 'element' : 'relationship'}.
				</p>
			{/if}
			{#each criteria as criterion, index (index)}
				<CriterionRow
					{criterion}
					{index}
					{target}
					onChange={(i: number, next: Criterion) => updateSearchCriterion(i, next)}
					onRemove={(i: number) => removeSearchCriterion(i)}
				/>
			{/each}
		</div>

		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex w-fit items-center gap-1 rounded border border-input px-2 py-1 text-xs text-foreground/90 hover:bg-muted"
			>
				<Plus class="h-3 w-3" /> Add criterion
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="w-52">
				{#each availableCriterionTypes() as t (t)}
					<DropdownMenu.Item onSelect={() => addSearchCriterion(t)}>
						{CRITERION_LABELS[t]}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => clearSearchCriteria()}>Clear</Button>
			<Button
				type="button"
				class="bg-primary text-primary-foreground hover:bg-primary/80"
				onclick={() => void onSearch()}
				disabled={hasInvalidRegex || searching}
			>
				{searching ? 'Searching…' : 'Search'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
