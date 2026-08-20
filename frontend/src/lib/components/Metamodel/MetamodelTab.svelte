<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import { Button } from '$lib/components/ui/button';
	import MetamodelYamlEditor from './MetamodelYamlEditor.svelte';
	import MetamodelPreviewPanel from './MetamodelPreviewPanel.svelte';
	import MetamodelDiagram from './MetamodelDiagram.svelte';
	import {
		closeMetamodelDiagram,
		closeMetamodelEditor,
		closeMetamodelPanel,
		discardMetamodelDraft,
		discardStagedNodeMoves,
		editMetamodelBuffer,
		getActiveProjectId,
		getMetamodelDiagramView,
		getMetamodelEditor,
		getRole,
		getStagedNodeMoves,
		initMetamodelDiagram,
		initMetamodelEditor,
		initMetamodelPanel,
		previewMetamodelChanges,
		retryMetamodelLease,
		setMetamodelView
	} from '$lib/state';

	const ed = $derived(getMetamodelEditor());
	/** Which surface the tab shows. Owned by the diagram state module (it
	 * persists the choice per project), so the toggle below is a pure command. */
	const surface = $derived(getMetamodelDiagramView().view);
	const isOwner = $derived(getRole() === 'owner');
	/** The moves half of the staged metamodel family. It lives in the stage
	 * module rather than in this tab's editor, so it survives a close — which is
	 * why the hint and the discard below have to read it separately from
	 * `ed.dirty`. */
	const stagedMoveCount = $derived(getStagedNodeMoves().size);
	/** First message-only lint error (no line anchor) for the strip below the
	 * editor; positioned errors render in the gutter instead. */
	const stripError = $derived(ed.lintErrors.find((e) => e.line === null) ?? null);

	/** `as const` so the ids stay the literal union `setMetamodelView` takes. */
	const SURFACES = [
		{ id: 'yaml', label: 'YAML' },
		{ id: 'diagram', label: 'Diagram' }
	] as const;

	/** The diagram init is CHAINED, not raced: it reads the editor's buffer to
	 * auto-arrange a never-arranged metamodel, so an empty buffer would leave it
	 * with nothing to place (see initMetamodelDiagram's docstring).
	 *
	 * The panel preferences go FIRST, before either await: they are a
	 * synchronous localStorage read that depends on nothing being fetched, and
	 * restoring them after the round-trips meant a user who collapsed the panel
	 * watched it render expanded and snap shut once the metamodel landed. */
	async function init(): Promise<void> {
		const pid = getActiveProjectId();
		if (pid === null) return;
		initMetamodelPanel(pid);
		await initMetamodelEditor(pid);
		await initMetamodelDiagram(pid);
	}

	onMount(() => {
		void init();
		// Unmount without a close transition must release the lease too — the
		// old drawer's known leak, fixed here by pairing mount with teardown.
		// The diagram closes first: its teardown drops the peer-commit tap, and
		// the editor's close then decides the lease against what is still staged.
		return () => {
			closeMetamodelDiagram();
			closeMetamodelEditor();
			closeMetamodelPanel();
		};
	});

	/**
	 * ONE discard for the whole family, matching the commit drawer's Metamodel
	 * section button (and `discardAll`): the YAML draft and the staged node
	 * moves are staged TOGETHER into one batch, so they are abandoned together.
	 *
	 * MOVES FIRST, and that ordering is load-bearing — the same rule
	 * `discardAll` follows. `discardMetamodelDraft` ends in
	 * `void dropMetamodelLease()`, which reaches `releaseMetamodelLease`'s
	 * `getStagedMetamodelDepth() > 0` guard SYNCHRONOUSLY, before the next
	 * statement here runs. Discard the draft first and that guard still sees the
	 * staged moves, refuses the release, and strands the exclusive `mm` lease on
	 * a session with nothing staged — renewed by the checkout heartbeat for the
	 * rest of the session, with every peer locked out of the metamodel.
	 */
	function onDiscard(): void {
		discardStagedNodeMoves();
		discardMetamodelDraft();
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
				{#if ed.dirty}
					<!-- Rendered on `ed.dirty` alone, not on the staged depth: this is
					     the BUFFER's discard button, sitting beside the editor it
					     belongs to. A moves-only stage is discarded from the commit
					     drawer's Metamodel section, which owns the whole family.
					     Never disabled: the rebind-in-flight window it used to be
					     gated on no longer exists (a rebind is an op in the commit
					     batch), and a discard is safe against a commit either way —
					     `commitStaged` sends the blob it captured, not the buffer. -->
					<Button size="sm" variant="ghost" onclick={onDiscard}>Discard changes</Button>
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

		<!-- Where the Rebind button used to be. Metamodel edits are staged commit
		     content (spec 2026-08-16), so this tab has no commit control of its
		     own; both halves of the family arm the hint, since staged moves alone
		     are just as committable as a dirty buffer. -->
		{#if ed.dirty || stagedMoveCount > 0}
			<p class="text-xs text-muted-foreground">
				Metamodel changes are staged — review and commit them from the Commit drawer.
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

		{#if ed.previewError}
			<p
				class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1.5 text-xs text-destructive"
			>
				{ed.previewError}
			</p>
		{/if}

		{#if ed.preview}
			<div class="max-h-72 overflow-auto border-t border-border pt-2">
				{#if !ed.previewCurrent}
					<p class="mb-1 text-[10px] text-muted-foreground/70">
						The buffer changed since this preview — re-run Preview before committing.
					</p>
				{/if}
				<MetamodelPreviewPanel diff={ed.preview} />
			</div>
		{/if}
	{/if}
</div>
