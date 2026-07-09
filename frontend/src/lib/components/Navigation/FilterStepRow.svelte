<script lang="ts">
	import type { NavFilterStep } from '$lib/api/types';
	import type { Criterion } from '$lib/search/types';
	import { newCriterion } from '$lib/search/types';
	import CriterionRow from '../Sidebar/CriterionRow.svelte';
	import ChainBadge from './ChainBadge.svelte';

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

<div class="group relative flex items-baseline gap-2.5 py-0.5" data-testid="filter-step">
	<ChainBadge value={null} />
	<div class="flex min-h-[22px] flex-1 flex-col gap-1">
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="text-zinc-400">Keep only</span>
			<button
				type="button"
				aria-label="Remove step"
				title="Remove filter"
				class="ml-auto text-zinc-500 hover:text-red-400"
				onclick={() => onRemove(index)}
			>
				✕
			</button>
		</div>
		<div class="space-y-1 pl-7">
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
	</div>
</div>
