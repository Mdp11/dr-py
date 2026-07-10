<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		ensureElement,
		getStagedDiff,
		previewStaged,
		commitStaged,
		discardAll,
		discardElement,
		getIssues,
		indexIssues,
		getView,
		getViewChanges,
		getViewFileHandle,
		getViewFilename,
		setViewFileHandle,
		setViewFilename,
		setViewBaseline,
		getCachedElements,
		viewChangeSegments,
		type Diff,
		type ViewChange,
		type ViewChangeSegmentKind
	} from '$lib/state';
	import type { PreviewResponse } from '$lib/api/types';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { elementDisplayName } from '$lib/util/element-name';
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
	// We still best-effort prefetch view-change element names for the View tab.
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
			// Best-effort: fetch display names for any view-change element ids
			// not already cached, so the View tab shows names rather than ids.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const ids = new Set<string>();
			for (const c of getViewChanges()) {
				if (c.kind !== 'folder-added' && c.kind !== 'folder-removed') ids.add(c.id);
			}
			const cache = getCachedElements();
			for (const id of ids) {
				if (!cache.has(id)) void ensureElement(id);
			}
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
	const total = $derived(diff.counts.added + diff.counts.modified + diff.counts.deleted);

	const addedElements = $derived(diff.elements.filter((d) => d.status === 'added'));
	const modifiedElements = $derived(diff.elements.filter((d) => d.status === 'modified'));
	const deletedElements = $derived(diff.elements.filter((d) => d.status === 'deleted'));
	const addedRels = $derived(diff.relationships.filter((d) => d.status === 'added'));
	const modifiedRels = $derived(diff.relationships.filter((d) => d.status === 'modified'));
	const deletedRels = $derived(diff.relationships.filter((d) => d.status === 'deleted'));

	const addedCount = $derived(addedElements.length + addedRels.length);
	const modifiedCount = $derived(modifiedElements.length + modifiedRels.length);
	const deletedCount = $derived(deletedElements.length + deletedRels.length);

	let message = $state('');
	let committing = $state(false);
	let commitError: string | null = $state(null);
	const errorCount = $derived(preview?.conformance_error_count ?? 0);
	const structuralBlockers = $derived(preview?.structural_blockers ?? []);
	const wouldBlock = $derived(preview?.would_block ?? false);
	const commitBlocked = $derived(structuralBlockers.length > 0 || wouldBlock);

	const issueIndex = $derived(indexIssues(getIssues()));
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
	const viewChangeList = $derived(getViewChanges());
	const viewChangeCount = $derived(viewChangeList.length);
	const viewFilename = $derived(getViewFilename());

	// Resolve element display names for the view preview from the model cache,
	// falling back to the raw id. Uncached ids are best-effort fetched on open.
	const resolveName = (id: string): string => {
		const el = getCachedElements().get(id);
		return el ? elementDisplayName(el) : id;
	};

	function changeKey(c: ViewChange): string {
		if (c.kind === 'folder-added' || c.kind === 'folder-removed') {
			return `${c.kind}:${c.path.join('/')}`;
		}
		return `${c.kind}:${c.id}`;
	}

	const viewLines = $derived(
		viewChangeList.map((c) => ({ key: changeKey(c), segments: viewChangeSegments(c, resolveName) }))
	);

	// Tailwind colour per segment role, so each component of a change line stands
	// out: element name, folder, and the from/to prepositions.
	const SEGMENT_CLASS: Record<ViewChangeSegmentKind, string> = {
		element: 'text-success',
		folder: 'text-warning',
		prep: 'text-info',
		plain: 'text-muted-foreground'
	};

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
			// Rebaseline: the file now matches the live view, so the count drops to 0.
			setViewBaseline(current);
		} catch (err) {
			// AbortError = user cancelled the picker; leave the baseline untouched.
			if (err instanceof DOMException && err.name === 'AbortError') return;
			viewSaveError = err instanceof Error ? err.message : String(err);
		} finally {
			savingView = false;
		}
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

	async function onCommitClick(): Promise<void> {
		committing = true;
		commitError = null;
		try {
			// errorCount > 0 ⇒ ack_errors (the user clicked Commit anyway)
			await commitStaged(message, errorCount > 0);
			message = '';
			open = false;
		} catch (err) {
			commitError = err instanceof Error ? err.message : String(err);
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
				<Tabs.Trigger value="model" class="h-7 text-xs">Model ({total})</Tabs.Trigger>
				<Tabs.Trigger value="view" class="h-7 text-xs" disabled={view === null}>
					View ({viewChangeCount})
				</Tabs.Trigger>
			</Tabs.List>

			<Tabs.Content value="model" class="flex flex-col gap-3">
				<div class="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
					{#if loading}
						<p class="text-xs text-muted-foreground/70">Loading changes…</p>
					{:else if total === 0}
						<p class="text-xs text-muted-foreground/70">No pending changes.</p>
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
					{:else if viewLines.length === 0}
						<p class="text-xs text-muted-foreground/70">No view changes.</p>
					{:else}
						{#each viewLines as line (line.key)}
							<p class="rounded bg-card px-2 py-1 font-mono text-[11px]">
								{#each line.segments as seg, i (i)}<span class={SEGMENT_CLASS[seg.kind]}
										>{seg.text}</span
									>{/each}
							</p>
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
					onclick={onSaveViewClick}
					disabled={savingView || view === null || viewChangeCount === 0}
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
