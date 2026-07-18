<script lang="ts">
	// The snippet tab root: name + entry-point + run/stop/save toolbar, an
	// optional element-context row (bound-element entries only), the code
	// editor, and the console below it. Mirrors Table/TableView.svelte's
	// chrome-bar-over-content shape.
	import {
		canEdit,
		ensureSnippetDocs,
		ensureSnippetDraft,
		getSnippetDraft,
		getSnippetLint,
		getSnippetRun,
		getSnippetSaveConflict,
		reloadSnippetDraft,
		runSnippetTab,
		saveSnippetDraft,
		setSnippetEntry,
		setSnippetName,
		stopSnippetTab,
		updateSnippetCode
	} from '$lib/state';
	import CodeEditor from './CodeEditor.svelte';
	import SnippetConsole from './SnippetConsole.svelte';
	import ElementContextRow from './ElementContextRow.svelte';
	import SnippetDocsPanel from './SnippetDocsPanel.svelte';

	let { tabId }: { tabId: string } = $props();

	let showDocs = $state(false);

	$effect(() => {
		void ensureSnippetDraft(tabId);
		void ensureSnippetDocs();
	});

	const draft = $derived(getSnippetDraft(tabId));
	const run = $derived(getSnippetRun(tabId));
	const lint = $derived(getSnippetLint(tabId));
	const editable = $derived(canEdit());
	const conflictRev = $derived(getSnippetSaveConflict(tabId));

	const runDisabled = $derived(
		run.phase !== 'idle' || (run.entry !== 'script' && run.elementId === null)
	);

	let editor: CodeEditor | undefined = $state();
	let saveError = $state<string | null>(null);
	// Local dismissal of the conflict banner — there is no store-level "clear
	// conflict" op short of reloading; "Keep editing" just hides the banner
	// for this rev so it doesn't reappear on every re-render while the user
	// keeps typing over their own (still-unsaved) copy.
	let dismissedConflictRev = $state<number | null>(null);
	const showConflict = $derived(conflictRev !== undefined && conflictRev !== dismissedConflictRev);

	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveSnippetDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col overflow-hidden">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setSnippetName(tabId, e.currentTarget.value)}
			/>
			<select
				data-testid="snippet-entry"
				class="rounded border border-input bg-card px-2 py-1 text-xs"
				value={run.entry}
				onchange={(e) =>
					setSnippetEntry(tabId, e.currentTarget.value as 'script' | 'value' | 'step')}
			>
				<option value="script">script</option>
				<option value="value" disabled={!(lint?.entryPoints.includes('value') ?? false)}>
					value
				</option>
				<option value="step" disabled={!(lint?.entryPoints.includes('step') ?? false)}>
					step
				</option>
			</select>
			<span class="flex-1"></span>
			<button
				type="button"
				data-testid="snippet-run"
				class="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
				disabled={runDisabled}
				onclick={() => void runSnippetTab(tabId)}
			>
				Run
			</button>
			{#if run.phase !== 'idle'}
				<button
					type="button"
					data-testid="snippet-stop"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
					onclick={() => void stopSnippetTab(tabId)}
				>
					Stop
				</button>
			{/if}
			<button
				type="button"
				data-testid="snippet-docs-toggle"
				class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
				aria-pressed={showDocs}
				onclick={() => (showDocs = !showDocs)}
			>
				Docs
			</button>
			{#if editable}
				<button
					type="button"
					data-testid="snippet-save"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
					onclick={() => void save()}
				>
					Save{draft.dirty ? ' *' : ''}
				</button>
			{/if}
		</div>
		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		{#if showConflict && conflictRev !== undefined}
			<div class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning">
				Saved elsewhere (rev {conflictRev}).
				<button type="button" class="underline" onclick={() => void reloadSnippetDraft(tabId)}>
					Reload server copy
				</button>
				<button
					type="button"
					class="underline"
					onclick={() => (dismissedConflictRev = conflictRev)}
				>
					Keep editing
				</button>
			</div>
		{/if}
		{#if run.entry !== 'script'}
			<ElementContextRow {tabId} />
		{/if}
		<div class="flex min-h-0 flex-1">
			<div class="flex min-h-0 flex-1 flex-col">
				<div class="min-h-0 flex-[3] overflow-hidden">
					<CodeEditor
						bind:this={editor}
						code={draft.code}
						diagnostics={lint?.diagnostics ?? []}
						onChange={(c) => updateSnippetCode(tabId, c)}
						onRun={() => void runSnippetTab(tabId)}
					/>
				</div>
				<div class="min-h-0 flex-[2] overflow-hidden">
					<SnippetConsole {tabId} onGoToLine={(l) => editor?.goToLine(l)} />
				</div>
			</div>
			{#if showDocs}
				<div class="w-80 shrink-0">
					<SnippetDocsPanel />
				</div>
			{/if}
		</div>
	</div>
{/if}
