<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { getMetamodel } from '$lib/state';
	import type { NavScope } from '$lib/api/types';
	import type { AnyOfCriterion, Criterion, LeafCriterion } from '$lib/search/types';
	import { newCriterion } from '$lib/search/types';
	import CriterionGroupRow from '../Sidebar/CriterionGroupRow.svelte';
	import CriterionRow from '../Sidebar/CriterionRow.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = {
		scope: NavScope;
		/** When set, only these type names are offered (hop targets). */
		allowedTypes?: string[] | null;
		/** Trigger-pill text when no type is picked (the sentence's verb supplies
		 * the rest — "Start from ⟨unsetLabel⟩" / "…to ⟨unsetLabel⟩"). */
		unsetLabel?: string;
		onChange: (next: NavScope) => void;
	};
	let { scope, allowedTypes = null, unsetLabel = 'any element', onChange }: Props = $props();

	const mm = $derived(getMetamodel());
	const typeNames = $derived(allowedTypes ?? [...(mm?.elements ?? []).map((e) => e.name)].sort());
	const checked = $derived(new SvelteSet(scope.types));
	let pickerOpen = $state(false);

	function toggleType(name: string): void {
		// Ephemeral scratch set: built, mutated, and spread into the onChange
		// payload within this call — never stored or read reactively.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const next = new Set(scope.types);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		onChange({ ...scope, types: [...next].sort() });
	}
	function setCriterion(index: number, next: Criterion): void {
		const criteria = [...(scope.criteria as Criterion[])];
		criteria[index] = next;
		onChange({ ...scope, criteria });
	}
	function removeCriterion(index: number): void {
		onChange({ ...scope, criteria: scope.criteria.filter((_, i) => i !== index) });
	}
	function addCriterion(): void {
		onChange({
			...scope,
			criteria: [...(scope.criteria as Criterion[]), newCriterion('property')]
		});
	}
	function addGroup(): void {
		onChange({
			...scope,
			criteria: [...(scope.criteria as Criterion[]), newCriterion('any_of')]
		});
	}
</script>

<div class="space-y-1.5">
	<div class="flex flex-wrap items-center gap-2">
		<StereotypePicker
			mode="filter"
			names={typeNames}
			{checked}
			onToggle={toggleType}
			onSelectAll={() => onChange({ ...scope, types: [...typeNames] })}
			onDeselectAll={() => onChange({ ...scope, types: [] })}
			open={pickerOpen}
			onOpenChange={(v) => (pickerOpen = v)}
			searchPlaceholder="Filter types…"
		>
			{#snippet trigger()}
				<span
					class="cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[11px]
						{scope.types.length === 0
						? 'border-dashed border-input text-muted-foreground/70'
						: 'border-input bg-card'}"
				>
					{scope.types.length === 0 ? unsetLabel : scope.types.join(', ')}
				</span>
			{/snippet}
		</StereotypePicker>
		<button
			type="button"
			class="text-xs text-info/90 transition-colors hover:text-info"
			onclick={addCriterion}>+ condition</button
		>
		<button
			type="button"
			class="text-xs text-info/90 transition-colors hover:text-info"
			onclick={addGroup}>+ OR group</button
		>
	</div>
	{#each scope.criteria as criterion, i (i)}
		{#if (criterion as Criterion).type === 'any_of'}
			<CriterionGroupRow
				criterion={criterion as AnyOfCriterion}
				index={i}
				target="element"
				onChange={setCriterion}
				onRemove={removeCriterion}
			/>
		{:else}
			<CriterionRow
				criterion={criterion as LeafCriterion}
				index={i}
				target="element"
				onChange={setCriterion}
				onRemove={removeCriterion}
			/>
		{/if}
	{/each}
</div>
