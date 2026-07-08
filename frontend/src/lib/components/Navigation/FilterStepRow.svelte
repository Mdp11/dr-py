<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import type { NavFilterStep } from '$lib/api/types';
	import type { Criterion } from '$lib/search/types';
	import { newCriterion } from '$lib/search/types';
	import CriterionRow from '../Sidebar/CriterionRow.svelte';

	type Props = {
		step: NavFilterStep;
		index: number;
		/** Properties reachable at this point in the chain (union over the
		 * currently-reached types); scopes the criterion property picker. */
		propertyNames: string[];
		onChange: (index: number, next: NavFilterStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, propertyNames, onChange, onRemove }: Props = $props();

	function setCriterion(i: number, next: Criterion): void {
		const criteria = [...(step.criteria as Criterion[])];
		criteria[i] = next;
		onChange(index, { ...step, criteria });
	}
	function removeCriterion(i: number): void {
		onChange(index, { ...step, criteria: step.criteria.filter((_, j) => j !== i) });
	}
	function addCriterion(): void {
		onChange(index, {
			...step,
			criteria: [...(step.criteria as Criterion[]), newCriterion('property')]
		});
	}
</script>

<div
	class="space-y-1.5 rounded border border-zinc-800 bg-zinc-900/40 p-2"
	data-testid="filter-step"
>
	<div class="flex items-center gap-2 text-xs">
		<span class="text-zinc-500">Step {index + 1}</span>
		<span class="text-zinc-400">Filter</span>
		<button
			type="button"
			aria-label="Remove step"
			class="ml-auto text-zinc-500 hover:text-red-400"
			onclick={() => onRemove(index)}
		>
			<Trash2 class="size-3.5" />
		</button>
	</div>
	{#each step.criteria as criterion, i (i)}
		<CriterionRow
			criterion={criterion as Criterion}
			index={i}
			target="element"
			{propertyNames}
			onChange={setCriterion}
			onRemove={removeCriterion}
		/>
	{/each}
	<button type="button" class="text-xs text-sky-500 hover:text-sky-300" onclick={addCriterion}
		>+ condition</button
	>
</div>
