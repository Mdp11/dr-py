<script lang="ts">
	// The exporter tab: an entry list (one per bundled table), an
	// add-table picker, Save (stage) and Export (run the committed artifact,
	// or the draft inline when dirty/uncommitted) — the exporter sibling of
	// `Snippet/SnippetTab.svelte` and `Table/TableView.svelte`. See
	// `state/exporter-editor.svelte.ts`'s module docstring for the
	// draft/lease/staging model this drives.
	import * as artifactsApi from '$lib/api/artifacts';
	import { runExporter, runExporterDraft } from '$lib/api/exports';
	import { retryAndDownload, type ExportProgress } from '$lib/util/export-download';
	import {
		addExporterEntry,
		artifactHeaderById,
		canEdit,
		getArtifactHeaders,
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
		updateExporterEntry,
		updateExporterOutput
	} from '$lib/state';
	import {
		EXPORT_FORMATS,
		TableDefinitionSchema,
		isJsonFamily,
		type ExporterEntry,
		type TableDefinition
	} from '$lib/api/types';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import { isEmptySnippetSource } from '$lib/snippet/source';
	import EntryLayoutDialog from './EntryLayoutDialog.svelte';
	import AddTablePicker from './AddTablePicker.svelte';
	import TransformSourceEditor from './TransformSourceEditor.svelte';
	import TransformTestPanel from './TransformTestPanel.svelte';
	import ArtifactExportButton from '$lib/components/ArtifactExportButton.svelte';

	let { tabId }: { tabId: string } = $props();

	// Per-entry handles so Mod-Enter in an entry's inline transform editor
	// runs THAT entry's test panel, and a traceback frame in the panel jumps
	// THAT entry's editor. Keyed by entry index like every other per-row
	// element in this tab (`#each ... as entry, i`).
	let transformEditors: Record<number, TransformSourceEditor | undefined> = $state({});
	let transformTests: Record<number, TransformTestPanel | undefined> = $state({});

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

	// No usedRefs filter — a table may be added more than once (e.g.
	// "table A as a wide xlsx AND as a split JSON"). The server dedupes
	// colliding output names/folders at export time, so a duplicate entry
	// is legal, not an error.
	const availableTables = $derived(referenceableArtifactHeaders('table'));
	// The picker excludes staged-but-uncommitted creates (temp ids must never
	// reach a payload — see referenceableArtifactHeaders). When that filter —
	// or a simply table-less project — leaves the picker input empty it is
	// DISABLED, and a disabled input swallows clicks with no event and no
	// console output, which reads as "the button is broken". Say why instead,
	// and distinguish the two states: the overlay list (temp ids included)
	// tells a user whose table is only staged that COMMITTING is the missing
	// step.
	const stagedOnlyTables = $derived(
		availableTables.length === 0 && getArtifactHeaders().some((h) => h.kind === 'table')
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

	// --- Add-table picker ---------------------------------------------------
	let addTableError = $state<string | null>(null);
	async function addTable(id: string): Promise<void> {
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

	// --- Export: run the committed artifact or the draft inline, 202-poll, download ---
	let exporting = $state(false);
	let exportProgress = $state<ExportProgress | null>(null);
	let exportError = $state<string | null>(null);
	let exportAbort: AbortController | null = null;
	$effect(() => () => exportAbort?.abort());

	// The Export button is UNGATED on dirty/uncommitted state — a clean
	// committed draft runs by artifact id (the committed payload), anything
	// else ships its definition inline as a draft run. Referenced tables still
	// evaluate from their COMMITTED definitions either way; only this exporter's
	// own presentation travels as a draft. The one remaining gate is emptiness:
	// the server 422s "exporter has no entries", so disable with a hint instead.
	const exportDisabled = $derived(!draft || draft.entries.length === 0);

	async function runExport(): Promise<void> {
		const d = draft;
		if (!d || d.entries.length === 0 || exporting) return;
		// `id` is a const so the ternary's true branch narrows it to string and
		// the closure keeps the narrowing — no non-null assertion needed.
		const id = d.artifactId;
		const start =
			!d.dirty && id !== null && !isTempId(id)
				? () => runExporter(id)
				: () =>
						runExporterDraft(
							{ schema_version: 1, output: d.output, entries: d.entries },
							d.name || 'export'
						);
		exportError = null;
		exporting = true;
		exportAbort = new AbortController();
		try {
			await retryAndDownload(start, {
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
				title={exportDisabled ? 'Add at least one table first' : undefined}
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

		{#if editable}
			<div
				class="flex flex-wrap items-center gap-2 border-b border-border/70 bg-muted/20 px-3 py-1.5 text-xs"
			>
				<input
					data-testid="exporter-filename"
					aria-label="Output filename template"
					class="w-56 rounded border border-input bg-card px-2 py-1"
					placeholder={draft.name}
					value={draft.output.filename}
					disabled={locked}
					oninput={(e) => updateExporterOutput(tabId, { filename: e.currentTarget.value })}
				/>
				<div class="flex shrink-0 items-center gap-1">
					<button
						type="button"
						data-testid="exporter-mode-zip"
						aria-pressed={draft.output.mode === 'zip'}
						class="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
						disabled={locked}
						onclick={() => updateExporterOutput(tabId, { mode: 'zip' })}
					>
						zip
					</button>
					<button
						type="button"
						data-testid="exporter-mode-bare"
						aria-pressed={draft.output.mode === 'bare'}
						class="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
						disabled={locked}
						onclick={() => updateExporterOutput(tabId, { mode: 'bare' })}
					>
						bare
					</button>
				</div>
				<label class="flex items-center gap-1.5 text-muted-foreground">
					<input
						type="checkbox"
						data-testid="exporter-manifest"
						checked={draft.output.manifest}
						disabled={locked}
						onchange={(e) => updateExporterOutput(tabId, { manifest: e.currentTarget.checked })}
					/>
					Include manifest
				</label>
			</div>
		{/if}

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
						<!-- Read-only: the output name is the picked table's name. Clearing
						     it had no visible effect (the server falls back to the table
						     name), which read as a bug. -->
						<input
							data-testid="export-entry-{i}-name"
							class="min-w-40 flex-1 rounded border border-input bg-muted/40 px-2 py-1 text-foreground/80"
							value={entry.name || tableName(entry.source.ref)}
							readonly
							tabindex="-1"
							title={entry.source.ref}
						/>
						<input
							data-testid="export-entry-{i}-folder"
							class="min-w-32 flex-1 rounded border border-input bg-card px-2 py-1"
							placeholder="folder/in/zip"
							value={entry.folder}
							disabled={disabledEntry}
							oninput={(e) => updateExporterEntry(tabId, i, { folder: e.currentTarget.value })}
						/>
						<label
							class="flex shrink-0 items-center gap-1 text-muted-foreground"
							title="Split exports only: nest the per-element files under a folder named after the table, or put them directly under the folder path"
						>
							<input
								type="checkbox"
								data-testid="export-entry-{i}-split-folder"
								checked={entry.split_folder}
								disabled={disabledEntry}
								onchange={(e) =>
									updateExporterEntry(tabId, i, { split_folder: e.currentTarget.checked })}
							/>
							table folder
						</label>
						<div class="flex shrink-0 items-center gap-1">
							{#each EXPORT_FORMATS as fmt (fmt)}
								<button
									type="button"
									data-testid="export-entry-{i}-format-{fmt}"
									aria-pressed={entry.format === fmt}
									class="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
									disabled={disabledEntry}
									onclick={() => updateExporterEntry(tabId, i, { format: fmt })}
								>
									{fmt}
								</button>
							{/each}
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
						{#if isJsonFamily(entry.format)}
							<!-- Last child, `w-full`: the row is `flex flex-wrap`, so the
							     editor breaks onto its own line under the controls and its
							     height stays INSIDE `data-export-entry-drop` — the reorder
							     drag snapshots real element rects. -->
							<div class="flex w-full items-start gap-1.5 pt-0.5">
								<span class="shrink-0 pt-0.5 text-muted-foreground">Transform</span>
								<div class="min-w-0 flex-1">
									<TransformSourceEditor
										bind:this={transformEditors[i]}
										value={entry.transform ?? null}
										disabled={disabledEntry}
										collapseKey={`${tabId}::entry:${i}::transform`}
										onChange={(next) => updateExporterEntry(tabId, i, { transform: next })}
										onRun={() => void transformTests[i]?.requestRun()}
									/>
								</div>
							</div>
							{#if entry.transform != null}
								<!-- Same full-width last-child rule as the editor above: the
								     panel's height stays inside the drop element. -->
								<div class="w-full pl-[4.5rem]">
									<TransformTestPanel
										bind:this={transformTests[i]}
										{entry}
										onGoToLine={(l) => transformEditors[i]?.goToLine(l)}
									/>
								</div>
							{/if}
						{:else if !isEmptySnippetSource(entry.transform)}
							<!-- A transform left behind by a format flip: the server 422s it at
							     run time, so surface it rather than hiding the state. Never
							     blocks Save. An UNCONFIGURED source (`{}`) is not one — hence
							     the predicate rather than a truthiness test. -->
							<span class="shrink-0 text-warning" data-testid="export-entry-{i}-transform-warning">
								transform needs a JSON format
							</span>
						{/if}
					</div>
				{/each}
			</div>

			{#if editable}
				<div class="mt-2 flex items-center gap-2">
					<AddTablePicker
						tables={availableTables}
						disabled={locked || availableTables.length === 0}
						onPick={(id) => void addTable(id)}
					/>
					{#if availableTables.length === 0}
						<p data-testid="add-table-empty-hint" class="text-xs text-muted-foreground/70">
							{#if stagedOnlyTables}
								Tables staged in the current batch can be added once you commit them.
							{:else}
								No tables in this project yet — save and commit a table first.
							{/if}
						</p>
					{/if}
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
