<script lang="ts">
	// Shared ref/inline editor for a `SnippetSource` ({ ref?, definition? }) —
	// consumed embedded in a table's script column (F4) and a navigation
	// script step (F6). Mirrors NavigationColumnEditor's ref/inline toggle
	// (mode derived from `definition != null`; ref mode otherwise, including
	// the unconfigured `{}`), but stays deliberately simpler: a code string
	// has no embedded-draft mirror machinery to maintain, so this component
	// is plain controlled state — no `$state.raw`, no mirror `$effect`.
	import { onDestroy } from 'svelte';
	import { ChevronDown, ChevronRight } from '@lucide/svelte';
	import * as api from '$lib/api/artifacts';
	import { lintSnippet } from '$lib/api/snippets';
	import { getArtifactHeaders, isSnippetExpanded, setSnippetExpanded } from '$lib/state';
	import { entryAvailable, withStub, type BoundEntry } from '$lib/snippet/entry-stubs';
	import type { SnippetDiagnostic, SnippetSource } from '$lib/api/types';
	import CodeEditor from './CodeEditor.svelte';
	import SnippetTestPanel from './SnippetTestPanel.svelte';

	let {
		snippet,
		entry,
		onChange,
		collapseKey
	}: {
		snippet: SnippetSource;
		entry: BoundEntry;
		onChange: (next: SnippetSource) => void;
		/** When set, the editor renders behind a chevron disclosure (default
		 * collapsed) whose expansion state lives in the snippet-collapse store
		 * under this key — survives re-renders and dialog reopens. Absent =
		 * always expanded, no chevron (no current consumer does this, but the
		 * fallback keeps the component droppable anywhere). */
		collapseKey?: string;
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

	const expanded = $derived(collapseKey === undefined || isSnippetExpanded(collapseKey));
	// One line that says what's behind the fold: the entry point + first code
	// line for inline snippets, the referenced artifact's name for refs.
	const summary = $derived.by(() => {
		if (inline) {
			const first =
				(snippet.definition?.code ?? '').split('\n').find((l) => l.trim() !== '') ?? '';
			return `${entry}() · ${first.trim() || 'empty snippet'}`;
		}
		if (!snippet.ref) return 'no snippet selected';
		const ref = refOptions.find((h) => h.id === snippet.ref);
		return ref ? `saved: ${ref.name}` : 'saved snippet (missing)';
	});

	let seeding = $state(false);

	// bind:this handles the two directions the editor and the test panel need
	// to reach each other: Mod-Enter in the code editor triggers a run, and a
	// traceback frame in the run's result jumps the editor's cursor.
	let editor: CodeEditor | undefined = $state();
	let testPanel: SnippetTestPanel | undefined = $state();

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

	// An unmounted instance must not write lint state from a pending timer or
	// an in-flight response — bump the generation and drop the timer so both
	// are neutralized.
	onDestroy(() => {
		if (lintTimer) clearTimeout(lintTimer);
		lintSeq++;
	});

	function handleCodeChange(code: string): void {
		if (!snippet.definition) return;
		onChange({ definition: { ...snippet.definition, code } });
	}

	async function switchToInline(): Promise<void> {
		if (inline || seeding) return;
		const capturedRef = snippet.ref ?? null;
		let code: string | null = null;
		if (capturedRef) {
			seeding = true;
			try {
				const artifact = await api.getArtifact(capturedRef);
				code = typeof artifact.payload.code === 'string' ? artifact.payload.code : null;
			} catch {
				code = null; // unknown/foreign ref: fall through to a fresh stub
			} finally {
				seeding = false;
			}
			// The user picked a DIFFERENT ref while this fetch was in flight (the
			// select stays enabled — only the toggle buttons are gated by
			// `seeding`). That newer pick must win: bail without emitting, or
			// we'd silently clobber it with the stale ref's definition.
			if (snippet.ref !== capturedRef) return;
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
	{#if collapseKey !== undefined}
		<button
			type="button"
			data-testid="snippet-collapse-toggle"
			aria-expanded={expanded}
			aria-label={expanded ? 'Collapse snippet' : 'Expand snippet'}
			class="flex w-full items-center gap-1 text-left text-muted-foreground/80 transition-colors hover:text-foreground"
			onclick={() => setSnippetExpanded(collapseKey, !expanded)}
		>
			{#if expanded}<ChevronDown class="size-3.5 shrink-0" />{:else}<ChevronRight
					class="size-3.5 shrink-0"
				/>{/if}
			<span data-testid="snippet-collapse-summary" class="truncate font-mono text-[10px]"
				>{summary}</span
			>
		</button>
	{/if}
	{#if expanded}
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
				disabled={seeding}
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
				<CodeEditor
					bind:this={editor}
					code={def.code}
					{diagnostics}
					onChange={handleCodeChange}
					onRun={() => void testPanel?.requestRun()}
				/>
			</div>
			{#if !entryPoints.includes(entry)}
				<div data-testid="snippet-entry-warning" class="text-amber-600">
					define {entry}() to use this snippet here
				</div>
			{/if}
		{/if}

		<!-- In ref mode there is no lint response to ask, so `[entry]` stands in
		     as "the ref covers it" — EXCEPT when `refMissing` is true: the ref
		     that was covering it is gone (deleted, or its own entry_points moved),
		     the `snippet-ref-missing` warning above already says so, and Run must
		     agree rather than post a doomed `artifact_id` to the backend. -->
		<SnippetTestPanel
			bind:this={testPanel}
			{snippet}
			{entry}
			entryPoints={inline ? entryPoints : refMissing ? [] : [entry]}
			onGoToLine={(l) => editor?.goToLine(l)}
		/>
	{/if}
</div>
