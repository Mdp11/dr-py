<script lang="ts">
	import { models as modelsApi } from '$lib/api';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		getBaseline,
		getDiff,
		getWorkingModel,
		resetOps,
		setBaseline
	} from '$lib/state';
	import { useQueryClient } from '@tanstack/svelte-query';
	import { saveCurrentModel, type SaveResult } from '$lib/state/save';
	import DiffRow from './DiffRow.svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	const queryClient = useQueryClient();

	const diff = $derived(getDiff());
	const baseline = $derived(getBaseline());
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

	function close(): void {
		open = false;
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) {
			lastResult = null;
		}
	}

	async function refetchAndReset(name: string): Promise<void> {
		const fresh = await queryClient.fetchQuery({
			queryKey: ['models', name],
			queryFn: () => modelsApi.getModel(name)
		});
		setBaseline(fresh);
		resetOps();
	}

	async function onSaveClick(): Promise<void> {
		if (!baseline) return;
		saving = true;
		lastResult = null;
		try {
			const result = await saveCurrentModel(baseline, getWorkingModel());
			lastResult = result;
			if (result.ok) {
				await refetchAndReset(baseline.name);
				open = false;
			}
		} finally {
			saving = false;
		}
	}

	async function onReloadFromServer(): Promise<void> {
		if (!baseline) return;
		const ok = window.confirm(
			'Discard all local changes and reload the latest version from the server?'
		);
		if (!ok) return;
		saving = true;
		try {
			await refetchAndReset(baseline.name);
			lastResult = null;
			open = false;
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
				Review the changes that will be saved to{' '}
				<span class="font-mono">{baseline?.name ?? '—'}</span>
				(rev {baseline?.rev ?? '—'}).
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
				{#if lastResult.kind === 'conflict'}
					<p>
						The model was changed on the server (rev mismatch). Reload to discard your
						local changes and pick up the server version, or close and keep editing
						locally.
					</p>
					<div>
						<Button
							size="sm"
							variant="outline"
							onclick={onReloadFromServer}
							disabled={saving}
						>
							Reload from server
						</Button>
					</div>
				{:else}
					<p>Save failed: {lastResult.message}</p>
				{/if}
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
