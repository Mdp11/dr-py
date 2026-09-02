<script lang="ts">
	import { untrack } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import {
		getActiveViewId,
		getDeleteViewOpen,
		getStagedViewDepth,
		getViews,
		removeView,
		setDeleteViewOpen
	} from '$lib/state';

	// Local mirror of the store's open flag (see AddViewDialog).
	let open = $state(false);
	let selectedId = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);
	let gen = 0;

	const views = $derived(getViews());
	const activeId = $derived(getActiveViewId());
	const selected = $derived(views.find((v) => v.id === selectedId) ?? null);
	// Deleting the ACTIVE view drops any journal staged against it — say so.
	const dropsEdits = $derived(selectedId === activeId && getStagedViewDepth() > 0);

	// Tracks the open flag ONLY: the list and active id change as a direct
	// result of a successful delete, and re-running this on that change
	// would bump `gen` and skip the close below.
	$effect(() => {
		const isOpen = getDeleteViewOpen();
		untrack(() => {
			open = isOpen;
			gen++;
			error = null;
			busy = false;
			// Default to the active view, else the first listed.
			selectedId = isOpen ? (getActiveViewId() ?? getViews()[0]?.id ?? '') : '';
		});
	});

	async function onConfirm(): Promise<void> {
		if (selectedId === '') return;
		const g = gen;
		busy = true;
		error = null;
		try {
			await removeView(selectedId);
			if (g !== gen) return;
			setDeleteViewOpen(false);
		} catch (err) {
			if (g !== gen) return;
			// 409: a peer holds a lease on the view or one of its folders.
			error = err instanceof Error ? err.message : 'Could not delete the view.';
		} finally {
			if (g === gen) busy = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(v) => setDeleteViewOpen(v)}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">Delete view</Dialog.Title>
			<Dialog.Description>
				Removes the view and its folders for everyone. Model elements are not affected.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3 text-xs">
			<label class="flex flex-col gap-1">
				<span class="text-muted-foreground">View</span>
				<select
					data-testid="delete-view-select"
					bind:value={selectedId}
					class="rounded border border-input bg-card px-2 py-1 text-xs"
				>
					{#each views as v (v.id)}
						<option value={v.id}>{v.name}{v.id === activeId ? ' (active)' : ''}</option>
					{/each}
				</select>
			</label>
			{#if dropsEdits}
				<p role="alert" class="text-warning">
					This is your active view: your {getStagedViewDepth()} unsaved view
					{getStagedViewDepth() === 1 ? 'change' : 'changes'} will be discarded.
				</p>
			{/if}
			{#if error}
				<p data-testid="delete-view-error" role="alert" class="text-destructive">{error}</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => setDeleteViewOpen(false)}>Cancel</Button>
			<Button
				type="button"
				variant="destructive"
				data-testid="delete-view-submit"
				disabled={busy || selected === null}
				onclick={() => void onConfirm()}
			>
				Delete{selected ? ` "${selected.name}"` : ''}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
