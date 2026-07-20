<script lang="ts">
	// Shared ref/inline editor for a `SnippetSource` ({ ref?, definition? }) —
	// consumed embedded in a table's script column (F4) and a navigation
	// script step (F6). Mirrors NavigationColumnEditor's ref/inline toggle
	// (mode derived from `definition != null`; ref mode otherwise, including
	// the unconfigured `{}`), but stays deliberately simpler: a code string
	// has no embedded-draft mirror machinery to maintain, so this component
	// is plain controlled state — no `$state.raw`, no mirror `$effect`.
	import * as api from '$lib/api/artifacts';
	import { lintSnippet } from '$lib/api/snippets';
	import { getArtifactHeaders } from '$lib/state';
	import { entryAvailable, withStub, type BoundEntry } from '$lib/snippet/entry-stubs';
	import type { SnippetDiagnostic, SnippetSource } from '$lib/api/types';
	import CodeEditor from './CodeEditor.svelte';

	let {
		snippet,
		entry,
		onChange
	}: {
		snippet: SnippetSource;
		entry: BoundEntry;
		onChange: (next: SnippetSource) => void;
	} = $props();

	const inline = $derived(snippet.definition != null);

	const refOptions = $derived(
		getArtifactHeaders().filter(
			(a) => a.kind === 'code_snippet' && entryAvailable(entry, a.entry_points ?? undefined)
		)
	);
	// The currently selected ref may have fallen out of the filtered list (its
	// entry_points no longer cover `entry`, or the artifact was deleted) — that
	// is surfaced as a hint, never silently cleared (the user might just be
	// mid-edit of the snippet elsewhere).
	const refMissing = $derived(
		!inline && !!snippet.ref && !refOptions.some((h) => h.id === snippet.ref)
	);

	let seeding = $state(false);

	// Component-local lint state — NOT the M1 store's embedded-draft
	// machinery (snippet-editor.svelte.ts): this editor just holds a code
	// string, so a plain debounced call is enough.
	let diagnostics: SnippetDiagnostic[] = $state([]);
	let entryPoints: string[] = $state([]);
	let lintSeq = 0;
	let lintTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleLint(code: string): void {
		if (lintTimer) clearTimeout(lintTimer);
		lintTimer = setTimeout(async () => {
			const seq = ++lintSeq;
			try {
				const out = await lintSnippet(code);
				if (seq !== lintSeq) return;
				diagnostics = out.diagnostics;
				entryPoints = out.entry_points;
			} catch {
				/* lint is advisory; ignore transport errors */
			}
		}, 300);
	}

	// Lint whenever the inline code changes — on entering inline mode
	// (mount-time seed or an external swap) as well as every subsequent edit.
	$effect(() => {
		if (!inline) return;
		scheduleLint(snippet.definition?.code ?? '');
	});

	function handleCodeChange(code: string): void {
		if (!snippet.definition) return;
		onChange({ definition: { ...snippet.definition, code } });
	}

	async function switchToInline(): Promise<void> {
		if (inline || seeding) return;
		let code: string | null = null;
		if (snippet.ref) {
			seeding = true;
			try {
				const artifact = await api.getArtifact(snippet.ref);
				const payload = artifact.payload as Record<string, unknown>;
				code = typeof payload.code === 'string' ? payload.code : null;
			} catch {
				code = null; // unknown/foreign ref: fall through to a fresh stub
			} finally {
				seeding = false;
			}
		}
		onChange({
			definition: {
				schema_version: 1,
				language: 'python',
				code: code ?? withStub('', entry),
				entry_points: []
			}
		});
	}

	function switchToRef(): void {
		if (!inline) return;
		onChange({});
	}

	function setRef(e: Event): void {
		const id = (e.currentTarget as HTMLSelectElement).value;
		if (id) onChange({ ref: id });
	}
</script>

<div data-testid="snippet-source-editor" class="space-y-1.5 text-[11px]">
	<div class="flex overflow-hidden rounded border border-input">
		<button
			type="button"
			data-testid="snippet-mode-ref"
			class="px-1.5 py-0.5 {inline ? 'hover:bg-muted' : 'bg-muted font-medium'}"
			disabled={seeding}
			onclick={switchToRef}
		>
			saved
		</button>
		<button
			type="button"
			data-testid="snippet-mode-inline"
			class="border-l border-input px-1.5 py-0.5 {inline
				? 'bg-muted font-medium'
				: 'hover:bg-muted'}"
			disabled={seeding}
			onclick={switchToInline}
		>
			inline
		</button>
	</div>

	{#if !inline}
		<select
			data-testid="snippet-ref-select"
			aria-label="Saved snippet"
			value={snippet.ref ?? ''}
			onchange={setRef}
			class="rounded border border-input bg-card px-1 py-0.5"
		>
			<option value="">Select a saved snippet…</option>
			{#each refOptions as h (h.id)}
				<option value={h.id}>{h.name}</option>
			{/each}
		</select>
		{#if refMissing}
			<div data-testid="snippet-ref-missing" class="text-amber-600">
				snippet not found or lacks a {entry}() entry point
			</div>
		{/if}
	{:else if snippet.definition}
		{@const def = snippet.definition}
		<div class="h-48 overflow-hidden rounded border border-input">
			<CodeEditor code={def.code} {diagnostics} onChange={handleCodeChange} onRun={() => {}} />
		</div>
		{#if !entryPoints.includes(entry)}
			<div data-testid="snippet-entry-warning" class="text-amber-600">
				define {entry}() to use this snippet here
			</div>
		{/if}
	{/if}
</div>
