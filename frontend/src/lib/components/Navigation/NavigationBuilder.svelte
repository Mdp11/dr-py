<script lang="ts">
	import {
		canEdit,
		ensureDraft,
		ensureTableDraft,
		getDraft,
		getSaveConflict,
		isRunnable,
		openArtifactTab,
		reloadDraft,
		saveAsDraft,
		saveDraft,
		setDraftName,
		updateTableDefinition
	} from '$lib/state';
	import { navigationAsTableDefinition } from '$lib/table/columns';
	import NavigationNode from './NavigationNode.svelte';
	import ResultsDock from './ResultsDock.svelte';
	import ResizeHandle from '$lib/components/ResizeHandle.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureDraft(tabId);
	});
	const draft = $derived(getDraft(tabId));
	const conflict = $derived(getSaveConflict(tabId));
	const editable = $derived(canEdit());
	let saveError = $state<string | null>(null);
	let dockHeight = $state(280);

	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function saveAs(): Promise<void> {
		if (!draft) return;
		const name = window.prompt('Save as', draft.name);
		if (!name) return; // cancelled, or an empty name
		saveError = null;
		try {
			await saveAsDraft(tabId, name);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function openAsTable(): Promise<void> {
		if (!draft) return;
		const id = openArtifactTab('table', {
			artifactId: null,
			title: draft.name ? `${draft.name} (table)` : 'Table'
		});
		await ensureTableDraft(id);
		updateTableDefinition(
			id,
			navigationAsTableDefinition({ artifactId: draft.artifactId, definition: draft.definition })
		);
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				data-testid="nav-name"
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setDraftName(tabId, e.currentTarget.value)}
			/>
			{#if draft.dirty}
				<span title="Unsaved changes" class="text-warning">●</span>
			{/if}
			<span class="flex-1"></span>
			<button
				type="button"
				class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
				disabled={!isRunnable(draft.definition)}
				onclick={() => void openAsTable()}
			>
				Open as table
			</button>
			{#if editable}
				<div class="flex items-center gap-2">
					<button
						type="button"
						class="rounded bg-primary px-2 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
						disabled={!draft.dirty && draft.artifactId !== null}
						onclick={() => void save()}
					>
						Save{draft.dirty ? ' *' : ''}
					</button>
					<button
						type="button"
						class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={() => void saveAs()}
					>
						Save as…
					</button>
				</div>
			{/if}
		</div>
		{#if conflict !== undefined}
			<div class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning">
				Someone else modified this navigation.
				<button type="button" class="underline" onclick={() => void reloadDraft(tabId)}>
					Reload their version
				</button>
			</div>
		{/if}
		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		<div class="flex min-h-0 flex-1 flex-col">
			<div class="min-h-0 flex-1 overflow-auto p-4">
				<div class="mx-auto max-w-[820px]">
					<NavigationNode {tabId} path={[]} />
				</div>
			</div>
			<ResizeHandle
				axis="y"
				value={dockHeight}
				min={120}
				max={640}
				onchange={(v) => (dockHeight = v)}
			/>
			<div class="flex-none" style="height:{dockHeight}px">
				<ResultsDock {tabId} />
			</div>
		</div>
	</div>
{/if}
