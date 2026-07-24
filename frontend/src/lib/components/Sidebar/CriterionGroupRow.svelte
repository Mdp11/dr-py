<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		CRITERION_LABELS,
		criteriaForKind,
		newCriterion,
		type AnyOfCriterion,
		type Criterion,
		type CriterionType,
		type LeafCriterion,
		type TargetKind
	} from '$lib/search/types';
	import CriterionRow from './CriterionRow.svelte';

	// An "Any of" OR group: an indented list of leaf criteria, each edited by
	// the same CriterionRow the hosts use at top level. The host contract
	// (criterion/index/target/onChange/onRemove/propertyNames) is identical to
	// CriterionRow's, so hosts only branch on `criterion.type`.
	type Props = {
		criterion: AnyOfCriterion;
		index: number;
		target: TargetKind;
		onChange: (index: number, next: Criterion) => void;
		onRemove: (index: number) => void;
		/** Forwarded to member rows (navigation filter-step property scoping). */
		propertyNames?: string[] | null;
	};
	let { criterion, index, target, onChange, onRemove, propertyNames = null }: Props = $props();

	// Members are leaves only — never offer a nested group.
	const memberTypes = $derived(criteriaForKind(target).filter((t) => t !== 'any_of'));

	function patchMembers(members: LeafCriterion[]): void {
		onChange(index, { ...criterion, criteria: members });
	}
	function setMember(i: number, next: LeafCriterion): void {
		patchMembers(criterion.criteria.map((m, j) => (j === i ? next : m)));
	}
	function removeMember(i: number): void {
		patchMembers(criterion.criteria.filter((_, j) => j !== i));
	}
	function addMember(type: CriterionType): void {
		patchMembers([...criterion.criteria, newCriterion(type) as LeafCriterion]);
	}
</script>

<div class="rounded border border-input/70 p-1.5" data-testid="criterion-group">
	<div class="flex items-center gap-1.5">
		<span class="text-xs font-medium text-muted-foreground">Any of</span>
		{#if criterion.criteria.length === 0}
			<span class="text-[11px] text-muted-foreground/60">(empty — filters nothing)</span>
		{/if}
		<button
			type="button"
			aria-label="Remove group"
			title="Remove this OR group"
			class="ml-auto text-muted-foreground/70 transition-colors hover:text-destructive"
			onclick={() => onRemove(index)}
		>
			✕
		</button>
	</div>
	<div class="mt-1 space-y-1 pl-3">
		{#each criterion.criteria as member, i (i)}
			<CriterionRow
				criterion={member}
				index={i}
				{target}
				{propertyNames}
				onChange={setMember}
				onRemove={removeMember}
			/>
		{/each}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="inline-flex w-fit items-center gap-1 text-xs text-info/90 transition-colors hover:text-info"
			>
				<Plus class="h-3 w-3" /> alternative
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="start" class="w-52">
				{#each memberTypes as t (t)}
					<DropdownMenu.Item onSelect={() => addMember(t)}>
						{CRITERION_LABELS[t]}
					</DropdownMenu.Item>
				{/each}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>
</div>
