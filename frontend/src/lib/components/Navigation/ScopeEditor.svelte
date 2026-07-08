<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { getMetamodel } from '$lib/state';
	import type { NavScope } from '$lib/api/types';
	import type { Criterion } from '$lib/search/types';
	import { newCriterion } from '$lib/search/types';
	import CriterionRow from '../Sidebar/CriterionRow.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';

	type Props = {
		scope: NavScope;
		/** When set, only these type names are offered (hop targets). */
		allowedTypes?: string[] | null;
		label: string;
		onChange: (next: NavScope) => void;
	};
	let { scope, allowedTypes = null, label, onChange }: Props = $props();

	const mm = $derived(getMetamodel());
	const typeNames = $derived(allowedTypes ?? [...(mm?.elements ?? []).map((e) => e.name)].sort());
	const checked = $derived(new SvelteSet(scope.types));
	let pickerOpen = $state(false);

	function toggleType(name: string): void {
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
</script>

<div class="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-2">
	<div class="flex items-center gap-2">
		<span class="text-xs font-medium text-zinc-400">{label}</span>
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
				<span class="cursor-pointer rounded border border-zinc-700 px-1.5 py-0.5 text-xs">
					{scope.types.length === 0 ? 'Any type' : scope.types.join(', ')}
				</span>
			{/snippet}
		</StereotypePicker>
	</div>
	{#each scope.criteria as criterion, i (i)}
		<CriterionRow
			criterion={criterion as Criterion}
			index={i}
			target="element"
			onChange={setCriterion}
			onRemove={removeCriterion}
		/>
	{/each}
	<button type="button" class="text-xs text-sky-500 hover:text-sky-300" onclick={addCriterion}
		>+ condition</button
	>
</div>
