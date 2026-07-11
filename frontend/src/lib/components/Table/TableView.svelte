<script lang="ts">
	// The table tab root. Mirrors NavigationBuilder.svelte's shape (name input,
	// dirty dot, Save/Save as…, conflict banner) plus an Export button that
	// streams the current definition/artifact to an .xlsx download. Editing
	// (inline value cells, column manager) lands in later tasks — this is the
	// read-only surface: name/save/export chrome around `TableGrid`.
	import {
		canEdit,
		downloadTable,
		ensureTableDraft,
		getTableConflict,
		getTableDraft,
		reloadTableDraft,
		saveAsTableDraft,
		saveTableDraft,
		setTableName
	} from '$lib/state';
	import ColumnManager from './ColumnManager.svelte';
	import TableGrid from './TableGrid.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureTableDraft(tabId);
	});
	const draft = $derived(getTableDraft(tabId));
	const conflict = $derived(getTableConflict(tabId));
	const editable = $derived(canEdit());
	let saveError = $state<string | null>(null);

	async function save(): Promise<void> {
		saveError = null;
		try {
			await saveTableDraft(tabId);
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
			await saveAsTableDraft(tabId, name);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	async function exportTable(): Promise<void> {
		saveError = null;
		try {
			await downloadTable(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Export failed';
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				data-testid="table-name"
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable}
				oninput={(e) => setTableName(tabId, e.currentTarget.value)}
			/>
			{#if draft.dirty}
				<span title="Unsaved changes" class="text-warning">●</span>
			{/if}
			<span class="flex-1"></span>
			<div class="flex items-center gap-2">
				<button
					type="button"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
					onclick={() => void exportTable()}
				>
					Export
				</button>
				{#if editable}
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
				{/if}
			</div>
		</div>
		{#if conflict !== undefined}
			<div class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning">
				Someone else modified this table.
				<button type="button" class="underline" onclick={() => void reloadTableDraft(tabId)}>
					Reload their version
				</button>
			</div>
		{/if}
		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		{#if editable}
			<ColumnManager {tabId} />
		{/if}
		<div class="min-h-0 flex-1">
			<TableGrid {tabId} />
		</div>
	</div>
{/if}
