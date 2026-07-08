<script lang="ts">
	import { canEdit, ensureDraft, getDraft, getSaveConflict, reloadDraft, saveDraft, setDraftName } from '$lib/state';
	import NavigationNode from './NavigationNode.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureDraft(tabId);
	});
	const draft = $derived(getDraft(tabId));
	const conflict = $derived(getSaveConflict(tabId));
	const editable = $derived(canEdit());
	let saveError = $state<string | null>(null);

	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	// Save-as (a distinct saved copy under a new name) is wired in Task 7; for
	// now it just saves in place so the button is functional.
	async function saveAs(): Promise<void> {
		await save();
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-zinc-500">Loading…</p>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
			<input
				class="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setDraftName(tabId, e.currentTarget.value)}
			/>
			{#if editable}
				<div class="ml-auto flex items-center gap-2">
					<button
						type="button"
						class="rounded bg-emerald-700 px-2 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-40"
						disabled={!draft.dirty && draft.artifactId !== null}
						onclick={() => void save()}
					>
						Save{draft.dirty ? ' *' : ''}
					</button>
					<button
						type="button"
						class="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
						onclick={() => void saveAs()}
					>
						Save as…
					</button>
				</div>
			{/if}
		</div>
		{#if conflict !== undefined}
			<div class="flex items-center gap-2 bg-amber-950/60 px-3 py-1.5 text-xs text-amber-300">
				Someone else modified this navigation.
				<button type="button" class="underline" onclick={() => void reloadDraft(tabId)}>
					Reload their version
				</button>
			</div>
		{/if}
		{#if saveError}
			<p class="px-3 py-1 text-xs text-red-400">{saveError}</p>
		{/if}
		<div class="min-h-0 flex-1 overflow-auto p-3">
			<NavigationNode {tabId} path={[]} />
		</div>
	</div>
{/if}
