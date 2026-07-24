<script lang="ts">
	import { MessageSquarePlus, MessageSquareText } from '@lucide/svelte';
	import type { NavFilterStep } from '$lib/api/types';
	import type { AnyOfCriterion, Criterion, LeafCriterion } from '$lib/search/types';
	import { newCriterion } from '$lib/search/types';
	import CriterionGroupRow from '../Sidebar/CriterionGroupRow.svelte';
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
	function addGroup(): void {
		onChange(index, {
			...step,
			criteria: [...(step.criteria as Criterion[]), newCriterion('any_of')]
		});
	}

	// Per-step note: a free-form comment explaining the step's intent (part of
	// the saved definition; the evaluator ignores it). Empty commits remove it.
	let editingComment = $state(false);
	let commentEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (editingComment) commentEl?.focus();
	});
	function commitComment(value: string): void {
		if (!editingComment) return; // Escape already cancelled; ignore the trailing blur
		editingComment = false;
		const trimmed = value.trim();
		if ((step.comment ?? '') === trimmed || (!step.comment && trimmed === '')) return;
		onChange(index, { ...step, comment: trimmed === '' ? null : trimmed });
	}
</script>

<div class="group relative flex items-baseline gap-2.5 py-0.5" data-testid="filter-step">
	<ChainBadge value={null} />
	<div class="flex min-h-[22px] flex-1 flex-col gap-1">
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="text-muted-foreground">Keep only</span>
			{#if !step.comment && !editingComment}
				<button
					type="button"
					aria-label="Add step note"
					title="Add a note explaining this step"
					class="ml-auto text-muted-foreground/40 transition-colors hover:text-info"
					onclick={() => (editingComment = true)}
				>
					<MessageSquarePlus class="size-3.5" />
				</button>
			{/if}
			<button
				type="button"
				aria-label="Remove step"
				title="Remove filter"
				class="text-muted-foreground/70 transition-colors hover:text-destructive"
				class:ml-auto={Boolean(step.comment) || editingComment}
				onclick={() => onRemove(index)}
			>
				✕
			</button>
		</div>
		{#if editingComment}
			<input
				bind:this={commentEl}
				data-testid="step-comment-input"
				aria-label="Step note"
				class="w-full rounded border border-input bg-card px-1.5 py-0.5 text-[11px]"
				placeholder="Why this step? (Enter to save, empty to remove)"
				value={step.comment ?? ''}
				onblur={(e) => commitComment(e.currentTarget.value)}
				onkeydown={(e) => {
					if (e.key === 'Enter') commitComment(e.currentTarget.value);
					else if (e.key === 'Escape') editingComment = false;
				}}
			/>
		{:else if step.comment}
			<button
				type="button"
				data-testid="step-comment"
				title="Edit this note"
				class="flex w-full items-start gap-1.5 text-left text-[11px] text-muted-foreground/80 italic transition-colors hover:text-foreground"
				onclick={() => (editingComment = true)}
			>
				<MessageSquareText class="mt-0.5 size-3 shrink-0 text-info/70" />
				<span class="min-w-0 break-words">{step.comment}</span>
			</button>
		{/if}
		<div class="space-y-1 pl-7">
			{#each step.criteria as criterion, i (i)}
				{#if (criterion as Criterion).type === 'any_of'}
					<CriterionGroupRow
						criterion={criterion as AnyOfCriterion}
						index={i}
						target="element"
						{propertyNames}
						onChange={setCriterion}
						onRemove={removeCriterion}
					/>
				{:else}
					<CriterionRow
						criterion={criterion as LeafCriterion}
						index={i}
						target="element"
						{propertyNames}
						onChange={setCriterion}
						onRemove={removeCriterion}
					/>
				{/if}
			{/each}
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
	</div>
</div>
