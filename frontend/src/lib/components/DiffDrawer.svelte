
<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		clearIssues,
		getBaseline,
		getDiff,
		getFileHandle,
		getFilename,
		getIssues,
		getWorkingModel,
		indexIssues,
		resetOps,
		setBaseline,
		setFileHandle,
		setFilename
	} from '$lib/state';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { AlertTriangle } from '@lucide/svelte';
	import { saveCurrentModel, type SaveResult } from '$lib/state/save';
	import DiffRow from './DiffRow.svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	const diff = $derived(getDiff());
	const baseline = $derived(getBaseline());
	const filename = $derived(getFilename());
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
	let lastResult: SaveResult | null = $state(null);

	const issueIndex = $derived(indexIssues(getIssues()));
	const pendingEntityIds = $derived.by(() => {
		const ids = new Set<string>();
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
			lastResult = null;
		}
	}

	async function onSaveClick(): Promise<void> {
		if (!baseline) return;
		saving = true;
		lastResult = null;
		try {
			const result = await saveCurrentModel(getWorkingModel());
			lastResult = result;
			if (!result.ok) return;

			const suggested = filename ?? 'model.json';
			const saved = await saveJsonToFile(result.model, suggested, getFileHandle());
			setBaseline(result.model);
			setFilename(saved.filename);
			setFileHandle(saved.handle);
			resetOps();
			clearIssues();
			open = false;
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') {
				// User cancelled the save dialog; treat as no-op.
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			lastResult = { ok: false, kind: 'api', message };
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={onOpenChange}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>
				Pending changes
				<span class="ml-2 font-mono text-xs font-normal text-zinc-400">({total})</span>
			</Dialog.Title>
			<Dialog.Description>
				Review the changes to be saved. The model will be written to{' '}
				<span class="font-mono">{filename ?? 'a new file'}</span>.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex max-h-[60vh] flex-col gap-3 overflow-y-auto pr-1">
			{#if total === 0}
				<p class="text-xs text-zinc-500">No pending changes.</p>
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

		{#if lastResult && !lastResult.ok}
			<div
				class="flex flex-col gap-2 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200"
				role="alert"
			>
				<p>Save failed: {lastResult.message}</p>
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

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={close} disabled={saving}>
				Cancel
			</Button>
			<Button
				type="button"
				class="bg-red-600 text-white hover:bg-red-500"
				onclick={onSaveClick}
				disabled={saving || total === 0 || !baseline}
			>
				{saving ? 'Saving...' : `Save (${total})`}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
