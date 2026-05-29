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
		getDraftQuery,
		getSearchCriteria,
		getSearchDialogOpen,
		getSearchTarget,
		getWorkingModel,
		removeSearchCriterion,
		setSearchDialogOpen,
		setSearchTarget,
		updateSearchCriterion
	} from '$lib/state';
	import { isValidRegex, runQuery } from '$lib/search/evaluate';
	import { CRITERION_LABELS, type Criterion } from '$lib/search/types';
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

	function onSearch(): void {
		if (hasInvalidRegex) return;
		const query = getDraftQuery();
		const results = runQuery(query, getWorkingModel());
		commitSearchResults(results, query.target);
		setSearchDialogOpen(false);
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Advanced search</Dialog.Title>
			<Dialog.Description>
				Search for {target === 'element' ? 'elements' : 'relationships'} matching all criteria.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex items-center gap-2">
			<span class="text-xs text-zinc-400">Search for:</span>
			<div class="inline-flex overflow-hidden rounded border border-zinc-700">
				<button
					type="button"
					class="px-3 py-1 text-xs {target === 'element'
						? 'bg-indigo-600 text-white'
						: 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}"
					onclick={() => setSearchTarget('element')}
				>
					Elements
				</button>
				<button
					type="button"
					class="px-3 py-1 text-xs {target === 'relationship'
						? 'bg-indigo-600 text-white'
						: 'bg-zinc-900 text-zinc-300 hover:bg-zinc-800'}"
					onclick={() => setSearchTarget('relationship')}
				>
					Relationships
				</button>
			</div>
		</div>

		<div class="flex max-h-[55vh] flex-col gap-2 overflow-y-auto pr-1">
			{#if criteria.length === 0}
				<p class="text-xs text-zinc-500">
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
				class="inline-flex w-fit items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
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
				class="bg-indigo-600 text-white hover:bg-indigo-500"
				onclick={onSearch}
				disabled={hasInvalidRegex}
			>
				Search
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
