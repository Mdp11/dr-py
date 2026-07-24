<script lang="ts">
	// Per-column editor for a `script`-kind column: the column `source`
	// (mirrors PropertyColumnEditor/NavigationColumnEditor), the embedded
	// snippet (ref/inline, via the shared SnippetSourceEditor bound to the
	// `value` entry point), the split-into-rows toggle (`mode`), and
	// `keep_empty` (only meaningful while splitting). Fully controlled: emits
	// a whole new column via `onChange`. Unlike PropertyColumnEditor, split
	// has no metamodel-derived disable — a script's value shape is not
	// statically knowable, so the toggle is always enabled.
	import type { Column, RowSource } from '$lib/api/types';
	import ColumnSourceEditor from './ColumnSourceEditor.svelte';
	import SnippetSourceEditor from '$lib/components/Snippet/SnippetSourceEditor.svelte';

	type ScriptColumn = Extract<Column, { kind: 'script' }>;

	let {
		column,
		columnIndex,
		columns,
		rowSource,
		tabId,
		onChange
	}: {
		column: ScriptColumn;
		columnIndex: number;
		columns: Column[];
		rowSource: RowSource;
		tabId: string;
		onChange: (next: ScriptColumn) => void;
	} = $props();

	function setSplit(e: Event): void {
		const checked = (e.currentTarget as HTMLInputElement).checked;
		onChange({ ...column, mode: checked ? 'expand' : 'collapse' });
	}
	function setKeepEmpty(e: Event): void {
		onChange({ ...column, keep_empty: (e.currentTarget as HTMLInputElement).checked });
	}
</script>

<div
	data-testid="script-column-editor"
	class="mt-1.5 space-y-1.5 rounded border border-border/60 bg-muted/30 p-2 text-[11px]"
>
	<ColumnSourceEditor
		source={column.source}
		{columns}
		{columnIndex}
		{rowSource}
		onSourceChange={(source) => onChange({ ...column, source })}
	/>
	<SnippetSourceEditor
		snippet={column.snippet}
		entry="value"
		collapseKey={`${tabId}::col:${columnIndex}`}
		onChange={(s) => onChange({ ...column, snippet: s })}
	/>
	<div class="flex flex-wrap items-center gap-2">
		<label
			class="flex items-center gap-1"
			title="One row per value instead of listing them all in one cell"
		>
			<input
				type="checkbox"
				aria-label="Split multiple values in multiple rows"
				checked={column.mode === 'expand'}
				onchange={setSplit}
			/>
			Split multiple values in multiple rows
		</label>
		<label
			class="flex items-center gap-1"
			title="Keep a row with an empty cell when the script has no value (unchecked drops those rows — with or without splitting)"
		>
			<input
				type="checkbox"
				aria-label="Keep rows with no value"
				checked={column.keep_empty}
				onchange={setKeepEmpty}
			/>
			Keep rows with no value
		</label>
	</div>
</div>
