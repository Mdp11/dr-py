<script lang="ts">
	// One exporter entry's presentation overrides, edited over the SAME
	// `ExportSettingsPanel` markup `Table/ExportDialog.svelte` drives — the
	// panel is host-agnostic, so this dialog only supplies a different write
	// target: a local working copy instead of the table draft.
	//
	// `effective` is the entry's overrides re-applied onto the table's CURRENT
	// definition (`applyEntryOverrides`) — what the entry would render today,
	// not a frozen copy of what it looked like when it was added. Editing it
	// through the panel and diffing the result back against `tableDefinition`
	// (`overridesFromDefinition`) is exactly the copy-at-add shape: the entry
	// stores DRIFT from the table, never the table's settings themselves.
	//
	// No `sort` prop is passed to the panel: an exporter entry has no live
	// grid to inherit a sort from, and its download is sort-less too (see
	// `ExportSettingsPanel`'s own `sort` doc) — leaving it unset is correct
	// here, not an oversight.
	//
	// The `json_doc` controls below are this dialog's own addition (the panel
	// has no format-specific controls yet, see its own `format` prop doc) —
	// they read/write the entry's `json_doc` directly, not through the panel.
	// The live sample below them still renders the ARRAY shape regardless:
	// `POST /tables/json-preview` predates document shaping, and previewing
	// the object shape is deliberately out of this phase's scope.
	import { untrack } from 'svelte';
	import { applyEntryOverrides, overridesFromDefinition } from '$lib/table/exporter';
	import { templateIsValid } from '$lib/table/columns';
	import * as Dialog from '$lib/components/ui/dialog';
	import ExportSettingsPanel from './ExportSettingsPanel.svelte';
	import {
		EXPORT_FORMATS,
		isJsonFamily,
		type ExportFormat,
		type ExporterEntry,
		type JsonDocumentOptions,
		type TableDefinition
	} from '$lib/api/types';

	// Duplicated from `Table/ExportDialog.svelte`'s own const — four strings
	// are not worth sharing a module over.
	const FORMAT_LABELS: Record<ExportFormat, string> = {
		xlsx: 'Excel (.xlsx)',
		json: 'JSON (.json)',
		csv: 'CSV (.csv)',
		jsonl: 'JSON Lines (.jsonl)'
	};

	const JSON_DOC_DEFAULTS: JsonDocumentOptions = {
		shape: 'array',
		key_column: null,
		pretty: true,
		on_error: 'emit'
	};

	let {
		open = $bindable(),
		tableDefinition,
		entry,
		onSave,
		onClose
	}: {
		open: boolean;
		tableDefinition: TableDefinition;
		entry: ExporterEntry;
		onSave: (patch: Partial<ExporterEntry>) => void;
		onClose: () => void;
	} = $props();

	// Local working copy — nothing here writes to the draft directly. Captured
	// once at mount (the host remounts this dialog per entry rather than
	// reusing one instance across entries, so a fresh `$state` initializer per
	// open is the right lifecycle here, mirroring `ExportDialog`'s snapshot).
	let effective = $state(untrack(() => applyEntryOverrides(tableDefinition, entry)));
	let format = $state<ExportFormat>(untrack(() => entry.format));
	let jsonDoc = $state<JsonDocumentOptions | null>(untrack(() => entry.json_doc ?? null));

	// Never blocks Save: a presentation setting persists freely and the run is
	// where the contract is enforced (the export-time 422 names the entry).
	// This only drives the inline warning below — the server 422s a tokenless
	// template regardless, so the warning just saves a round trip.
	const splitTemplateInvalid = $derived(
		isJsonFamily(format) &&
			(effective.json_split?.enabled ?? false) &&
			!templateIsValid(effective.json_split?.filename_template ?? '')
	);

	// Deliberately no Save gating on a missing key column under the object
	// shape, nor on an invalid split filename template — the inline hints
	// (here and below) plus the export-time 422 are the entire contract.
	// Never add a check here that disables Save.
	function patchDoc(p: Partial<JsonDocumentOptions>): void {
		jsonDoc = { ...JSON_DOC_DEFAULTS, ...jsonDoc, ...p };
	}

	function cancel(): void {
		onClose();
	}

	function save(): void {
		onSave({ format, json_doc: jsonDoc, ...overridesFromDefinition(effective) });
		onClose();
	}
</script>

<Dialog.Root
	bind:open
	onOpenChange={(o) => {
		if (!o) cancel();
	}}
