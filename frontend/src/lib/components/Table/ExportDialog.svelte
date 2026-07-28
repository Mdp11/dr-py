<script lang="ts">
	// The export settings modal: one unified column list that adapts to the
	// selected format, plus (for JSON) the live sample.
	//
	// Everything here is an EXPORT OVERRIDE — it changes the file and never
	// the grid. Inclusion, order, and the row-number entry are shared across
	// formats; the rename is not (xlsx writes `export.header`, JSON writes
	// `json_export.key`), which is why the name input below is bound to two
	// different fields.
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
	//
	// The sample is fetched from `POST /tables/json-preview` rather than built
	// here on purpose: grouping is a non-trivial algorithm over the evaluator's
	// row keys, and a second implementation in TypeScript would drift from
	// `core/table/json_export.py` — the pane would then confidently show
	// something the download does not produce.
	import {
		getTableDraft,
		getTableSort,
		restoreTableExportSettings,
		updateTableExportSettings
	} from '$lib/state';
	import {
		defaultJsonKeys,
		moveExportEntry,
		setColumnExportOptions,
		setColumnJsonOptions,
		setRowNumberExportOptions,
		snakeCaseKey
	} from '$lib/table/columns';
	import { ROW_NUMBER_SLOT, exportEntries, type ExportEntry } from '$lib/table/export-layout';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import { previewTableJson } from '$lib/api/tables';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Eye, EyeOff } from '@lucide/svelte';
	import type { Column, TableDefinition } from '$lib/api/types';

	let {
		tabId,
		open = $bindable(),
		format = $bindable(),
		onClose,
		onExport
	}: {
		tabId: string;
		open: boolean;
		format: 'xlsx' | 'json';
		onClose: () => void;
		/** How the download is actually run — required, never defaulted: the
		 *  table tab's wrapper is what keeps the 202-retry loop reporting
		 *  through the chrome's Export button and aborting when the tab
		 *  unmounts. This dialog decides WHAT is exported, not how the waiting
		 *  is surfaced, and it is closed long before the wait is over. */
		onExport: (format: 'xlsx' | 'json') => Promise<void>;
	} = $props();

	const draft = $derived(getTableDraft(tabId));
	const defn = $derived(draft?.definition);
	// Every entry, INCLUDED OR NOT — the excluded ones are exactly what the user
	// comes here to opt back in, so unlike the backend's own layout this list
	// keeps them.
	const entries = $derived(defn ? exportEntries(defn) : []);
	const keys = $derived(defn ? defaultJsonKeys(defn) : []);

	/** A column whose cells can hold element references — the only place the
	 *  name/id/object choice means anything. A property column never does. */
	function producesElements(col: Column): boolean {
		return col.kind === 'element' || col.kind === 'navigation' || col.kind === 'script';
	}

	/** `group` is honored by the backend only on a visible expand column, so
	 *  the checkbox exists only where it would do something. */
	function canGroup(col: Column): boolean {
		return 'mode' in col && col.mode === 'expand';
	}

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

	function patchExport(index: number, p: Parameters<typeof setColumnExportOptions>[2]): void {
		if (!defn) return;
		updateTableExportSettings(tabId, setColumnExportOptions(defn, index, p));
	}

	function patchJson(index: number, p: Parameters<typeof setColumnJsonOptions>[2]): void {
		if (!defn) return;
		updateTableExportSettings(tabId, setColumnJsonOptions(defn, index, p));
	}

	function patchRowNumber(p: Parameters<typeof setRowNumberExportOptions>[1]): void {
		if (!defn) return;
		updateTableExportSettings(tabId, setRowNumberExportOptions(defn, p));
	}

	function toggleInclude(entry: ExportEntry): void {
		if (entry.index === ROW_NUMBER_SLOT) patchRowNumber({ include: !entry.included });
		else patchExport(entry.index, { include: !entry.included });
	}

	/** The label the entry carries in the file — the ONE control whose target
	 *  field depends on the format (see the header comment). */
	function nameOf(entry: ExportEntry): string {
		if (entry.index === ROW_NUMBER_SLOT) {
			const rn = defn?.export_row_number;
			return (format === 'json' ? rn?.key : rn?.header) ?? '';
		}
		const col = defn?.columns[entry.index];
		return (format === 'json' ? col?.json_export?.key : col?.export?.header) ?? '';
	}

	function setName(entry: ExportEntry, value: string): void {
		if (entry.index === ROW_NUMBER_SLOT) {
			patchRowNumber(format === 'json' ? { key: value } : { header: value });
		} else if (format === 'json') {
			patchJson(entry.index, { key: value });
		} else {
			patchExport(entry.index, { header: value });
		}
	}

	/** What the file falls back to when the name is left blank: the grid header
	 *  for xlsx, the derived JSON key otherwise (blank only for an EXCLUDED
	 *  entry, which is emitted nowhere — see `defaultJsonKeys`). */
	function placeholderOf(entry: ExportEntry): string {
		if (entry.index === ROW_NUMBER_SLOT) return format === 'json' ? 'row_number' : '#';
		const col = defn?.columns[entry.index];
		if (format === 'json') return keys[entry.index] ?? '';
		return col ? col.header || col.kind : '';
	}

	// Reorder. `from`/`to` — and therefore `data-export-drop` — are positions in
	// the EXPORT list, not definition indices: that is the coordinate space
	// `moveExportEntry` takes, and the row-number entry has no definition index
	// to use instead. `validate: () => true` because output positions carry
	// none of `moveColumn`'s backward-reference constraints.
	const drag = createColumnDrag({
		attr: 'data-export-drop',
		axis: 'y',
		validate: () => true,
		onDrop: (from, to) => {
			if (!defn) return;
			updateTableExportSettings(tabId, moveExportEntry(defn, from, to));
		}
	});

	function snakeAll(): void {
		if (!defn) return;
		let next: TableDefinition = defn;
		const derived = defaultJsonKeys(defn);
		derived.forEach((k, i) => {
			if (k === null) return; // excluded from the export: no key to rewrite
			// A blank item key keeps following the (now snaked) group key —
			// writing one would only freeze today's fallback into the payload.
			const item = defn.columns[i].json_export?.item_key ?? '';
			next = setColumnJsonOptions(
				next,
				i,
				item ? { key: snakeCaseKey(k), item_key: snakeCaseKey(item) } : { key: snakeCaseKey(k) }
			);
		});
		updateTableExportSettings(tabId, next);
	}

	// Preview follows the definition AND the active grid sort — `downloadTable`
	// always sends the sort (`_sortFor` in table-editor.svelte.ts), and since
	// grouping rolls same-key rows into arrays, a different row ORDER can
	// produce a different grouped SHAPE, not just reordered output. Omitting
	// the sort here would let the pane disagree with the download precisely
	// where this route exists to prevent that (see the file header). Read
	// inside the effect (not captured once outside it) so a sort change alone
	// re-triggers the preview. Debounced so typing a key does not fire a
	// whole-table build per keystroke; the last write wins via the token guard.
	//
	// Gated on an OPEN dialog in JSON mode: the pane does not exist otherwise,
	// and an xlsx export must never pay for a whole-table JSON build.
	let sample = $state('');
	let truncated = $state(false);
	let previewError = $state<string | null>(null);
	let token = 0;
	$effect(() => {
		if (!open || format !== 'json') return;
		const d = defn;
		if (!d) return;
		const s = getTableSort(tabId);
		const mine = ++token;
		const timer = setTimeout(() => {
			void previewTableJson({ definition: d, sort: s })
				.then((r) => {
					if (mine !== token) return; // a newer edit is in flight
					sample = r.sample;
					truncated = r.truncated;
					previewError = null;
				})
				.catch((e: unknown) => {
					if (mine !== token) return;
					previewError = e instanceof Error ? e.message : 'Preview failed';
				});
		}, 300);
		return () => clearTimeout(timer);
	});

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

		<div class="flex shrink-0 items-center gap-1 border-b border-border pb-1">
			<button
				type="button"
				data-testid="export-format-xlsx"
				aria-pressed={format === 'xlsx'}
				class="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:text-foreground"
				onclick={() => (format = 'xlsx')}
			>
				Excel (.xlsx)
			</button>
			<button
				type="button"
				data-testid="export-format-json"
				aria-pressed={format === 'json'}
				class="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:text-foreground"
				onclick={() => (format = 'json')}
			>
				JSON (.json)
			</button>
			<span class="flex-1"></span>
			{#if format === 'json'}
				<button
					type="button"
					data-testid="json-snake-all"
					class="rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
					onclick={snakeAll}
				>
					snake_case all
				</button>
			{/if}
		</div>

		{#if defn}
			<div class="min-h-0 flex-1 overflow-y-auto pr-1">
				<p class="pb-2 text-xs text-muted-foreground">
					{#if format === 'json'}
						One JSON object per row. Grouping an expanded column rolls its rows back into an array.
					{:else}
						One worksheet row per table row. Hiding a column here changes the file, never the grid.
					{/if}
				</p>
				<div class="flex flex-col gap-1">
					{#each entries as entry, pos (entry.index)}
						{@const col = entry.index === ROW_NUMBER_SLOT ? null : defn.columns[entry.index]}
						{@const grouped = col ? canGroup(col) && (col.json_export?.group ?? false) : false}
						<div
							data-export-drop={pos}
							style="transform:translateY({drag.offsetOf(pos)}px)"
							class="flex flex-wrap items-center gap-1.5 rounded border border-border/70 bg-muted/30 p-1.5 text-xs"
							class:transition-transform={drag.dragging}
							class:duration-150={drag.dragging}
							class:border-primary={drag.from === pos}
							class:opacity-50={!entry.included}
						>
							<span
								role="button"
								tabindex="-1"
								data-testid="export-drag-{pos}"
								aria-label="Drag to reorder"
								title="Drag to reorder"
								class="shrink-0 cursor-grab touch-none select-none text-muted-foreground/50"
								onpointerdown={(e) => drag.onPointerDown(e, pos)}
								onpointermove={(e) => drag.onPointerMove(e)}
								onpointerup={(e) => drag.onPointerUp(e)}
								onpointercancel={(e) => drag.onPointerCancel(e)}>⠿</span
							>
							<button
								type="button"
								data-testid="export-include-{pos}"
								class="rounded border border-input px-1 py-0.5 hover:bg-muted"
								aria-label={entry.included ? 'Exclude from export' : 'Include in export'}
								title={entry.included ? 'Exclude from this export' : 'Include in this export'}
								onclick={() => toggleInclude(entry)}
							>
								{#if entry.included}<Eye class="size-3" />{:else}<EyeOff class="size-3" />{/if}
							</button>
							<span class="w-36 shrink-0 truncate text-muted-foreground">
								{entry.index === ROW_NUMBER_SLOT ? 'Row number' : col!.header || col!.kind}
							</span>
							<label class="flex min-w-40 flex-1 items-center gap-1">
								{#if format === 'json' && grouped}
									<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70">
										array
									</span>
								{/if}
								<input
									data-testid="export-name-{pos}"
									class="w-full rounded border border-input bg-card px-2 py-1"
									placeholder={placeholderOf(entry)}
									value={nameOf(entry)}
									oninput={(e) => setName(entry, e.currentTarget.value)}
								/>
							</label>
							{#if format === 'json' && col}
								{#if grouped}
									<label class="flex items-center gap-1">
										<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70">
											item
										</span>
										<input
											data-testid={`json-item-key-${entry.index}`}
											class="w-40 rounded border border-input bg-card px-2 py-1"
											placeholder={keys[entry.index] ?? ''}
											value={col.json_export?.item_key ?? ''}
											oninput={(e) => patchJson(entry.index, { item_key: e.currentTarget.value })}
										/>
									</label>
								{/if}
								{#if producesElements(col)}
									<label class="flex items-center gap-1 text-muted-foreground">
										as
										<select
											data-testid={`json-value-${entry.index}`}
											class="rounded border border-input bg-card px-1 py-1"
											value={col.json_export?.value ?? 'name'}
											onchange={(e) =>
												patchJson(entry.index, {
													value: e.currentTarget.value as 'name' | 'id' | 'object'
												})}
										>
											<option value="name">name</option>
											<option value="id">id</option>
											<option value="object">object</option>
										</select>
									</label>
								{/if}
								{#if canGroup(col)}
									<label class="flex items-center gap-1 text-muted-foreground">
										<input
											type="checkbox"
											data-testid={`json-group-${entry.index}`}
											checked={col.json_export?.group ?? false}
											onchange={(e) => patchJson(entry.index, { group: e.currentTarget.checked })}
										/>
										group
									</label>
								{/if}
							{/if}
						</div>
					{/each}
				</div>

				{#if format === 'json'}
					<div class="flex flex-col gap-1 pt-3">
						<div class="flex items-center gap-2">
							<span class="text-xs text-muted-foreground">Preview</span>
							{#if truncated}
								<span
									data-testid="json-preview-truncated"
									class="text-[11px] text-muted-foreground/70"
								>
									sample only — groups may be incomplete
								</span>
							{/if}
						</div>
						{#if previewError}
							<p class="text-xs text-destructive">{previewError}</p>
						{:else}
							<pre
								data-testid="json-preview"
								class="max-h-64 overflow-auto rounded border border-border bg-muted/30 p-2 text-[11px]">{sample}</pre>
						{/if}
					</div>
				{/if}
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
				class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
				onclick={runExport}
			>
				Export
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
