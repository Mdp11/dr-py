<script lang="ts">
	// The table tab root: a slim chrome bar (name input, dirty dot, Settings,
	// Export, Save/Save as…, conflict banner) above a full-height `TableGrid`.
	// Definition editing (row source + columns) lives in a modal opened by the
	// ⚙ Settings button so the grid gets the whole area — see
	// docs/superpowers/specs/2026-07-13-table-settings-popup-design.md.
	import {
		canEdit,
		downloadTable,
		ensureTableDraft,
		getTableConflict,
		getTableDraft,
		getTablePage,
		reloadTableDraft,
		saveAsTableDraft,
		saveTableDraft,
		setTableName,
		updateTableDefinition
	} from '$lib/state';
	import { Settings } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { addColumn, newNavigationColumn, newPropertyColumn } from '$lib/table/columns';
	import ColumnManager from './ColumnManager.svelte';
	import TableGrid from './TableGrid.svelte';

	let { tabId }: { tabId: string } = $props();
	$effect(() => {
		void ensureTableDraft(tabId);
	});
	const draft = $derived(getTableDraft(tabId));
	const conflict = $derived(getTableConflict(tabId));
	const editable = $derived(canEdit());
	const page = $derived(getTablePage(tabId));
	// Any expand column multiplies rows — then the count reads
	// "N elements → M rows" (the pre-split base vs the split result).
	const hasSplit = $derived(
		draft?.definition.columns.some((c) => c.kind !== 'element' && c.mode === 'expand') ?? false
	);
	let saveError = $state<string | null>(null);
	let settingsOpen = $state(false);
	// Which column the settings dialog is scoped to — null shows the whole
	// definition editor (row source + every column); a definition index shows
	// only that column's card (see ColumnManager's focusIndex).
	let settingsFocus = $state<number | null>(null);

	function editColumn(index: number): void {
		settingsFocus = index;
		settingsOpen = true;
	}

	// The header "+" menu appends a fresh column, then focuses the dialog on
	// it — the new column's definition index is always `length - 1` regardless
	// of any hidden columns (addColumn only ever pushes).
	function addColumnFromHeader(kind: 'property' | 'navigation'): void {
		const d = getTableDraft(tabId);
		if (!d) return;
		updateTableDefinition(
			tabId,
			addColumn(d.definition, kind === 'property' ? newPropertyColumn() : newNavigationColumn())
		);
		settingsFocus = getTableDraft(tabId)!.definition.columns.length - 1;
		settingsOpen = true;
	}

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
			{#if page}
				<span
					data-testid="table-row-count"
					class="whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
					title={page.truncated ? 'The row set is incomplete (row limit reached)' : undefined}
				>
					{#if hasSplit && page.base_total != null}
						{page.base_total} element{page.base_total === 1 ? '' : 's'} →
						{page.total}{page.truncated ? '+' : ''} row{page.total === 1 ? '' : 's'}
					{:else}
						{page.total}{page.truncated ? '+' : ''} row{page.total === 1 ? '' : 's'}
					{/if}
				</span>
			{/if}
			<span class="flex-1"></span>
			<div class="flex items-center gap-2">
				{#if editable}
					<button
						type="button"
						data-testid="table-settings-button"
						class="flex items-center gap-1 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onclick={() => {
							settingsFocus = null;
							settingsOpen = true;
						}}
					>
						<Settings class="h-3.5 w-3.5" /> Settings
					</button>
				{/if}
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
		<div class="min-h-0 flex-1">
			<TableGrid
				{tabId}
				onEditColumn={editable ? editColumn : undefined}
				onAddColumn={editable ? addColumnFromHeader : undefined}
			/>
		</div>
	</div>

	{#if editable}
		<Dialog.Root
			bind:open={settingsOpen}
			onOpenChange={(o) => {
				if (!o) settingsFocus = null;
			}}
		>
			<Dialog.Content class="max-h-[85vh] max-w-3xl overflow-y-auto">
				<Dialog.Title class="font-display text-lg font-light tracking-wide">
					{settingsFocus === null ? 'Table settings' : 'Column settings'}
				</Dialog.Title>
				<ColumnManager {tabId} focusIndex={settingsFocus} />
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{/if}
