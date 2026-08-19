<script lang="ts">
	// One exporter entry's presentation overrides, edited over the SAME
	// `ExportSettingsPanel` markup `Table/ExportDialog.svelte` drives — the
	// panel is host-agnostic (P-14 step 1), so this dialog only supplies a
	// different write target: a local working copy instead of the table draft.
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
	import { untrack } from 'svelte';
	import { applyEntryOverrides, overridesFromDefinition } from '$lib/table/exporter';
	import { templateIsValid } from '$lib/table/columns';
	import * as Dialog from '$lib/components/ui/dialog';
	import ExportSettingsPanel from './ExportSettingsPanel.svelte';
	import type { ExporterEntry, TableDefinition } from '$lib/api/types';

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
	let format = $state<'xlsx' | 'json'>(untrack(() => entry.format));

	// Same belt-and-braces stance as ExportDialog: the server still 422s a
	// tokenless template — this only saves a round trip.
	const splitTemplateInvalid = $derived(
		format === 'json' &&
			(effective.json_split?.enabled ?? false) &&
			!templateIsValid(effective.json_split?.filename_template ?? '')
	);

	function cancel(): void {
		onClose();
	}

	function save(): void {
		onSave({ format, ...overridesFromDefinition(effective) });
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
			<button
				type="button"
				data-testid="entry-layout-format-xlsx"
				aria-pressed={format === 'xlsx'}
				class="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:text-foreground"
				onclick={() => (format = 'xlsx')}
			>
				Excel (.xlsx)
			</button>
			<button
				type="button"
				data-testid="entry-layout-format-json"
				aria-pressed={format === 'json'}
				class="rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/60 aria-pressed:bg-muted aria-pressed:text-foreground"
				onclick={() => (format = 'json')}
			>
				JSON (.json)
			</button>
		</div>

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
				class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-40"
				disabled={splitTemplateInvalid}
				onclick={save}
			>
				Save
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>
