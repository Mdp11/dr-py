<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import { Button } from '$lib/components/ui/button';
	import MetamodelYamlEditor from './MetamodelYamlEditor.svelte';
	import MetamodelPreviewPanel from './MetamodelPreviewPanel.svelte';
	import MetamodelDiagram from './MetamodelDiagram.svelte';
	import { getMetamodel as fetchMetamodel } from '$lib/api/metamodel';
	import type { Issue } from '$lib/api/types';
	import {
		adoptIssues,
		closeMetamodelDiagram,
		closeMetamodelEditor,
		commitMetamodelRebind,
		discardMetamodelDraft,
		editMetamodelBuffer,
		getActiveProjectId,
		getMetamodelDiagramView,
		getMetamodelEditor,
		getRole,
		initMetamodelDiagram,
		initMetamodelEditor,
		isProjectQuiet,
		onMetamodelRebound,
		previewMetamodelChanges,
		refreshSummary,
		retryMetamodelLease,
		setMetamodel,
		setMetamodelView
	} from '$lib/state';

	const ed = $derived(getMetamodelEditor());
	/** Which surface the tab shows. Owned by the diagram state module (it
	 * persists the choice per project), so the toggle below is a pure command. */
	const surface = $derived(getMetamodelDiagramView().view);
	const isOwner = $derived(getRole() === 'owner');
	// Same shared quiet rule as history Revert / the old swap drawer.
	const quiet = $derived(isProjectQuiet());
	/** First message-only lint error (no line anchor) for the strip below the
	 * editor; positioned errors render in the gutter instead. */
	const stripError = $derived(ed.lintErrors.find((e) => e.line === null) ?? null);

	/** `as const` so the ids stay the literal union `setMetamodelView` takes. */
	const SURFACES = [
		{ id: 'yaml', label: 'YAML' },
		{ id: 'diagram', label: 'Diagram' }
	] as const;

	let message = $state('');
	/** The rebind itself already succeeded by the time this can fire — the
	 * copy below must never read as a failed rebind, only as a stale view. */
	let refreshError = $state<string | null>(null);

	/** The diagram init is CHAINED, not raced: it reads the editor's buffer to
	 * auto-arrange a never-arranged metamodel, so an empty buffer would leave it
	 * with nothing to place (see initMetamodelDiagram's docstring). */
	async function init(): Promise<void> {
		const pid = getActiveProjectId();
		if (pid === null) return;
		await initMetamodelEditor(pid);
		await initMetamodelDiagram(pid);
	}

	onMount(() => {
		void init();
		// Unmount without a close transition must release the lease too — the
		// old drawer's known leak, fixed here by pairing mount with teardown.
		// The diagram closes first: its teardown flushes a pending layout PUT.
		return () => {
			closeMetamodelDiagram();
			closeMetamodelEditor();
		};
	});

	function toIssue(o: { severity: string; message: string; target_ids: string[] }): Issue {
		return {
			severity: o.severity === 'warning' ? 'warning' : 'error',
			message: o.message,
			target_ids: o.target_ids,
			origin: 'on_server'
		};
	}

	async function onRebind(): Promise<void> {
		refreshError = null;
		const res = await commitMetamodelRebind(message);
		if (res === null) return;
		// The commit consumed the message regardless of what the refresh below
		// does next.
		message = '';
		// The draft's names ARE the project's names now, so every deferred layout
		// key rewrite becomes true at once. Before the refresh, deliberately: the
		// window where the shared layout blob still speaks the old names should be
		// as short as possible, and the refresh below can fail.
		onMetamodelRebound();
		try {
			const mm = await fetchMetamodel();
			setMetamodel(mm);
			// The rebind response already carries a full authoritative issue list
			// (+ counts + rev), so adopt it directly as the live map rather than
			// paying for a separate refetch.
			adoptIssues(res.issues.map(toIssue), res.issue_counts, res.model_rev);
			await refreshSummary();
		} catch {
			// The durable rebind already landed — this is a stale VIEW, not a
			// failed rebind, so it must never reuse rebindError's copy or flow.
			refreshError =
				'Rebind succeeded, but the view could not refresh. Reload the page to see the latest metamodel.';
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col gap-2 p-2">
	{#if ed.phase === 'loading' || ed.phase === 'idle'}
		<p class="text-sm text-muted-foreground">Loading metamodel…</p>
	{:else if ed.phase === 'error'}
		<div class="flex flex-col items-start gap-2">
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-sm text-destructive"
			>
				Couldn't load the metamodel: {ed.loadError}
			</p>
			<Button size="sm" variant="outline" onclick={() => void init()}>Retry</Button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<div
				class="flex items-center gap-0.5 rounded border border-border bg-card p-0.5"
				role="group"
				aria-label="Metamodel surface"
			>
				{#each SURFACES as opt (opt.id)}
					<button
						type="button"
						class="rounded px-2 py-0.5 text-[11px] {surface === opt.id
							? 'bg-primary text-primary-foreground'
							: 'text-muted-foreground hover:text-foreground'}"
						aria-pressed={surface === opt.id}
						onclick={() => setMetamodelView(opt.id)}
					>
						{opt.label}
					</button>
				{/each}
			</div>
			{#if isOwner}
				<Button
					size="sm"
					disabled={ed.previewing || ed.readOnly}
					aria-busy={ed.previewing}
					onclick={() => void previewMetamodelChanges()}
				>
					{ed.previewing ? 'Previewing…' : 'Preview changes'}
				</Button>
				<input
					class="rounded bg-card px-2 py-1 text-xs text-foreground"
					bind:value={message}
					placeholder="Commit message (optional)"
				/>
				<Button
					size="sm"
					disabled={!quiet || !ed.previewCurrent || ed.previewing || ed.rebinding || ed.readOnly}
					aria-busy={ed.rebinding}
					onclick={() => void onRebind()}
				>
					{ed.rebinding ? 'Rebinding…' : 'Rebind'}
				</Button>
				{#if ed.dirty}
					<!-- Disabled while a rebind is in flight: adopting the baseline
					     over the buffer has no coherent meaning while the buffer is
					     being bound, and the interleaving is better refused than
					     reconciled (the state module survives it either way). -->
					<Button size="sm" variant="ghost" disabled={ed.rebinding} onclick={discardMetamodelDraft}>
						Discard changes
					</Button>
				{/if}
			{:else}
				<p class="text-muted-foreground/70">
					The metamodel is read-only for your role — the diagram stays browsable.
				</p>
			{/if}
			{#if ed.source === 'serialized'}
				<span
					class="text-muted-foreground/70"
					title="No stored source; showing a re-serialized document"
				>
					re-serialized source
				</span>
			{/if}
		</div>

		{#if ed.lockedBy}
			<div
				class="flex items-center gap-2 rounded border border-warning/40 bg-warning/15 px-2 py-1.5 text-xs text-warning"
			>
				<span>Metamodel locked by {ed.lockedBy}. Your changes stay local until they finish.</span>
				<Button size="sm" variant="outline" onclick={retryMetamodelLease}>Retry</Button>
			</div>
		{/if}

		{#if ed.draftRestored}
			<p class="rounded border border-border bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
				Draft restored from your last session. “Discard changes” returns to the current metamodel.
			</p>
		{/if}

		{#if isOwner && !quiet && ed.dirty}
			<p class="text-xs text-warning">
				Commit or discard staged edits first — rebind needs a quiet project (no active locks).
			</p>
		{/if}

		<div class="min-h-0 flex-1">
			{#if surface === 'diagram'}
				<!-- The provider has to sit ABOVE the canvas component: `useSvelteFlow()`
				     resolves context where it is CALLED, and MetamodelDiagram's toolbar
				     calls it (Fit view, search pan) outside of `<SvelteFlow>`. -->
				<SvelteFlowProvider>
					<MetamodelDiagram />
				</SvelteFlowProvider>
			{:else}
				<MetamodelYamlEditor
					code={ed.buffer}
					errors={ed.lintErrors}
					readOnly={ed.readOnly}
					onChange={editMetamodelBuffer}
				/>
			{/if}
		</div>

		{#if stripError}
			<p
				class="max-h-24 overflow-auto whitespace-pre-wrap rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{stripError.message}
			</p>
		{/if}

		{#if ed.rebindError}
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{ed.rebindError}
			</p>
		{/if}

		{#if ed.previewError}
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{ed.previewError}
			</p>
		{/if}

		{#if refreshError}
			<p class="rounded border border-warning/40 bg-warning/15 px-2 py-1.5 text-xs text-warning">
				{refreshError}
			</p>
		{/if}

		{#if ed.preview}
			<div class="max-h-72 overflow-auto border-t border-border pt-2">
				{#if !ed.previewCurrent}
					<p class="mb-1 text-[10px] text-muted-foreground/70">
						The buffer changed since this preview — re-run Preview before rebinding.
					</p>
				{/if}
				<MetamodelPreviewPanel diff={ed.preview} />
			</div>
		{/if}
	{/if}
</div>
