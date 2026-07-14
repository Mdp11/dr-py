<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { MessageSquarePlus, MessageSquareText, Trash2 } from '@lucide/svelte';
	import { getMetamodel } from '$lib/state';
	import {
		relationshipTypesFromScope,
		scopeAllowedTargetTypes
	} from '$lib/metamodel/connection-rules';
	import type { NavDirection, NavRelationshipStep } from '$lib/api/types';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';
	import ChainBadge from './ChainBadge.svelte';

	type Props = {
		step: NavRelationshipStep;
		index: number;
		/** The rail's column number for this hop (1 + preceding relationship
		 * steps) — see PathCard's `columnFor`. */
		column: number;
		/** Types flowing INTO this step (previous scope's types; [] = any). */
		sourceTypes: string[];
		onChange: (index: number, next: NavRelationshipStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, column, sourceTypes, onChange, onRemove }: Props = $props();

	const mm = $derived(getMetamodel());
	let relPickerOpen = $state(false);
	let targetPickerOpen = $state(false);

	// Valid hop types from the incoming types; unconstrained when sourceTypes
	// is empty or direction is 'in'/'either' (keep permissive: the backend is
	// the semantic authority, the picker is a convenience filter).
	const relTypeNames = $derived.by(() => {
		if (!mm) return [];
		if (step.direction !== 'out' || sourceTypes.length === 0) {
			return mm.relationships
				.filter((r) => !r.abstract)
				.map((r) => r.name)
				.sort();
		}
		// Ephemeral scratch set: built and drained into the returned array within
		// this derivation — never stored or read reactively itself (the $derived
		// wrapper tracks the resulting array).
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const names = new Set<string>();
		for (const t of sourceTypes) {
			for (const entry of relationshipTypesFromScope(mm, t)) names.add(entry.rt.name);
		}
		return [...names].sort();
	});

	// Target-type picker options: the mapping-allowed union when the hop is
	// outgoing from known source types, else every element type (unconstrained
	// convenience picker — the backend is the semantic authority).
	const targetTypeNames = $derived.by(() => {
		if (!mm) return [];
		if (step.direction !== 'out' || sourceTypes.length === 0) {
			return [...mm.elements.map((e) => e.name)].sort();
		}
		const rt = mm.relationships.find((r) => r.name === step.relationship_type);
		if (!rt) return [...mm.elements.map((e) => e.name)].sort();
		// Ephemeral scratch set: built and drained into the returned array within
		// this derivation — never stored or read reactively itself (the $derived
		// wrapper tracks the resulting array).
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const out = new Set<string>();
		for (const t of sourceTypes) for (const n of scopeAllowedTargetTypes(mm, t, rt)) out.add(n);
		return out.size > 0 ? [...out].sort() : [...mm.elements.map((e) => e.name)].sort();
	});

	const checkedTargetTypes = $derived(new SvelteSet(step.target_types));

	function patch(next: Partial<NavRelationshipStep>): void {
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

	function toggleTargetType(name: string): void {
		// Ephemeral scratch set: built, mutated, and spread into the onChange
		// payload within this call — never stored or read reactively.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const next = new Set(step.target_types);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		patch({ target_types: [...next].sort() });
	}
</script>

<div class="group relative flex items-baseline gap-2.5 py-0.5" data-testid="relationship-step">
	<ChainBadge value={column} />
	<div class="flex min-h-[22px] flex-1 flex-wrap items-center gap-1.5">
		<span class="text-muted-foreground">Follow</span>
		<StereotypePicker
			mode="create"
			names={relTypeNames}
			onPick={(name) => patch({ relationship_type: name })}
			open={relPickerOpen}
			onOpenChange={(v) => (relPickerOpen = v)}
			searchPlaceholder="Relationship type…"
		>
			{#snippet trigger()}
				<span
					class="cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[11px]
						{step.relationship_type
						? 'border-input bg-card'
						: 'border-dashed border-input text-muted-foreground/70'}"
				>
					{step.relationship_type || 'pick a relationship…'}
				</span>
			{/snippet}
		</StereotypePicker>
		<select
			class="rounded border border-input bg-card px-1 py-0.5 text-xs"
			value={step.direction}
			onchange={(e) => patch({ direction: e.currentTarget.value as NavDirection })}
		>
			<option value="out">outgoing</option>
			<option value="in">incoming</option>
			<option value="either">either</option>
		</select>
		<span class="text-muted-foreground">to</span>
		<StereotypePicker
			mode="filter"
			names={targetTypeNames}
			checked={checkedTargetTypes}
			onToggle={toggleTargetType}
			onSelectAll={() => patch({ target_types: [...targetTypeNames] })}
			onDeselectAll={() => patch({ target_types: [] })}
			open={targetPickerOpen}
			onOpenChange={(v) => (targetPickerOpen = v)}
			searchPlaceholder="Filter types…"
		>
			{#snippet trigger()}
				<span
					class="cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[11px]
						{step.target_types.length
						? 'border-input bg-card'
						: 'border-dashed border-input text-muted-foreground/70'}"
				>
					{step.target_types.length === 0 ? 'any type' : step.target_types.join(', ')}
				</span>
			{/snippet}
		</StereotypePicker>
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
			class="text-muted-foreground/70 transition-colors hover:text-destructive"
			class:ml-auto={Boolean(step.comment) || editingComment}
			onclick={() => onRemove(index)}
		>
			<Trash2 class="size-3.5" />
		</button>
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
	</div>
</div>
