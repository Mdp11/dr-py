<script lang="ts">
	// The export settings panel: one unified column list that adapts to the
	// selected format, plus (for JSON) the live sample. Extracted verbatim out
	// of `Table/ExportDialog.svelte` (P-14 step 1) so a second host —
	// `EntryLayoutDialog`, editing one custom-export entry's overrides — can
	// reuse the exact same markup and mutators over a different definition and
	// a different write target. PRESENTATIONAL ONLY: every edit below produces
	// a next `TableDefinition` and hands it to `onChange`; this component never
	// writes to a store directly, which is what lets `ExportDialog` route edits
	// into the table draft while `EntryLayoutDialog` routes them into a local
	// working copy.
	//
	// Everything here is an EXPORT OVERRIDE — it changes the file and never
	// the grid. Inclusion, order, and the row-number entry are shared across
	// formats; the rename is not (xlsx writes `export.header`, JSON writes
	// `json_export.key`), which is why the name input below is bound to two
	// different fields.
	//
	// The sample is fetched from `POST /tables/json-preview` rather than built
	// here on purpose: grouping is a non-trivial algorithm over the evaluator's
	// row keys, and a second implementation in TypeScript would drift from
	// `core/table/json_export.py` — the pane would then confidently show
	// something the download does not produce.
	import {
		DEFAULT_JSON_SPLIT,
		defaultJsonKeys,
		moveExportEntry,
		setColumnExportOptions,
		setColumnJsonOptions,
		setJsonSplitOptions,
		setRowNumberExportOptions,
		snakeCaseKey,
		templateIsValid
	} from '$lib/table/columns';
	import { ROW_NUMBER_SLOT, exportEntries, type ExportEntry } from '$lib/table/export-layout';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import { previewTableJson } from '$lib/api/tables';
	import { Eye, EyeOff } from '@lucide/svelte';
	import type { Column, TableDefinition, TableSort } from '$lib/api/types';

	let {
		definition,
		format,
		onChange,
		previewDefinition,
		sort
	}: {
		definition: TableDefinition;
		format: 'xlsx' | 'json';
		onChange: (next: TableDefinition) => void;
		/** What the JSON preview builds from, when it must diverge from
		 *  `definition` itself — unused by every host today (both preview the
		 *  definition they edit), kept for parity with the host contract. */
		previewDefinition?: TableDefinition;
		/** The active grid sort, folded into the preview request so grouped
		 *  output matches the download exactly (see the preview effect below).
		 *  `EntryLayoutDialog` has no live grid sort to offer and leaves this
		 *  unset — a custom-export entry's preview is sort-less, same as its
		 *  download. */
		sort?: TableSort;
	} = $props();

	// Every entry, INCLUDED OR NOT — the excluded ones are exactly what the user
	// comes here to opt back in, so unlike the backend's own layout this list
	// keeps them.
	const entries = $derived(exportEntries(definition));
	const keys = $derived(defaultJsonKeys(definition));

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

	function patchExport(index: number, p: Parameters<typeof setColumnExportOptions>[2]): void {
		onChange(setColumnExportOptions(definition, index, p));
	}

	function patchJson(index: number, p: Parameters<typeof setColumnJsonOptions>[2]): void {
		onChange(setColumnJsonOptions(definition, index, p));
	}

	function patchRowNumber(p: Parameters<typeof setRowNumberExportOptions>[1]): void {
		onChange(setRowNumberExportOptions(definition, p));
	}

	function patchSplit(p: Parameters<typeof setJsonSplitOptions>[1]): void {
		onChange(setJsonSplitOptions(definition, p));
	}

	function toggleInclude(entry: ExportEntry): void {
		if (entry.index === ROW_NUMBER_SLOT) patchRowNumber({ include: !entry.included });
		else patchExport(entry.index, { include: !entry.included });
	}

	/** The label the entry carries in the file — the ONE control whose target
	 *  field depends on the format (see the header comment). */
	function nameOf(entry: ExportEntry): string {
		if (entry.index === ROW_NUMBER_SLOT) {
			const rn = definition.export_row_number;
			return (format === 'json' ? rn?.key : rn?.header) ?? '';
		}
		const col = definition.columns[entry.index];
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
		const col = definition.columns[entry.index];
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
		onDrop: (from, to) => onChange(moveExportEntry(definition, from, to))
	});

	function snakeAll(): void {
		let next: TableDefinition = definition;
		const derived = defaultJsonKeys(definition);
		derived.forEach((k, i) => {
			if (k === null) return; // excluded from the export: no key to rewrite
			// A blank item key keeps following the (now snaked) group key —
			// writing one would only freeze today's fallback into the payload.
			const item = definition.columns[i].json_export?.item_key ?? '';
			next = setColumnJsonOptions(
				next,
				i,
				item ? { key: snakeCaseKey(k), item_key: snakeCaseKey(item) } : { key: snakeCaseKey(k) }
			);
		});
		onChange(next);
	}

	// Preview follows the definition AND the active grid sort (when the host
	// supplies one) — `downloadTable` always sends the sort (`_sortFor` in
	// table-editor.svelte.ts), and since grouping rolls same-key rows into
	// arrays, a different row ORDER can produce a different grouped SHAPE, not
	// just reordered output. Omitting the sort here would let the pane disagree
	// with the download precisely where this route exists to prevent that (see
	// the file header). Debounced so typing a key does not fire a whole-table
	// build per keystroke; the last write wins via the token guard.
	//
	// Gated on JSON mode only: an xlsx export must never pay for a whole-table
	// JSON build. There is no `open` gate here — the host is responsible for
	// only mounting this panel while its own dialog is open (see
	// `ExportDialog`/`EntryLayoutDialog`), which is what stops the effect from
	// running against a closed dialog.
	let sample = $state('');
	let truncated = $state(false);
	let previewError = $state<string | null>(null);
	let token = 0;
	$effect(() => {
		if (format !== 'json') return;
		const d = previewDefinition ?? definition;
		const s = sort;
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
</script>

<p class="pb-2 text-xs text-muted-foreground">
	{#if format === 'json'}
		One JSON object per row. Grouping an expanded column rolls its rows back into an array.
	{:else}
		One worksheet row per table row. Hiding a column here changes the file, never the grid.
	{/if}
</p>

{#if format === 'json'}
	<button
		type="button"
		data-testid="json-snake-all"
		class="mb-2 rounded border border-input px-2 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
		onclick={snakeAll}
	>
		snake_case all
	</button>
{/if}

{#if format === 'json'}
	{@const split = definition.json_split ?? DEFAULT_JSON_SPLIT}
	<div class="mb-2 flex flex-col gap-1.5 rounded border border-border/70 bg-muted/30 p-1.5 text-xs">
		<label class="flex items-center gap-1.5">
			<input
				type="checkbox"
				data-testid="json-split-enabled"
				checked={split.enabled}
				onchange={(e) => patchSplit({ enabled: e.currentTarget.checked })}
			/>
			One file per element (zip)
		</label>
		{#if split.enabled}
			<input
				type="text"
				data-testid="json-split-template"
				class="w-full rounded border border-input bg-card px-2 py-1"
				placeholder={'DataFor${name}'}
				value={split.filename_template}
				oninput={(e) => patchSplit({ filename_template: e.currentTarget.value })}
			/>
			{#if !templateIsValid(split.filename_template)}
				<p data-testid="json-split-error" class="text-destructive">
					The template must contain {'${name}'}.
				</p>
			{/if}
		{/if}
	</div>
{/if}

<div class="flex flex-col gap-1">
	{#each entries as entry, pos (entry.index)}
		{@const col = entry.index === ROW_NUMBER_SLOT ? null : definition.columns[entry.index]}
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
					<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70"> array </span>
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
						<span class="w-9 shrink-0 text-[10px] uppercase text-muted-foreground/70"> item </span>
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
				<span data-testid="json-preview-truncated" class="text-[11px] text-muted-foreground/70">
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
