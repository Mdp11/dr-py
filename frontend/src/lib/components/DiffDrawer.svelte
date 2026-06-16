<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		changesDocToDiff,
		flushNow,
		getFileHandle,
		getFilename,
		getIssues,
		getModelError,
		indexIssues,
		refreshChangesBadge,
		setFileHandle,
		setFilename,
		getView,
		getViewChanges,
		getViewChangesCount,
		getViewFilename,
		setViewFilename,
		setViewBaseline,
		getCachedElements,
		formatViewChange,
		type Diff
	} from '$lib/state';
	import type { ViewChange } from '$lib/state';
	import { downloadModel, getChanges } from '$lib/api/model-read';
	import type { ChangesDoc } from '$lib/api/types';
	import { downloadJsonFile, saveJsonToFile, saveResponseToFile } from '$lib/util/fileSave';
	import { elementDisplayName } from '$lib/util/element-name';
	import { getElement } from '$lib/api/elements';
	import { AlertTriangle } from '@lucide/svelte';
	import { saveWithOptionalCr } from '$lib/state/cr';
	import DiffRow from './DiffRow.svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	const filename = $derived(getFilename());

	let doc: ChangesDoc | null = $state(null);
	let loadError: string | null = $state(null);
	let loading = $state(false);

	// On open: push any locally queued ops to the server, then fetch the
	// server-computed change set (the session op log compacted into a CR doc).
	// `open` is the ONLY tracked dependency: the body runs untracked because
	// flushNow() synchronously reads store internals before its first await —
	// tracking those would re-run the effect (duplicate getChanges fetches).
	// The seq guard drops stale responses on rapid close/reopen.
	let loadSeq = 0;
	$effect(() => {
		if (!open) return;
		const seq = ++loadSeq;
		loading = true;
		loadError = null;
		untrack(() => {
			void (async () => {
				try {
					await flushNow();
					if (seq !== loadSeq) return;
					const err = getModelError();
					if (err !== null) {
						loadError = err.message;
						return;
					}
					const next = await getChanges();
					if (seq !== loadSeq) return;
					doc = next;

					// Best-effort: fetch display names for any view-change element ids
					// not already cached, so the View tab shows names rather than ids.
					const ids = new Set<string>();
					for (const c of getViewChanges()) {
						if (c.kind !== 'folder-added' && c.kind !== 'folder-removed') ids.add(c.id);
					}
					const cache = getCachedElements();
					for (const id of ids) {
						if (!cache.has(id)) void getElement(id).catch(() => undefined);
					}
				} catch (err) {
					if (seq !== loadSeq) return;
					loadError = err instanceof Error ? err.message : String(err);
				} finally {
					if (seq === loadSeq) loading = false;
				}
			})();
		});
	});

	const diff = $derived<Diff>(
		doc !== null
			? changesDocToDiff(doc)
			: { elements: [], relationships: [], counts: { added: 0, modified: 0, deleted: 0 } }
	);
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

	let saving = $state(false);
	let saveError: string | null = $state(null);
	let exportCr = $state(false);
	let crNotice: { kind: 'cancelled' | 'failed'; message: string } | null = $state(null);

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
	const viewChangeCount = $derived(getViewChangesCount());
	const viewFilename = $derived(getViewFilename());

	// Resolve element display names for the view preview from the model cache,
	// falling back to the raw id. Uncached ids are best-effort fetched on open.
	const resolveName = $derived((id: string): string => {
		const el = getCachedElements().get(id);
		return el ? elementDisplayName(el) : id;
	});

	function changeKey(c: ViewChange): string {
		if (c.kind === 'folder-added' || c.kind === 'folder-removed') {
			return `${c.kind}:${c.path.join('/')}`;
		}
		return `${c.kind}:${c.id}`;
	}

	const viewLines = $derived(
		viewChangeList.map((c) => ({ key: changeKey(c), text: formatViewChange(c, resolveName) }))
	);

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
			const res = await saveJsonToFile(current, suggested, getFileHandle());
			setViewFilename(res.filename);
			if (res.handle) setFileHandle(res.handle);
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
			doc = null;
			loadError = null;
			saveError = null;
			crNotice = null;
			exportCr = false;
			viewSaveError = null;
			activeTab = 'model';
		}
	}

	async function onSaveClick(): Promise<void> {
		saving = true;
		saveError = null;
		crNotice = null;
		try {
			// gate on a clean flush so the download reflects every local edit
			await flushNow();
			const storeError = getModelError();
			if (storeError !== null) {
				saveError = storeError.message;
				return;
			}

			const outcome = await saveWithOptionalCr({
				filename,
				fileHandle: getFileHandle(),
				exportCr,
				download: () => downloadModel(),
				fetchChanges: () => getChanges(),
				saveResponseFile: saveResponseToFile,
				// The CR sidecar downloads straight to the browser's download folder
				// (auto-composed name, no picker). A second showSaveFilePicker in the
				// same click would throw — the model save above already consumed this
				// gesture's transient user activation.
				saveFile: (value, name) => Promise.resolve(downloadJsonFile(value, name))
			});

			if (outcome.kind === 'save-failed') {
				saveError = outcome.message;
				return;
			}

			// All non-save-failed branches mean the model file was written.
			setFilename(outcome.savedFilename);
			setFileHandle(outcome.savedHandle);
			// NOTE: the server change set tracks changes since model LOAD, so it
			// intentionally survives a file save (it is what a CR export needs).
			refreshChangesBadge().catch(() => {
				// best-effort
			});

			if (outcome.kind === 'saved') {
				open = false;
				return;
			}
			if (outcome.kind === 'saved-cr-cancelled') {
				crNotice = {
					kind: 'cancelled',
					message: 'Model saved. CR export cancelled.'
				};
				return;
			}
			// saved-cr-failed
			crNotice = {
				kind: 'failed',
				message: `Model saved. CR export failed: ${outcome.message}`
			};
		} catch (err) {
			// saveWithOptionalCr should not throw for the AbortError case
			// (it's caught internally), but a non-Error throw or programmer
			// error should still surface as a save failure.
			saveError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>
				Pending changes
				<span class="ml-2 font-mono text-xs font-normal text-zinc-400">({total})</span>
			</Dialog.Title>
			<Dialog.Description>
				Review the changes to be saved. The model will be written to
				<span class="font-mono">{filename ?? 'a new file'}</span>.
			</Dialog.Description>
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
						<p class="text-xs text-zinc-500">Loading changes…</p>
					{:else if total === 0}
						<p class="text-xs text-zinc-500">No pending changes.</p>
					{/if}

					{#if doc !== null && !doc.complete}
						<div
							class="flex items-center gap-1.5 rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200"
						>
							<AlertTriangle class="h-3 w-3" />
							<span>Change history was truncated; this list covers the retained changes only.</span>
						</div>
					{/if}

					{#if addedCount > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-xs font-semibold text-emerald-300">Added ({addedCount})</h3>
							{#each addedElements as d (d.id)}
								<DiffRow diff={d} kind="element" />
							{/each}
							{#each addedRels as d (d.id)}
								<DiffRow diff={d} kind="relationship" />
							{/each}
						</section>
					{/if}

					{#if modifiedCount > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-xs font-semibold text-amber-300">Modified ({modifiedCount})</h3>
							{#each modifiedElements as d (d.id)}
								<DiffRow diff={d} kind="element" />
							{/each}
							{#each modifiedRels as d (d.id)}
								<DiffRow diff={d} kind="relationship" />
							{/each}
						</section>
					{/if}

					{#if deletedCount > 0}
						<section class="flex flex-col gap-1">
							<h3 class="text-xs font-semibold text-red-300">Deleted ({deletedCount})</h3>
							{#each deletedElements as d (d.id)}
								<DiffRow diff={d} kind="element" />
							{/each}
							{#each deletedRels as d (d.id)}
								<DiffRow diff={d} kind="relationship" />
							{/each}
						</section>
					{/if}
				</div>

				{#if loadError}
					<div
						class="flex flex-col gap-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200"
						role="alert"
					>
						<p>Failed to load changes: {loadError}</p>
					</div>
				{/if}

				{#if saveError}
					<div
						class="flex flex-col gap-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200"
						role="alert"
					>
						<p>Save failed: {saveError}</p>
					</div>
				{/if}

				{#if pendingIssueCount > 0}
					<div
						class="flex items-center gap-1.5 rounded border border-amber-900 bg-amber-950/30 px-2 py-1 text-[11px] text-amber-200"
					>
						<AlertTriangle class="h-3 w-3" />
						<span>
							{pendingIssueCount}
							{pendingIssueCount === 1 ? 'issue' : 'issues'} among pending changes
						</span>
					</div>
				{/if}

				{#if crNotice}
					<div
						class="rounded border px-3 py-2 text-xs {crNotice.kind === 'failed'
							? 'border-red-900 bg-red-950/40 text-red-200'
							: 'border-zinc-800 bg-zinc-900 text-zinc-200'}"
						role={crNotice.kind === 'failed' ? 'alert' : 'status'}
					>
						{crNotice.message}
					</div>
				{/if}

				<label class="flex items-center gap-2 text-xs text-zinc-300">
					<input
						type="checkbox"
						class="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-indigo-500 focus:ring-2 focus:ring-indigo-500"
						bind:checked={exportCr}
						disabled={saving}
					/>
					Export CR
				</label>
			</Tabs.Content>

			<Tabs.Content value="view">
				<div class="flex max-h-[60vh] flex-col gap-1 overflow-y-auto pr-1">
					{#if view === null}
						<p class="text-xs text-zinc-500">No view loaded.</p>
					{:else if viewLines.length === 0}
						<p class="text-xs text-zinc-500">No view changes.</p>
					{:else}
						{#each viewLines as line (line.key)}
							<p class="rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200">
								{line.text}
							</p>
						{/each}
					{/if}
					{#if viewSaveError}
						<div
							class="mt-1 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200"
							role="alert"
						>
							Save view failed: {viewSaveError}
						</div>
					{/if}
				</div>
			</Tabs.Content>
		</Tabs.Root>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={close} disabled={saving || savingView}>
				Cancel
			</Button>
			{#if activeTab === 'view'}
				<Button
					type="button"
					class="bg-red-600 text-white hover:bg-red-500"
					onclick={onSaveViewClick}
					disabled={savingView || view === null || viewChangeCount === 0}
				>
					{savingView ? 'Saving...' : 'Save view'}
				</Button>
			{:else}
				<Button
					type="button"
					class="bg-red-600 text-white hover:bg-red-500"
					onclick={onSaveClick}
					disabled={saving || loading || total === 0 || doc === null}
				>
					{saving ? 'Saving...' : `Save (${total})`}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
