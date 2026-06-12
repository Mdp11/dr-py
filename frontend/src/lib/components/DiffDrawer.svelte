<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
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
		type Diff
	} from '$lib/state';
	import { downloadModel, getChanges } from '$lib/api/model-read';
	import type { ChangesDoc } from '$lib/api/types';
	import { saveJsonToFile, saveResponseToFile } from '$lib/util/fileSave';
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
	$effect(() => {
		if (!open) return;
		loading = true;
		loadError = null;
		void (async () => {
			try {
				await flushNow();
				const err = getModelError();
				if (err !== null) {
					loadError = err.message;
					return;
				}
				doc = await getChanges();
			} catch (err) {
				loadError = err instanceof Error ? err.message : String(err);
			} finally {
				loading = false;
			}
		})();
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

	function close(): void {
		open = false;
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) {
			doc = null;
			loadError = null;
			saveError = null;
			crNotice = null;
			exportCr = false;
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
				saveFile: saveJsonToFile
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

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={close} disabled={saving}>Cancel</Button>
			<Button
				type="button"
				class="bg-red-600 text-white hover:bg-red-500"
				onclick={onSaveClick}
				disabled={saving || loading || total === 0 || doc === null}
			>
				{saving ? 'Saving...' : `Save (${total})`}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
