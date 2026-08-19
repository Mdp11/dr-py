<script lang="ts">
	// The exporter tab: an entry list (one per bundled table), an
	// add-table picker, Save (stage) and Export (run the COMMITTED artifact)
	// — the exporter sibling of `Snippet/SnippetTab.svelte` and
	// `Table/TableView.svelte`. See `state/exporter-editor.svelte.ts`'s
	// module docstring for the draft/lease/staging model this drives.
	import * as artifactsApi from '$lib/api/artifacts';
	import { runExporter } from '$lib/api/exports';
	import { retryAndDownload, type ExportProgress } from '$lib/util/export-download';
	import {
		addExporterEntry,
		artifactHeaderById,
		canEdit,
		ensureExporterDraft,
		getExporterDraft,
		getExporterLockHolder,
		isTempId,
		moveExporterEntryInList,
		referenceableArtifactHeaders,
		removeExporterEntry,
		retryExporterLock,
		saveExporterDraft,
		setExporterName,
		updateExporterEntry
	} from '$lib/state';
	import { TableDefinitionSchema, type ExporterEntry, type TableDefinition } from '$lib/api/types';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import EntryLayoutDialog from './EntryLayoutDialog.svelte';
	import ArtifactExportButton from '$lib/components/ArtifactExportButton.svelte';

	let { tabId }: { tabId: string } = $props();

	$effect(() => {
		void ensureExporterDraft(tabId);
	});

	const draft = $derived(getExporterDraft(tabId));
	/** Non-null while a peer holds this export's `art:` lease: the tab is
	 *  UNSAVEABLE until the check-out succeeds — see
	 *  `exporter-editor.svelte.ts`'s `_lockDenied` doc and
	 *  `navigation-editor.svelte.ts`'s `ensureDraft` for the canonical
	 *  statement of what a denial gates. */
	const lockHolder = $derived(getExporterLockHolder(tabId));
	const locked = $derived(lockHolder !== undefined);
	const editable = $derived(canEdit());
	const disabledEntry = $derived(!editable || locked);

	const usedRefs = $derived(new Set((draft?.entries ?? []).map((e) => e.source.ref)));
	const availableTables = $derived(
		referenceableArtifactHeaders('table').filter((h) => !usedRefs.has(h.id))
	);

	function tableName(ref: string): string {
		return artifactHeaderById(ref)?.name ?? ref;
	}

	let saveError = $state<string | null>(null);
	async function save(): Promise<void> {
		saveError = null;
		try {
			saveExporterDraft(tabId);
		} catch (e) {
			saveError = e instanceof Error ? e.message : 'Save failed';
		}
	}

	// --- Add-table picker -------------------------------------------------
	let addTableError = $state<string | null>(null);
	async function onAddTableChange(e: Event): Promise<void> {
		const select = e.currentTarget as HTMLSelectElement;
		const id = select.value;
		select.value = '';
		if (!id) return;
		const header = availableTables.find((h) => h.id === id);
		if (!header) return;
		addTableError = null;
		try {
			const art = await artifactsApi.getArtifact(id);
			const defn = TableDefinitionSchema.parse(art.payload);
			addExporterEntry(tabId, id, header.name, defn);
		} catch (err) {
			addTableError = err instanceof Error ? err.message : 'Failed to load table';
		}
	}

	// --- Entry-layout editing ----------------------------------------------
	// One dialog instance, remounted per entry (the `{#if}` below): the
	// dialog captures its working copy ONCE at mount (see its own doc), so a
	// fresh mount per "Edit layout" click is what gives every entry a clean
	// snapshot rather than reusing a stale one.
	let editEntryIndex = $state<number | null>(null);
	let editDefinition = $state<TableDefinition | null>(null);
	let editLayoutOpen = $state(false);
	let editError = $state<string | null>(null);
	// Monotonic guard against overlapping "Edit layout" clicks — mirrors
	// ExportSettingsPanel's preview-fetch token (`token`/`mine`, :179-199
	// there). Two rows' "Edit layout" buttons clicked before either fetch
	// resolves race two `openEditLayout` calls; without this guard, whichever
	// resolves LAST wins `editDefinition`/`editEntryIndex`, but if
	// `editLayoutOpen` was already flipped true by the FIRST resolution,
	// Svelte only updates the already-mounted `EntryLayoutDialog`'s PROPS —
	// it does not remount it — so the dialog's `effective`/`format` `$state`
	// (captured once, BY DESIGN — see that component's own doc) stays frozen
	// on the first entry while the title/entry prop shows the second. Save
	// then writes the FIRST entry's edited layout into the SECOND entry's
	// slot: a persisted cross-wire, not a display glitch (see
	// `saveEditLayout` below). Discarding every resolution but the most
	// recently REQUESTED one (not the most recently ARRIVED one) makes the
	// dialog track the user's LAST click regardless of network ordering, and
	// — since a stale resolution never touches `editLayoutOpen` at all — a
	// genuine mount only ever happens once, for the request that was still
	// current when it resolved.
	let editRequest = 0;

	async function openEditLayout(i: number): Promise<void> {
		const entry = draft?.entries[i];
		if (!entry) return;
		editError = null;
		const mine = ++editRequest;
		try {
			const art = await artifactsApi.getArtifact(entry.source.ref);
			if (mine !== editRequest) return; // superseded by a newer "Edit layout" click
			editDefinition = TableDefinitionSchema.parse(art.payload);
			editEntryIndex = i;
			editLayoutOpen = true;
		} catch (err) {
			if (mine !== editRequest) return;
			editError = err instanceof Error ? err.message : 'Failed to load table';
		}
	}

	function closeEditLayout(): void {
		editLayoutOpen = false;
		editEntryIndex = null;
		editDefinition = null;
	}

	function saveEditLayout(patch: Partial<ExporterEntry>): void {
		if (editEntryIndex === null) return;
		updateExporterEntry(tabId, editEntryIndex, patch);
	}

	// --- Reorder -------------------------------------------------------------
	const drag = createColumnDrag({
		attr: 'data-export-entry-drop',
		axis: 'y',
		validate: () => true,
		onDrop: (from, to) => moveExporterEntryInList(tabId, from, to)
	});

	// --- Export: run the COMMITTED artifact, 202-poll, download ------------
	let exporting = $state(false);
	let exportProgress = $state<ExportProgress | null>(null);
	let exportError = $state<string | null>(null);
	let exportAbort: AbortController | null = null;
	$effect(() => () => exportAbort?.abort());

	// The export always runs the server's last COMMITTED payload (see the
	// tooltip below) — a temp id names nothing server-side at all, so it is
	// gated exactly like "not saved yet" rather than merely "dirty".
	const exportDisabled = $derived(
		!draft || draft.dirty || draft.artifactId === null || isTempId(draft.artifactId)
	);

	async function runExport(): Promise<void> {
		if (exportDisabled || !draft?.artifactId || exporting) return;
		const id = draft.artifactId;
		exportError = null;
		exporting = true;
		exportAbort = new AbortController();
		try {
			await retryAndDownload(() => runExporter(id), {
				onProgress: (p) => (exportProgress = p),
				signal: exportAbort.signal
			});
		} catch (e) {
			exportError = e instanceof Error ? e.message : 'Export failed';
		} finally {
			exporting = false;
			exportProgress = null;
			exportAbort = null;
		}
	}
