<script lang="ts">
	import { MessageSquarePlus, MessageSquareText } from '@lucide/svelte';
	import type { NavPropertyStep } from '$lib/api/types';
	import type { PropertyItem } from '$lib/search/property-ops';
	import PropertyPicker from '../Sidebar/PropertyPicker.svelte';
	import ChainBadge from './ChainBadge.svelte';

	type Props = {
		step: NavPropertyStep;
		index: number;
		/** The rail's column number for this hop (a property step advances the
		 * chain exactly like a relationship step) — see PathCard's `columnFor`. */
		column: number;
		/** Properties reachable at this point in the chain (the frontier's
		 * effective-property union); scopes the property picker. */
		items: PropertyItem[];
		/** True when the configured property is not an element reference
		 * anywhere reachable — the chain cannot continue past this step. */
		deadEnd: boolean;
		onChange: (index: number, next: NavPropertyStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, column, items, deadEnd, onChange, onRemove }: Props = $props();

	let pickerOpen = $state(false);

	const selectedItem = $derived(items.find((it) => it.name === step.property_name));
	const datatype = $derived(selectedItem?.datatype ?? null);

	function patch(next: Partial<NavPropertyStep>): void {
		onChange(index, { ...step, ...next });
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
		patch({ comment: trimmed === '' ? null : trimmed });
	}
</script>

<div class="group relative flex items-baseline gap-2.5 py-0.5" data-testid="property-step">
	<ChainBadge value={column} />
	<div class="flex min-h-[22px] flex-1 flex-col gap-1">
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="text-muted-foreground">Go to property</span>
			<PropertyPicker
				{items}
				onPick={(name) => patch({ property_name: name })}
				open={pickerOpen}
				onOpenChange={(v) => (pickerOpen = v)}
				searchPlaceholder="Filter properties…"
			>
				{#snippet trigger()}
					<span
						class="cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[11px]
							{step.property_name
							? 'border-input bg-card'
							: 'border-dashed border-input text-muted-foreground/70'}"
					>
						{step.property_name || 'pick a property…'}
					</span>
				{/snippet}
			</PropertyPicker>
			{#if datatype}
				<span class="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">
					{datatype}
				</span>
			{/if}
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
				title="Remove step"
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
		{#if deadEnd}
			<div data-testid="property-dead-end" class="pl-7 text-[11px] text-warning">
				not an element property — navigation ends here
			</div>
		{/if}
	</div>
</div>
