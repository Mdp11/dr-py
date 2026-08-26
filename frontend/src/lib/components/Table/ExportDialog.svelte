<script lang="ts">
	// The export settings modal chrome: open/snapshot/cancel semantics, the
	// format toggle, and confirm/cancel — everything about EDITING the export
	// settings (the entry list, json options, split section, preview pane)
	// lives in `Export/ExportSettingsPanel.svelte`, which this dialog drives
	// over the table draft via `onChange`.
	//
	// No evaluation-suspension machinery (`suspendTableEvaluation` and
	// friends), unlike the Settings dialog — but NOT because a stray
	// re-evaluation would be harmless. It would be pure waste: nothing here
	// can change a single grid cell, yet `updateTableDefinition`'s reload
	// bumps the tab's generation, drops the script-error recap and pulses the
	// activity bar, once per keystroke. So every edit below goes through
	// `updateTableExportSettings`, which writes the draft and stops there.
	// Suspension exists to defer a reload that IS needed; here there is none
	// to defer.
	import {
		getTableDraft,
		getTableSort,
		restoreTableExportSettings,
		updateTableExportSettings
	} from '$lib/state';
	import { templateIsValid } from '$lib/table/columns';
	import * as Dialog from '$lib/components/ui/dialog';
	import { isEmptySnippetSource } from '$lib/snippet/source';
	import ExportSettingsPanel from '../Export/ExportSettingsPanel.svelte';
	import TransformSourceEditor from '../Export/TransformSourceEditor.svelte';
	import {
		EXPORT_FORMATS,
		isJsonFamily,
		type ExportFormat,
		type TableDefinition
	} from '$lib/api/types';

	const FORMAT_LABELS: Record<ExportFormat, string> = {
		xlsx: 'Excel (.xlsx)',
		json: 'JSON (.json)',
		csv: 'CSV (.csv)',
		jsonl: 'JSON Lines (.jsonl)'
	};

	let {
		tabId,
		open = $bindable(),
		format = $bindable(),
		onClose,
		onExport
	}: {
		tabId: string;
		open: boolean;
		format: ExportFormat;
		onClose: () => void;
		/** How the download is actually run — required, never defaulted: the
		 *  table tab's wrapper is what keeps the 202-retry loop reporting
		 *  through the chrome's Export button and aborting when the tab
		 *  unmounts. This dialog decides WHAT is exported, not how the waiting
		 *  is surfaced, and it is closed long before the wait is over. */
		onExport: (format: ExportFormat) => Promise<void>;
	} = $props();

	const draft = $derived(getTableDraft(tabId));
	const defn = $derived(draft?.definition);
	const sort = $derived(getTableSort(tabId));

	// The Cancel snapshot. A plain `let`, not `$state`: nothing renders it, and
	// it must not re-trigger the effect that fills it. Taken the first time the
	// dialog is open and dropped on close, so each opening gets its own
	// baseline. Every edit below writes STRAIGHT into the draft (the JSON
	// preview needs a real definition to render, and the grid is indifferent to
	// export settings), so restoring this is the whole of Cancel.
	//
	// `dirty` is captured ALONGSIDE the definition — see
	// `restoreTableExportSettings`. Discarding an edit has to discard the
	// unsaved-ness the edit created, or a table that was saved when the dialog
	// opened stays marked unsaved forever; for a viewer, who has no Save
	// button, forever is literal. This mirrors `_suspendedSnapshot`'s
	// `{ definition, dirty, sort }`, minus the sort this dialog never touches.
	let snapshot: { definition: TableDefinition; dirty: boolean } | null = null;
	$effect(() => {
		if (!open) {
			snapshot = null;
			return;
		}
		if (snapshot === null && draft) {
			snapshot = {
				definition: $state.snapshot(draft.definition) as TableDefinition,
				dirty: draft.dirty
			};
		}
	});

	// Belt-and-braces: the server still 422s a tokenless template
	// (core/table/split.py::validate_template) — this only saves a round trip
	// by disabling Export before the request is ever sent.
	const splitTemplateInvalid = $derived(
		isJsonFamily(format) &&
			(defn?.json_split?.enabled ?? false) &&
			!templateIsValid(defn?.json_split?.filename_template ?? '')
	);

	/** Restore the definition — and the dirty flag — this dialog opened with.
	 *  Reached by the Cancel button and by every dismissal bits-ui reports
	 *  (Escape, an overlay click, its own close): a discard is a discard
	 *  whichever way it is spelled.
	 *
	 *  WRITES NOTHING when the definition is unchanged. `updateTableExportSettings`
	 *  sets `dirty` unconditionally, so an unguarded restore would mark a
	 *  clean, saved table unsaved just for opening this dialog and dismissing
	 *  it. Compared by JSON fingerprint — the same "did anything actually
	 *  change" test the settings dialog's discard gate uses
	 *  (`hasSuspendedTableEdits` → `definitionFingerprint`), including its
	 *  harmless failure mode: two structurally equal definitions with different
	 *  key order would compare unequal and cost one needless restore, never a
	 *  lost one.
	 *
	 *  The gate deliberately reads the DEFINITION only, never the dirty flag.
	 *  A dirty flag that moved on its own (a Save landing while the dialog is
	 *  open) belongs to that other event; there is nothing of ours to discard,
	 *  and forcing the captured flag back would undo it. */
	function cancel(): void {
		if (snapshot && defn && JSON.stringify(defn) !== JSON.stringify(snapshot.definition)) {
			restoreTableExportSettings(tabId, snapshot.definition, snapshot.dirty);
		}
		snapshot = null;
		onClose();
	}

	/** Close FIRST, then start the download — deliberately not awaited.
	 *
	 *  `onExport` runs `downloadTable`'s whole 202/`Retry-After` loop, which
	 *  can wait minutes while a script sweep fills the cell cache. Awaiting it
	 *  here would hold the modal open for that entire time, showing a static
	 *  label over an overlay that covers the chrome's Export button — the one
	 *  place the real `Preparing… 3/40` progress is reported. The dialog picks
	 *  WHAT to export; the tab owns the waiting, the progress and the failure
	 *  message (`TableView.exportTable` catches into its own `saveError`), so
	 *  there is nothing left here to await for. */
	function runExport(): void {
		// Dropped BEFORE the close so the dismissal path below cannot mistake a
		// started export for a discard and revert the settings it is using.
		snapshot = null;
		onClose();
		void onExport(format);
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		// Only bits-ui's OWN close (Escape, an overlay click) arrives here — an
		// external assignment to the bound `open` is not reported — so this is
		// the dismissal path, and dismissing discards. Cancel and Export have
		// already cleared `snapshot` by the time their `onClose` flips `open`.
		if (!o) cancel();
	}}