>
	<Dialog.Content
		data-testid="entry-layout-dialog"
		class="flex max-h-[85vh] max-w-none flex-col gap-3 overflow-hidden sm:max-w-none"
		style="width:min(52rem, 92vw)"
	>
		<Dialog.Title class="font-display text-lg font-light tracking-wide">
			Edit layout — {entry.name || 'Untitled'}
		</Dialog.Title>

		<div class="flex shrink-0 items-center gap-1 border-b border-border pb-1">
			{#each EXPORT_FORMATS as fmt (fmt)}
				<button
					type="button"
					data-testid="entry-layout-format-{fmt}"
					aria-pressed={format === fmt}
					class="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:text-foreground"
					onclick={() => (format = fmt)}
				>
					{FORMAT_LABELS[fmt]}
				</button>
			{/each}
		</div>

		{#if isJsonFamily(format)}
			<div class="flex shrink-0 flex-wrap items-center gap-3 text-xs" data-testid="entry-json-doc">
				{#if format === 'json'}
					<label class="flex items-center gap-1">
						Document
						<select
							data-testid="entry-json-doc-shape"
							class="rounded border border-input bg-card px-1.5 py-0.5"
							value={jsonDoc?.shape ?? 'array'}
							onchange={(e) => patchDoc({ shape: e.currentTarget.value as 'array' | 'object' })}
						>
							<option value="array">Array</option>
							<option value="object">Keyed object</option>
						</select>
					</label>
					{#if (jsonDoc?.shape ?? 'array') === 'object'}
						<label class="flex items-center gap-1">
							Key column
							<select
								data-testid="entry-json-doc-key-column"
								class="rounded border border-input bg-card px-1.5 py-0.5"
								value={jsonDoc?.key_column ?? ''}
								onchange={(e) =>
									patchDoc({
										key_column: e.currentTarget.value === '' ? null : Number(e.currentTarget.value)
									})}
							>
								<option value="">— pick a column —</option>
								{#each tableDefinition.columns as col, ci (ci)}
									<option value={ci}>{col.header || `${col.kind} ${ci}`}</option>
								{/each}
							</select>
						</label>
					{/if}
					<label class="flex items-center gap-1">
						<input
							type="checkbox"
							data-testid="entry-json-doc-pretty"
							checked={jsonDoc?.pretty ?? true}
							onchange={(e) => patchDoc({ pretty: e.currentTarget.checked })}
						/>
						Pretty-print
					</label>
				{/if}
				<!-- `on_error` is a two-value enum on the wire, but "emit" is just the
				     default degraded-not-failed stance every format shares, so the only
				     real choice is whether an error cell should fail the run: one checkbox,
				     not a select naming a mode nobody picks. -->
				<label
					class="flex items-center gap-1"
					title="Unchecked: a failed or uncomputed cell ships as an in-band {'{'}&quot;$error&quot;: …{'}'} marker"
				>
					<input
						type="checkbox"
						data-testid="entry-json-doc-on-error"
						checked={(jsonDoc?.on_error ?? 'emit') === 'fail'}
						onchange={(e) => patchDoc({ on_error: e.currentTarget.checked ? 'fail' : 'emit' })}
					/>
					Fail the export if any cell errored
				</label>
				{#if (jsonDoc?.shape ?? 'array') === 'object' && jsonDoc?.key_column == null}
					<span class="text-muted-foreground/70"
						>object shape needs a key column (checked at export)</span
					>
				{/if}
			</div>
		{/if}

		{#if open}
			<div class="min-h-0 flex-1 overflow-y-auto pr-1">
				<ExportSettingsPanel
					definition={effective}
					{format}
					onChange={(next) => (effective = next)}
				/>
			</div>
		{/if}

		<div class="flex shrink-0 items-center justify-end gap-2 border-t border-border pt-2">
			{#if splitTemplateInvalid}
				<span data-testid="entry-split-template-warning" class="text-xs text-muted-foreground/70">
					split filename template needs {'${name}'} (checked at export)
				</span>
			{/if}
			<button
				type="button"
				data-testid="entry-layout-cancel"
				class="rounded border border-input px-3 py-1 text-xs text-foreground/80 transition-colors hover:bg-muted"
				onclick={cancel}
			>
				Cancel
			</button>
			<button
				type="button"
				data-testid="entry-layout-save"
				class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80"
				onclick={save}
			>
				Save
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
