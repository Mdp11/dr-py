<script lang="ts">
	// Per-column editor for a `property`-kind column: the property `name`
	// (searchable metamodel-aware picker + free text — free text covers
	// instance-only keys the metamodel doesn't declare), the column `source`
	// (mirrors NavigationColumnEditor), and `keep_empty`. Fully controlled:
	// emits a whole new column via `onChange`.
	import { getMetamodel } from '$lib/state/metamodel.svelte';
	import { effectivePropertiesForTypes } from '$lib/metamodel/helpers';
	import { columnLabel } from '$lib/table/columns';
	import type { Column, RowSource } from '$lib/api/types';
	import type { PropertyItem } from '$lib/search/property-ops';
	import PropertyPicker from '../Sidebar/PropertyPicker.svelte';

	type PropColumn = Extract<Column, { kind: 'property' }>;

	let {
		column,
		columnIndex,
		columns,
		rowSource,
		onChange
	}: {
		column: PropColumn;
		columnIndex: number;
		columns: Column[];
		rowSource: RowSource;
		onChange: (next: PropColumn) => void;
	} = $props();

	const mm = $derived(getMetamodel());
	const priorColumns = $derived(columns.slice(0, columnIndex));

	// Suggestions scoped to the source's element types when knowable: a
	// row-slot source over scope rows narrows to the scope's types; anything
	// else (navigation/chains rows, earlier-column sources) falls back to the
	// union over all element types ([] = "any"). Typed free text always wins.
	const sourceTypes = $derived(
		column.source.kind === 'row' && rowSource.kind === 'scope' ? rowSource.types : []
	);
	const items = $derived<PropertyItem[]>(
		mm
			? effectivePropertiesForTypes(mm, sourceTypes).map((p) => ({
					name: p.name,
					datatype: p.datatype
				}))
			: []
	);

	let pickerOpen = $state(false);

	function setSourceKind(e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value;
		if (kind === 'row') onChange({ ...column, source: { kind: 'row', chain_index: 0 } });
		else {
			const index = priorColumns.length > 0 ? priorColumns.length - 1 : 0;
			onChange({ ...column, source: { kind: 'column', index } });
		}
	}
	function setSourceChainIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLInputElement).value) || 0;
		onChange({ ...column, source: { kind: 'row', chain_index: v } });
	}
	function setSourceColumnIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLSelectElement).value) || 0;
		onChange({ ...column, source: { kind: 'column', index: v } });
	}
	function setName(e: Event): void {
		onChange({ ...column, name: (e.currentTarget as HTMLInputElement).value });
	}
	function setKeepEmpty(e: Event): void {
		onChange({ ...column, keep_empty: (e.currentTarget as HTMLInputElement).checked });
	}
</script>

<div
	data-testid="property-column-editor"
	class="mt-1.5 space-y-1.5 rounded border border-border/60 bg-muted/30 p-2 text-[11px]"
>
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-muted-foreground/70">source</span>
		<select
			aria-label="Column source kind"
			value={column.source.kind}
			onchange={setSourceKind}
			class="rounded border border-input bg-card px-1 py-0.5"
		>
			<option value="row">Row</option>
			<option value="column" disabled={priorColumns.length === 0}>Earlier column</option>
		</select>
		{#if column.source.kind === 'row'}
			<label class="flex items-center gap-1">
				chain
				<input
					type="number"
					class="w-12 rounded border border-input bg-card px-1 py-0.5"
					value={column.source.chain_index}
					oninput={setSourceChainIndex}
				/>
			</label>
		{:else}
			<select
				aria-label="Source column"
				value={column.source.index}
				onchange={setSourceColumnIndex}
				class="rounded border border-input bg-card px-1 py-0.5"
			>
				{#each priorColumns as c, i (i)}
					<option value={i}>{i}: {columnLabel(c)}</option>
				{/each}
			</select>
		{/if}
	</div>
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-muted-foreground/70">property</span>
		<PropertyPicker
			{items}
			open={pickerOpen}
			onOpenChange={(o) => (pickerOpen = o)}
			onPick={(name) => onChange({ ...column, name })}
			searchPlaceholder="Filter properties…"
		>
			{#snippet trigger()}
				<span
					data-testid="property-pick-trigger"
					class="rounded border border-input px-1.5 py-0.5 hover:bg-muted"
				>
					pick…
				</span>
			{/snippet}
		</PropertyPicker>
		<input
			aria-label="Property name"
			class="w-32 rounded border border-input bg-card px-1.5 py-0.5"
			placeholder="property name"
			value={column.name}
			oninput={setName}
		/>
		<label class="flex items-center gap-1">
			<input type="checkbox" checked={column.keep_empty} onchange={setKeepEmpty} />
			keep empty
		</label>
	</div>
</div>