>
	<Dialog.Content
		data-testid="table-export-dialog"
		class="flex max-h-[85vh] max-w-none flex-col gap-3 overflow-hidden sm:max-w-none"
		style="width:min(52rem, 92vw)"
	>
		<Dialog.Title class="font-display text-lg font-light tracking-wide">Export table</Dialog.Title>

		<div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border pb-1">
			{#each EXPORT_FORMATS as fmt (fmt)}
				<button
					type="button"
					data-testid="export-format-{fmt}"
					aria-pressed={format === fmt}
					class="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:text-foreground"
					onclick={() => (format = fmt)}
				>
					{FORMAT_LABELS[fmt]}
				</button>
			{/each}

			<!-- This edits the table's OWN `transform` (standalone `POST /tables/export`
			     only — an exporter entry never inherits it; no-bleed); strictness
			     is server-side at export time. -->
			{#if isJsonFamily(format) && defn}
				<div class="flex w-full items-start gap-1.5 pt-1 text-xs text-muted-foreground">
					<span class="shrink-0 pt-0.5">Transform</span>
					<div class="min-w-0 flex-1">
						<!-- No `disabled` here, unlike `ExporterTab`'s: this dialog mounts
						     outside the `editable` gate on purpose (see the note above
						     `<ExportDialog` in TableView.svelte), and a viewer authoring an
						     inline transform for their own export is not an escalation --
						     they already run arbitrary sandboxed code via `POST /snippets/run`
						     and inline `ScriptColumn`s. The one wart: "Add transform" writes
						     `{}` and dirties the draft, and a viewer has no Save button to
						     clean it with (`restoreTableExportSettings`'s docstring). -->
						<TransformSourceEditor
							value={defn.transform ?? null}
							collapseKey={`${tabId}::table:transform`}
							onChange={(next) =>
								updateTableExportSettings(tabId, {
									...defn,
									transform: next
								})}
						/>
					</div>
				</div>
			{:else if !isEmptySnippetSource(defn?.transform)}
				<!-- A transform left behind by a format flip: the server 422s it at
				     run time, so surface it rather than hiding the state. Never blocks
				     Export. An UNCONFIGURED source is not one — hence the predicate
				     rather than a truthiness test. -->
				<span
					class="ml-auto shrink-0 text-xs text-warning"
					data-testid="table-export-transform-warning"
				>
					transform needs a JSON format
				</span>
			{/if}
		</div>

		{#if open && defn}
			<div class="min-h-0 flex-1 overflow-y-auto pr-1">
				<ExportSettingsPanel
					definition={defn}
					{format}
					{sort}
					onChange={(next) => updateTableExportSettings(tabId, next)}
				/>
			</div>
		{/if}

		<div class="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-2">
			<button
				type="button"
				data-testid="export-cancel"
				class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
				onclick={cancel}
			>
				Cancel
			</button>
			<button
				type="button"
				data-testid="export-confirm"
				class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
				disabled={splitTemplateInvalid}
				onclick={runExport}
			>
				Export
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