</script>

{#if !draft}
	<p class="p-4 text-xs text-muted-foreground/70">Loading…</p>
{:else}
	<div class="flex h-full flex-col overflow-hidden">
		<div class="flex items-center gap-2 border-b border-border px-3 py-2">
			<input
				class="w-56 rounded border border-input bg-card px-2 py-1 text-xs"
				value={draft.name}
				disabled={!editable || locked}
				oninput={(e) => setExporterName(tabId, e.currentTarget.value)}
			/>
			<span class="flex-1"></span>
			<button
				type="button"
				data-testid="exporter-run"
				class="flex items-center gap-1.5 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
				disabled={exportDisabled || exporting}
				title={exportDisabled
					? 'Save and commit first — the export runs the committed definition'
					: undefined}
				onclick={() => void runExport()}
			>
				{#if exporting}
					{#if exportProgress}
						Preparing… {exportProgress.done}/{exportProgress.total ?? '…'}
					{:else}
						Exporting…
					{/if}
				{:else}
					Export
				{/if}
			</button>
			{#if editable}
				<button
					type="button"
					data-testid="exporter-save"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
					disabled={locked}
					onclick={() => void save()}
				>
					Save{draft.dirty ? ' *' : ''}
				</button>
			{/if}
			<ArtifactExportButton {tabId} />
		</div>

		{#if saveError}
			<p class="px-3 py-1 text-xs text-destructive">{saveError}</p>
		{/if}
		{#if exportError}
			<p class="px-3 py-1 text-xs text-destructive">{exportError}</p>
		{/if}
		{#if addTableError}
			<p class="px-3 py-1 text-xs text-destructive">{addTableError}</p>
		{/if}
		{#if editError}
			<p class="px-3 py-1 text-xs text-destructive">{editError}</p>
		{/if}

		{#if lockHolder !== undefined}
			<div
				class="flex items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs text-warning"
				role="status"
			>
				Checked out by {lockHolder} — you will not be able to save.
				<button type="button" class="underline" onclick={() => void retryExporterLock(tabId)}>
					Retry
				</button>
			</div>
		{/if}

		<div class="min-h-0 flex-1 overflow-y-auto p-3">
			<div class="flex flex-col gap-1.5">
				{#each draft.entries as entry, i (i)}
					<div
						data-testid="export-entry-{i}"
						data-export-entry-drop={i}
						style="transform:translateY({drag.offsetOf(i)}px)"
						class="flex flex-wrap items-center gap-1.5 rounded border border-border/70 bg-muted/30 p-1.5 text-xs"
						class:transition-transform={drag.dragging}
						class:duration-150={drag.dragging}
						class:border-primary={drag.from === i}
					>
						<span
							role="button"
							tabindex="-1"
							data-testid="export-entry-drag-{i}"
							aria-label="Drag to reorder"
							title="Drag to reorder"
							class="shrink-0 cursor-grab touch-none select-none text-muted-foreground/50"
							onpointerdown={(e) => drag.onPointerDown(e, i)}
							onpointermove={(e) => drag.onPointerMove(e)}
							onpointerup={(e) => drag.onPointerUp(e)}
							onpointercancel={(e) => drag.onPointerCancel(e)}>⠿</span
						>
						<input
							class="min-w-40 flex-1 rounded border border-input bg-card px-2 py-1"
							placeholder={tableName(entry.source.ref)}
							value={entry.name}
							disabled={disabledEntry}
							oninput={(e) => updateExporterEntry(tabId, i, { name: e.currentTarget.value })}
						/>
						<span class="shrink-0 truncate text-muted-foreground" title={entry.source.ref}>
							{tableName(entry.source.ref)}
						</span>
						<div class="flex shrink-0 items-center gap-1">
							<button
								type="button"
								data-testid="export-entry-{i}-format-xlsx"
								aria-pressed={entry.format === 'xlsx'}
								class="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
								disabled={disabledEntry}
								onclick={() => updateExporterEntry(tabId, i, { format: 'xlsx' })}
							>
								xlsx
							</button>
							<button
								type="button"
								data-testid="export-entry-{i}-format-json"
								aria-pressed={entry.format === 'json'}
								class="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
								disabled={disabledEntry}
								onclick={() => updateExporterEntry(tabId, i, { format: 'json' })}
							>
								json
							</button>
						</div>
						<button
							type="button"
							data-testid="export-entry-{i}-layout"
							class="shrink-0 rounded border border-input px-1.5 py-0.5 text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
							disabled={disabledEntry}
							onclick={() => void openEditLayout(i)}
						>
							Edit layout
						</button>
						<button
							type="button"
							data-testid="export-entry-{i}-remove"
							aria-label="Remove entry"
							class="shrink-0 rounded border border-input px-1.5 py-0.5 text-foreground/80 transition-colors hover:bg-muted disabled:opacity-40"
							disabled={disabledEntry}
							onclick={() => removeExporterEntry(tabId, i)}
						>
							Remove
						</button>
					</div>
				{/each}
			</div>

			{#if editable}
				<div class="mt-2 flex items-center gap-2">
					<select
						data-testid="add-table-select"
						class="rounded border border-input bg-card px-2 py-1 text-xs"
						disabled={locked || availableTables.length === 0}
						onchange={(e) => void onAddTableChange(e)}
					>
						<option value="">Add table…</option>
						{#each availableTables as h (h.id)}
							<option value={h.id}>{h.name}</option>
						{/each}
					</select>
				</div>
			{/if}
		</div>
	</div>
{/if}

{#if editLayoutOpen && editDefinition && editEntryIndex !== null && draft?.entries[editEntryIndex]}
	<EntryLayoutDialog
		bind:open={editLayoutOpen}
		tableDefinition={editDefinition}
		entry={draft.entries[editEntryIndex]}
		onSave={saveEditLayout}
		onClose={closeEditLayout}
	/>
{/if}
