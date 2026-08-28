<script lang="ts">
	// The nullable edge around SnippetSourceEditor for the export
	// `transform(doc)` hook. "No transform at all" (`null`) is a state the
	// shared editor has no shape for, so this wrapper owns exactly that — an
	// add affordance and an ×— and delegates everything else. Mode
	// (saved ↔ inline) stays the shared editor's single toggle: a second mode
	// control here would put two of them on screen.
	//
	// Adding writes `{}`, the tolerant unconfigured source — the editor opens
	// in saved mode with nothing picked, which is what "add a transform" means
	// before the user has said which. All strictness (JSON-family only, the
	// ref resolving to a snippet that defines transform(), inline code that
	// parses) is server-side at export time; this control never blocks Save.
	import SnippetSourceEditor from '$lib/components/Snippet/SnippetSourceEditor.svelte';
	import type { SnippetSource } from '$lib/api/types';

	let {
		value,
		disabled = false,
		collapseKey,
		onChange,
		onRun
	}: {
		value: SnippetSource | null;
		/** Gates the add/× affordances here and, forwarded, editability inside
		 * the delegated editor. Load-bearing on a read-only surface: a draft
		 * exporter ships its inline code to the server on the next Export, so a
		 * caller who may not edit must not be able to author it. */
		disabled?: boolean;
		collapseKey?: string;
		onChange: (next: SnippetSource | null) => void;
		/** Mod-Enter in the inline editor — forwarded to the shared editor's
		 * `onRun`, which the host points at its `TransformTestPanel`. */
		onRun?: () => void;
	} = $props();

	let inner: SnippetSourceEditor | undefined = $state();

	/** Forwarded cursor jump (a traceback frame in the host's test panel). */
	export function goToLine(line: number): void {
		inner?.goToLine(line);
	}
</script>

{#if value == null}
	<button
		type="button"
		data-testid="transform-add"
		class="rounded border border-input px-1.5 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
		{disabled}
		onclick={() => onChange({})}
	>
		Add transform
	</button>
{:else}
	<div data-testid="transform-source-editor" class="flex items-start gap-1.5">
		<div class="min-w-0 flex-1">
			<SnippetSourceEditor
				bind:this={inner}
				snippet={value}
				entry="transform"
				{collapseKey}
				{disabled}
				{onRun}
				onChange={(next) => onChange(next)}
			/>
		</div>
		<button
			type="button"
			data-testid="transform-remove"
			aria-label="Remove transform"
			title="Remove transform"
			class="shrink-0 rounded border border-input px-1.5 py-0.5 text-[11px] text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
			{disabled}
			onclick={() => onChange(null)}
		>
			×
		</button>
	</div>
{/if}
