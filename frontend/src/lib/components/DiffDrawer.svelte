<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		artifactHeaderById,
		getStagedArtifactEntries,
		getStagedDiff,
		getStagedViewDepth,
		getStagedViewEntries,
		markEditorLockDenied,
		previewStaged,
		commitStaged,
		discardAll,
		discardArtifact,
		discardElement,
		discardViewChanges,
		getEffectiveIssues,
		indexIssues,
		getView,
		getViewFileHandle,
		getViewFilename,
		reacquireOpenArtifactLeases,
		setViewFileHandle,
		setViewFilename,
		type Diff,
		type StagedArtifactEntry
	} from '$lib/state';
	import { ConflictError } from '$lib/api/errors';
	import type { ArtifactKind } from '$lib/artifacts/kinds';
	import type { PreviewResponse } from '$lib/api/types';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { AlertTriangle } from '@lucide/svelte';
	import DiffRow from './DiffRow.svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	let loading = $state(false);

	// On open: validate the staged batch against the live rev so the footer can
	// gate Commit on conformance errors / structural blockers. The diff itself
	// is computed locally from the staged buffer (no server round-trip), but the
	// preview's issue counts come from the server. The body runs untracked so
	// reading store internals before the first await does not re-trigger the
	// effect; the seq guard drops stale responses on rapid close/reopen.
	let loadSeq = 0;
	let preview = $state<PreviewResponse | null>(null);
	let previewError: string | null = $state(null);

	$effect(() => {
		if (!open) return;
		const seq = ++loadSeq;
		loading = true;
		preview = null;
		previewError = null;
		untrack(() => {
			void (async () => {
				try {
					const p = await previewStaged();
					if (seq !== loadSeq) return;
					preview = p;
				} catch (err) {
					if (seq !== loadSeq) return;
					previewError = err instanceof Error ? err.message : String(err);
				} finally {
					if (seq === loadSeq) loading = false;
				}
			})();
		});
	});

	const diff = $derived<Diff>(getStagedDiff());
	// Staged ARTIFACT ops (navigations, tables, code snippets) ride in the same
	// `POST /commits` batch as the model ops, so they count towards the same
	// total. This is not cosmetic: `commitStaged` throws on an empty batch (an
	// empty commit orphans its lock tokens server-side — see its guard), so the
	// artifact-inclusive total is what keeps the Commit button reachable for an
	// artifact-ONLY batch and unreachable when nothing at all is staged.
	const artifactEntries = $derived<StagedArtifactEntry[]>(getStagedArtifactEntries());
	const artifactCount = $derived(artifactEntries.length);
	// Staged VIEW ops (folder/element/artifact-ref placement) ride in the same
	// commit batch too (artefacts revamp Phase 2) — same reasoning as the
	// artifact count above: a view-only batch must still reach a live Commit
	// button, so its journal depth folds into the same total.
	const total = $derived(
		diff.counts.added +
			diff.counts.modified +
			diff.counts.deleted +
			artifactCount +
			getStagedViewDepth()
	);

	const addedElements = $derived(diff.elements.filter((d) => d.status === 'added'));
	const modifiedElements = $derived(diff.elements.filter((d) => d.status === 'modified'));
	const deletedElements = $derived(diff.elements.filter((d) => d.status === 'deleted'));
	const addedRels = $derived(diff.relationships.filter((d) => d.status === 'added'));
	const modifiedRels = $derived(diff.relationships.filter((d) => d.status === 'modified'));
	const deletedRels = $derived(diff.relationships.filter((d) => d.status === 'deleted'));

	const addedCount = $derived(addedElements.length + addedRels.length);
	const modifiedCount = $derived(modifiedElements.length + modifiedRels.length);
	const deletedCount = $derived(deletedElements.length + deletedRels.length);

	// --- staged artifact rows -------------------------------------------------
	// Display-only projections of a `StagedArtifactEntry`. The three kinds carry
	// their display name in three different places BY DESIGN (see the store):
	//   - create: the staged name (nothing exists server-side to look up);
	//   - update: NO header — resolved through the overlay-aware
	//     `artifactHeaderById`, which reports a staged rename and knows temp ids;
	//   - delete: the COMMITTED header, so an artifact that was renamed and then
	//     deleted shows the name the server actually holds, not one that only
	//     ever existed in this client's buffer.
	// Deliberately LOCAL values, not `$lib/artifacts/kinds`' KIND_LABEL: these
	// are lowercase nouns that read inline inside a sentence ("new code
	// snippet"), not the shared title-case display labels ("Snippet") used by
	// sidebar/section headers and badges — the two vocabularies solve
	// different display problems and their values must not be unified. The
	// TYPE is still shared so this map stays exhaustive over every artifact
	// kind: adding a kind to `ArtifactKind` will fail `frontend-check` right
	// here until this map (and its prose) grows to match, rather than
	// silently leaving `e.artifactKind` able to miss it.
	const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
		navigation: 'navigation',
		table: 'table',
		code_snippet: 'code snippet'
	};

	function artifactEntryId(e: StagedArtifactEntry): string {
		return e.kind === 'create' ? e.tempId : e.id;
	}

	function artifactEntryName(e: StagedArtifactEntry): string {
		switch (e.kind) {
			case 'create':
				return e.name;
			case 'update':
				return artifactHeaderById(e.id)?.name ?? e.id;
			case 'delete':
				return e.header.name;
		}
	}

	function artifactEntryNote(e: StagedArtifactEntry): string {
		switch (e.kind) {
			case 'create':
				return `new ${ARTIFACT_KIND_LABEL[e.artifactKind]}`;
			case 'update':
				return 'edited';
			case 'delete':
				return 'deleted';
		}
	}

	// Same glyph vocabulary as DiffRow, so an artifact row reads like an entity row.
	function artifactGlyph(e: StagedArtifactEntry): string {
		return e.kind === 'create' ? '+' : e.kind === 'update' ? '~' : '-';
	}

	function artifactGlyphClass(e: StagedArtifactEntry): string {
		return e.kind === 'create'
			? 'text-success'
			: e.kind === 'update'
				? 'text-warning'
				: 'text-destructive';
	}

	let message = $state('');
	let committing = $state(false);
	let commitError: string | null = $state(null);
	const errorCount = $derived(preview?.conformance_error_count ?? 0);
	const structuralBlockers = $derived(preview?.structural_blockers ?? []);
	const wouldBlock = $derived(preview?.would_block ?? false);
	const commitBlocked = $derived(structuralBlockers.length > 0 || wouldBlock);

	const issueIndex = $derived(indexIssues(getEffectiveIssues()));
	const pendingEntityIds = $derived.by(() => {
		const ids = new SvelteSet<string>();
		for (const d of diff.elements) ids.add(d.id);
		for (const d of diff.relationships) ids.add(d.id);
		return ids;
	});
	const pendingIssueCount = $derived.by(() => {
		let n = 0;
		for (const id of pendingEntityIds) {
			const arr = issueIndex.byEntity.get(id);
			if (arr) n += arr.length;
		}
		return n;
	});

	// Tab state
	let activeTab = $state<'model' | 'view'>('model');

	const view = $derived(getView());
	// The staged view-op JOURNAL (artefacts revamp Phase 2 / Task 8), not a
	// baseline diff: entries carry a pre-baked `label` string captured at
	// stage time (see view-edits.svelte.ts's docstring for why — a deleted or
	// renamed folder's prior name is unrecoverable from the blob after the
	// optimistic apply), so the View tab renders them verbatim, in journal
	// order, with no name resolution needed here.
	const viewEntries = $derived(getStagedViewEntries());
	const viewFilename = $derived(getViewFilename());

	// Save-view state and handler
	let savingView = $state(false);
	let viewSaveError: string | null = $state(null);

	async function onSaveViewClick(): Promise<void> {
		const current = getView();
		if (current === null) return;
		savingView = true;
		viewSaveError = null;
		try {
			const suggested = viewFilename ?? `${current.name || 'view'}.view.json`;
			const res = await saveJsonToFile(current, suggested, getViewFileHandle());
			setViewFilename(res.filename);
			if (res.handle) setViewFileHandle(res.handle);
		} catch (err) {
			// AbortError = user cancelled the picker.
			if (err instanceof DOMException && err.name === 'AbortError') return;
			viewSaveError = err instanceof Error ? err.message : String(err);
		} finally {
			savingView = false;
		}
	}

	// The View tab's ONE discard button (Decision 5 — see the comment beside
	// the artifact rows' per-row `discardArtifact` above for why the journal
	// gets no per-row equivalent). All-or-nothing: wipes the whole staged
	// view-op journal, releases its folder leases, and refetches server truth.
	async function onDiscardViewChanges(): Promise<void> {
		await discardViewChanges();
	}

	function close(): void {
		open = false;
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) {
			loadSeq += 1; // invalidate any in-flight open-load
			preview = null;
			previewError = null;
			commitError = null;
			viewSaveError = null;
			activeTab = 'model';
		}
	}

	/**
	 * Commit failures the user can act on. The backend answers every commit
	 * conflict as a 409 with a `{detail: <string>, …}` body, which `api/errors.ts`
	 * parks verbatim on `ConflictError.body`; the details are engine vocabulary
	 * ("required lock not held", "stale base_rev") that says nothing about what to
	 * do next. Anything unmapped falls through to the error's own message — for an
	 * ApiError that is already `messageFromBody`'s `detail`, so a server detail we
	 * do not recognise still reaches the user unchanged.
	 *
	 * Lives in the component rather than in `checkout.svelte.ts` because it is
	 * user-facing copy for THIS surface, and the drawer is the only caller of
	 * `commitStaged`.
	 */
	function friendlyCommitError(err: unknown): string {
		if (err instanceof ConflictError) {
			const detail = (err.body as { detail?: unknown } | null | undefined)?.detail;
			if (detail === 'required lock not held')
				return 'A required lock expired or was released. Close and re-open the affected editor, then commit again.';
			if (detail === 'conflicting concurrent commits')
				return 'Someone else committed overlapping changes. Reload the project to see them, then commit again.';
			if (detail === 'stale base_rev')
				return 'The project moved ahead of this session. Reload and try again.';
		}
		return err instanceof Error ? err.message : String(err);
	}

	async function onCommitClick(): Promise<void> {
		committing = true;
		commitError = null;
		try {
			// errorCount > 0 ⇒ ack_errors (the user clicked Commit anyway)
			await commitStaged(message, errorCount > 0);
			message = '';
			open = false;
			// `POST /commits` RELEASES every lock token it is sent, and the batch
			// sends the token of every artifact it touches — so each still-open
			// editor whose artifact was in the batch just lost its lease server-side
			// while the client registry still believes it holds one. Re-check-out
			// every open artifact tab (ALREADY-SAVED ones too, not just the creates
			// this commit gave real ids to). Best effort: a peer may have grabbed one
			// in between, and `markEditorLockDenied` flips that tab read-only with its
			// editor's holder banner rather than failing the sweep.
			//
			// The `.catch` is load-bearing: the sweep bottoms out in `ensureCheckout`,
			// which RETHROWS anything that is not a lock conflict, so a 500 mid-sweep
			// would otherwise escape this fire-and-forget call as an unhandled
			// rejection. It must NOT become `commitError` either — the commit itself
			// succeeded and is durable; only the re-check-out failed.
			void reacquireOpenArtifactLeases(markEditorLockDenied).catch(() => {});
		} catch (err) {
			commitError = friendlyCommitError(err);
		} finally {
			committing = false;
		}
	}

	async function onDiscardAll(): Promise<void> {
		await discardAll();
		open = false;
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide"
				>Commit changes</Dialog.Title
			>
			<Dialog.Description>Review and commit your local edits.</Dialog.Description>
		</Dialog.Header>

		<Tabs.Root bind:value={activeTab} class="flex flex-col gap-3">
			<Tabs.List class="h-8">
				<!-- "Changes", not "Model": this tab now also lists staged ARTIFACT ops,
				     which commit in the same batch but are not model content. -->
				<Tabs.Trigger value="model" class="h-7 text-xs">Changes ({total})</Tabs.Trigger>
				<Tabs.Trigger value="view" class="h-7 text-xs" disabled={view === null}>
					View ({viewEntries.length})
				</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="model" class="flex flex-col gap-3">
				<div class="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
					{#if loading}
						<p class="text-xs text-muted-foreground/70">Loading changes…</p>
					{:else if total === 0}
						<p class="text-xs text-muted-foreground/70">No pending changes.</p>
					{:else if addedCount === 0 && modifiedCount === 0 && deletedCount === 0 && artifactCount === 0}
						<!-- Unlike an artifact-only batch (whose Artifacts section renders
						     right here), a view-only batch has nothing to show on THIS tab —
						     the journal only renders on the View tab. Without this branch
						     the pane would sit fully blank while the tab label and the
						     Commit button both show a nonzero count. -->
						<p class="text-xs text-muted-foreground/70">
							{viewEntries.length} staged view change{viewEntries.length === 1 ? '' : 's'} — see the View
							tab.
						</p>
					{/if}

					{#if addedCount > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-xs font-semibold text-success">Added ({addedCount})</h3>
							{#each addedElements as d (d.id)}
								<DiffRow diff={d} kind="element" onDiscard={(id) => void discardElement(id)} />
							{/each}
							{#each addedRels as d (d.id)}
								<DiffRow diff={d} kind="relationship" />
							{/each}
						</section>
					{/if}

					{#if modifiedCount > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-xs font-semibold text-warning">Modified ({modifiedCount})</h3>
							{#each modifiedElements as d (d.id)}
								<DiffRow diff={d} kind="element" onDiscard={(id) => void discardElement(id)} />
							{/each}
							{#each modifiedRels as d (d.id)}
								<DiffRow diff={d} kind="relationship" />
							{/each}
						</section>
					{/if}

					{#if deletedCount > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-xs font-semibold text-destructive">Deleted ({deletedCount})</h3>
							{#each deletedElements as d (d.id)}
								<DiffRow diff={d} kind="element" onDiscard={(id) => void discardElement(id)} />
							{/each}
							{#each deletedRels as d (d.id)}
								<DiffRow diff={d} kind="relationship" />
							{/each}
						</section>
					{/if}

					{#if artifactCount > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-xs font-semibold text-info">Artifacts ({artifactCount})</h3>
							{#each artifactEntries as e (artifactEntryId(e))}
								<div
									class="flex items-center gap-2 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs"
								>
									<span class="w-3 font-mono {artifactGlyphClass(e)}" aria-label={e.kind}
										>{artifactGlyph(e)}</span
									>
									<span class="font-mono text-foreground">{artifactEntryName(e)}</span>
									<span
										class="rounded border border-input bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
									>
										{artifactEntryNote(e)}
									</span>
									<span class="ml-auto font-mono text-[10px] text-muted-foreground/70"
										>{artifactEntryId(e)}</span
									>
									<!-- `discardArtifact`, never the raw `revertStagedArtifact`: this
									     is the artifact sibling of the element rows' `discardElement`
									     above, and it is the only path that also hands the `art:` lease
									     back. Un-staging the entry alone strands the lease for the full
									     TTL (worst for a sidebar Delete's DELETE-intent exclusive, which
									     blocks every peer from even opening the artifact).

									     Deliberate CONTRAST with the View tab below: element/artifact
									     rows each get their own per-row discard because unstaging one
									     is sound in isolation. The staged VIEW-op journal is
									     ORDER-DEPENDENT (e.g. create_folder, then place_element into
									     it, then rename_folder) — plucking one entry out of the middle
									     can leave the rest referencing an id that no longer exists, so
									     the View tab offers only the all-or-nothing
									     `discardViewChanges()`, never a per-row button. -->
									<button
										type="button"
										class="rounded border border-input px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
										onclick={() => void discardArtifact(artifactEntryId(e))}
									>
										Discard
									</button>
								</div>
							{/each}
						</section>
					{/if}
				</div>

				{#if previewError}
					<div
						class="flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive"
						role="alert"
					>
						<p>Failed to preview changes: {previewError}</p>
					</div>
				{/if}

				{#if commitError}
					<div
						class="flex flex-col gap-2 rounded border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive"
						role="alert"
					>
						<p>Commit failed: {commitError}</p>
					</div>
				{/if}

				{#if pendingIssueCount > 0}
					<div
						class="flex items-center gap-1.5 rounded border border-warning/40 bg-warning/15 px-2 py-1 text-[11px] text-warning"
					>
						<AlertTriangle class="h-3 w-3" />
						<span>
							{pendingIssueCount}
							{pendingIssueCount === 1 ? 'issue' : 'issues'} among pending changes
						</span>
					</div>
				{/if}

				{#if errorCount > 0 && !wouldBlock}
					<div
						class="flex items-center gap-1.5 rounded border border-warning/40 bg-warning/15 px-2 py-1 text-[11px] text-warning"
					>
						<AlertTriangle class="h-3 w-3" />
						<span
							>{errorCount} validation {errorCount === 1 ? 'issue' : 'issues'} — you can commit anyway
							or review on the Issues tab.</span
						>
					</div>
				{/if}
				{#if wouldBlock}
					<div
						class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1 text-[11px] text-destructive"
						role="alert"
					>
						Strict mode is on: {errorCount} validation {errorCount === 1 ? 'issue' : 'issues'} must be
						resolved before committing.
					</div>
				{/if}
				{#if structuralBlockers.length > 0}
					<div
						class="rounded border border-destructive/40 bg-destructive/15 px-2 py-1 text-[11px] text-destructive"
						role="alert"
					>
						Commit blocked: {structuralBlockers.length} structural problem(s) must be fixed first.
					</div>
				{/if}
				<label class="flex flex-col gap-1 text-xs text-foreground/80">
					Commit message
					<input
						class="h-7 rounded border border-border bg-card px-2 text-xs text-foreground outline-none focus:border-ring"
						bind:value={message}
						placeholder="(optional)"
						disabled={committing}
					/>
				</label>
			</Tabs.Content>

			<Tabs.Content value="view">
				<div class="flex max-h-[60vh] flex-col gap-1 overflow-y-auto pr-1">
					{#if view === null}
						<p class="text-xs text-muted-foreground/70">No view loaded.</p>
					{:else if viewEntries.length === 0}
						<p class="text-xs text-muted-foreground/70">No view changes.</p>
					{:else}
						{#each viewEntries as entry, i (i)}
							<p class="rounded bg-card px-2 py-1 font-mono text-[11px]">{entry.label}</p>
						{/each}
					{/if}
					{#if viewSaveError}
						<div
							class="mt-1 rounded border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive"
							role="alert"
						>
							Save view failed: {viewSaveError}
						</div>
					{/if}
				</div>
			</Tabs.Content>
		</Tabs.Root>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={close} disabled={committing || savingView}>
				Cancel
			</Button>
			{#if activeTab === 'view'}
				<Button
					type="button"
					variant="ghost"
					onclick={() => void onDiscardViewChanges()}
					disabled={savingView || viewEntries.length === 0}
				>
					Discard view changes
				</Button>
				<Button
					type="button"
					onclick={onSaveViewClick}
					disabled={savingView || view === null || viewEntries.length === 0}
				>
					{savingView ? 'Saving...' : 'Save view'}
				</Button>
			{:else}
				<Button
					type="button"
					variant="ghost"
					onclick={() => void onDiscardAll()}
					disabled={committing || total === 0}
				>
					Discard all
				</Button>
				<Button
					type="button"
					onclick={() => void onCommitClick()}
					disabled={committing || total === 0 || commitBlocked || loading || preview === null}
				>
					{committing
						? 'Committing…'
						: errorCount > 0 && !commitBlocked
							? `Commit anyway (${total})`
							: `Commit (${total})`}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
