<script lang="ts">
	// The snippet tab root: name + entry-point + run/stop/save toolbar, an
	// optional element-context row (bound-element entries only), the code
	// editor, and the console below it. Mirrors Table/TableView.svelte's
	// chrome-bar-over-content shape.
	import {
		addSnippetElement,
		canEdit,
		clearSnippetElements,
		ensureSnippetDocs,
		ensureSnippetDraft,
		getMetamodel,
		getSnippetDocs,
		getSnippetDraft,
		getSnippetLint,
		getSnippetLockHolder,
		getSnippetRun,
		reloadSnippetDraft,
		removeSnippetElement,
		retrySnippetLock,
		runSnippetTab,
		saveSnippetDraft,
		setSnippetEntry,
		setSnippetName,
		stopSnippetTab,
		updateSnippetCode
	} from '$lib/state';
	import { getSnippetSplitRatio, setSnippetSplitRatio } from '$lib/state';
	import { vocabFromMetamodel } from '$lib/editor/completion-source';
	import {
		SPLIT_DIVIDER_H,
		SPLIT_MIN_PANEL_H,
		ratioFromPointer,
		splitHeights
	} from '$lib/editor/editor-size';
	import { ENTRY_HINTS, entryAvailable, withStub, type BoundEntry } from '$lib/snippet/entry-stubs';
	import CodeEditor from './CodeEditor.svelte';
	import SnippetConsole from './SnippetConsole.svelte';
	import ElementContextRow from './ElementContextRow.svelte';
	import SnippetDocsDialog from './SnippetDocsDialog.svelte';

	let { tabId }: { tabId: string } = $props();

	let docsOpen = $state(false);

	$effect(() => {
		void ensureSnippetDraft(tabId);
		void ensureSnippetDocs();
	});

	const draft = $derived(getSnippetDraft(tabId));
	const run = $derived(getSnippetRun(tabId));
	const lint = $derived(getSnippetLint(tabId));
	const editable = $derived(canEdit());
	/** Non-null while a peer holds this snippet's `art:` lease: the tab is
	 * UNSAVEABLE until the check-out succeeds — Save is disabled behind the
	 * banner ("Retry"), while the editing surface itself stays live. This tab
	 * has no Save-as. See `navigation-editor.svelte.ts`'s `ensureDraft`
	 * docstring. */
	const lockHolder = $derived(getSnippetLockHolder(tabId));
	/** A refused check-out disables the SAVE affordances (name, Save — this tab
	 * has no Save-as) but keeps them VISIBLE — paired with the banner, that is
	 * what explains why. It does NOT gate the editing surface; the banner copy
	 * says "you will not be able to save" rather than "read-only" for exactly
	 * that reason. */
	const locked = $derived(lockHolder !== null);
	const vocab = $derived(vocabFromMetamodel(getMetamodel()));

	const entryOk = $derived(entryAvailable(run.entry, lint?.entryPoints));
	const runDisabled = $derived(
		run.phase !== 'idle' || !entryOk || (run.entry !== 'script' && run.elements.length === 0)
	);

	let editor: CodeEditor | undefined = $state();
	let saveError = $state<string | null>(null);

	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveSnippetDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	// Measured editor/console split. `flex-[3]`/`flex-[2]` gave a fixed 60/40
	// with no way to change it; the ratio now lives in a persisted store and the
	// divider below drives it. Container height comes from a ResizeObserver
	// rather than a one-shot read — the tab body changes height whenever a
	// banner (save error, entry hint, lock-denied notice) appears above it.
	let bodyEl: HTMLElement | null = $state(null);
	let bodyH = $state(0);

	$effect(() => {
		if (!bodyEl) return;
		bodyH = bodyEl.clientHeight;
		const ro = new ResizeObserver(() => {
			if (bodyEl) bodyH = bodyEl.clientHeight;
		});
		ro.observe(bodyEl);
		return () => ro.disconnect();
	});

	const paneHeights = $derived(
		splitHeights({
			containerH: bodyH,
			ratio: getSnippetSplitRatio(),
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		})
	);

	// Plain `let`, not `$state`: drag bookkeeping never read in the template
	// (same call as VerticalSplit.svelte's `dragging`).
	let dragging = false;

	function onDividerPointerDown(e: PointerEvent): void {
		if (e.button !== 0 || !e.isPrimary) return;
		e.preventDefault();
		dragging = true;
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		window.addEventListener('pointermove', onDividerPointerMove);
		window.addEventListener('pointerup', endDrag);
		// pointercancel (a system interruption) must end the drag too, or the
		// divider stays locked to the pointer — mirrors VerticalSplit's teardown.
		window.addEventListener('pointercancel', endDrag);
	}

	function onDividerPointerMove(e: PointerEvent): void {
		if (!dragging || bodyEl === null) return;
		const rect = bodyEl.getBoundingClientRect();
		setSnippetSplitRatio(
			ratioFromPointer({
				pointerY: e.clientY - rect.top,
				containerH: rect.height,
				dividerH: SPLIT_DIVIDER_H,
				minPanelH: SPLIT_MIN_PANEL_H
			})
		);
	}

	function endDrag(): void {
		dragging = false;
		window.removeEventListener('pointermove', onDividerPointerMove);
		window.removeEventListener('pointerup', endDrag);
		window.removeEventListener('pointercancel', endDrag);
	}

	$effect(() => endDrag); // drop window listeners on unmount
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col overflow-hidden">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable || locked}
				oninput={(e) => setSnippetName(tabId, e.currentTarget.value)}
			/>
			<select
				data-testid="snippet-entry"
				class="rounded border border-input bg-card px-2 py-1 text-xs"
				value={run.entry}
				onchange={(e) =>
					setSnippetEntry(tabId, e.currentTarget.value as 'script' | 'value' | 'step')}
			>
				<option value="script" title="Run the whole file top-to-bottom">script</option>
				<option
					value="value"
					title="Call a top-level value(elements) with one or more chosen elements (read-only)"
				>
					value
				</option>
				<option value="step" title="Call a top-level step(el) with a chosen element (read-only)">
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
				onclick={() => (docsOpen = true)}
			>
				Docs
			</button>
			{#if editable}
				<button
					type="button"
					data-testid="snippet-save"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
					disabled={locked}
					onclick={() => void save()}
				>
					Save{draft.dirty ? ' *' : ''}
				</button>
			{/if}
		</div>
		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		{#if lint && run.entry !== 'script' && !entryOk}
			<div
				data-testid="snippet-entry-hint"
				class="flex items-center gap-2 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
			>
				<span>{ENTRY_HINTS[run.entry as BoundEntry]}</span>
				<button
					type="button"
					data-testid="snippet-insert-stub"
					class="shrink-0 rounded border border-input px-2 py-0.5 text-foreground/80 transition-colors hover:bg-muted"
					onclick={() =>
						draft && updateSnippetCode(tabId, withStub(draft.code, run.entry as BoundEntry))}
				>
					Insert stub
				</button>
			</div>
		{/if}
		{#if lockHolder !== null}
			<div
				class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning"
				role="status"
			>
				Checked out by {lockHolder} — you will not be able to save.
				<button type="button" class="underline" onclick={() => void retrySnippetLock(tabId)}>
					Retry
				</button>
				<button type="button" class="underline" onclick={() => void reloadSnippetDraft(tabId)}>
					Reload
				</button>
			</div>
		{/if}
		{#if run.entry !== 'script'}
			<ElementContextRow
				entry={run.entry}
				elements={run.elements}
				onAdd={(id, label) => addSnippetElement(tabId, id, label)}
				onRemove={(id) => removeSnippetElement(tabId, id)}
				onClear={() => clearSnippetElements(tabId)}
			/>
		{/if}
		<div bind:this={bodyEl} class="flex min-h-0 flex-1 flex-col">
			<div class="min-h-0 overflow-hidden" style="height: {paneHeights.topH}px">
				<CodeEditor
					bind:this={editor}
					code={draft.code}
					diagnostics={lint?.diagnostics ?? []}
					docs={getSnippetDocs()}
					{vocab}
					onChange={(c) => updateSnippetCode(tabId, c)}
					onRun={() => void runSnippetTab(tabId)}
				/>
			</div>
			<div
				data-testid="snippet-split-divider"
				role="separator"
				aria-orientation="horizontal"
				aria-label="Resize code editor and console"
				class="shrink-0 cursor-row-resize bg-border transition-colors hover:bg-primary/50"
				style="height: {SPLIT_DIVIDER_H}px"
				onpointerdown={onDividerPointerDown}
			></div>
			<div class="min-h-0 overflow-hidden" style="height: {paneHeights.bottomH}px">
				<SnippetConsole {tabId} onGoToLine={(l) => editor?.goToLine(l)} />
			</div>
		</div>
	</div>
{/if}

<SnippetDocsDialog bind:open={docsOpen} />
