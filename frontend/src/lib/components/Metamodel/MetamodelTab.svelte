<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import MetamodelYamlEditor from './MetamodelYamlEditor.svelte';
	import MetamodelPreviewPanel from './MetamodelPreviewPanel.svelte';
	import { getMetamodel as fetchMetamodel } from '$lib/api/metamodel';
	import type { Issue } from '$lib/api/types';
	import {
		closeMetamodelEditor,
		commitMetamodelRebind,
		discardMetamodelDraft,
		editMetamodelBuffer,
		getActiveProjectId,
		getMetamodelEditor,
		getRole,
		initMetamodelEditor,
		isProjectQuiet,
		previewMetamodelChanges,
		refreshSummary,
		retryMetamodelLease,
		setOverlay,
		setMetamodel
	} from '$lib/state';

	const ed = $derived(getMetamodelEditor());
	const isOwner = $derived(getRole() === 'owner');
	// Same shared quiet rule as history Revert / the old swap drawer.
	const quiet = $derived(isProjectQuiet());
	/** First message-only lint error (no line anchor) for the strip below the
	 * editor; positioned errors render in the gutter instead. */
	const stripError = $derived(ed.lintErrors.find((e) => e.line === null) ?? null);

	let message = $state('');
	/** The rebind itself already succeeded by the time this can fire — the
	 * copy below must never read as a failed rebind, only as a stale view. */
	let refreshError = $state<string | null>(null);

	function init(): void {
		const pid = getActiveProjectId();
		if (pid !== null) void initMetamodelEditor(pid);
	}

	onMount(() => {
		init();
		// Unmount without a close transition must release the lease too — the
		// old drawer's known leak, fixed here by pairing mount with teardown.
		return () => closeMetamodelEditor();
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
		try {
			const mm = await fetchMetamodel();
			setMetamodel(mm);
			setOverlay(res.issues.map(toIssue));
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
			<Button size="sm" variant="outline" onclick={init}>Retry</Button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-xs">
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
					disabled={!quiet || !ed.previewCurrent || ed.rebinding || ed.readOnly}
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
					The metamodel is read-only for your role. Only an owner can edit and rebind.
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
			<MetamodelYamlEditor
				code={ed.buffer}
				errors={ed.lintErrors}
				readOnly={ed.readOnly}
				onChange={editMetamodelBuffer}
			/>
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
