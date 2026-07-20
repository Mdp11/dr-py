<script lang="ts">
	// A `script`-kind step: runs a snippet's step(el) per frontier element.
	// Deliberately minimal compared to PropertyStepRow — a script step has no
	// column/frontier machinery of its own (see the module docstring in
	// PathCard.svelte on the known frontier-tracking gap for script steps),
	// so this row is just the shared SnippetSourceEditor (bound to the
	// "step" entry point) plus the same per-step comment note the other rows
	// have.
	import { MessageSquarePlus, MessageSquareText } from '@lucide/svelte';
	import type { NavScriptStep } from '$lib/api/types';
	import SnippetSourceEditor from '$lib/components/Snippet/SnippetSourceEditor.svelte';

	type Props = {
		step: NavScriptStep;
		index: number;
		onChange: (index: number, next: NavScriptStep) => void;
		onRemove: (index: number) => void;
	};
	let { step, index, onChange, onRemove }: Props = $props();

	function patch(next: Partial<NavScriptStep>): void {
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

<div class="group relative flex items-baseline gap-2.5 py-0.5" data-testid="script-step">
	<div class="flex min-h-[22px] flex-1 flex-col gap-1">
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="text-muted-foreground">Script</span>
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
		<SnippetSourceEditor
			snippet={step.snippet}
			entry="step"
			onChange={(s) => patch({ snippet: s })}
		/>
	</div>
</div>
