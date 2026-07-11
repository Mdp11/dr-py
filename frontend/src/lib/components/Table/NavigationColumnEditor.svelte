<script lang="ts">
	// Per-column editor for a `navigation`-kind column: the column's `source`
	// (a row slot / an earlier column's output), the saved-navigation REF
	// picker (see RowSourceEditor's doc comment for why a ref picker rather
	// than an embedded `NavigationNode` — same reasoning applies here;
	// inline nav-definition editing inside a column is a Stage-2.1
	// deferral), `step_index`, `sort_mode`, `cell_cap`, `mode`, `keep_empty`.
	// A fully controlled component: emits a whole new column via `onChange`,
	// no store access of its own beyond the artifact-header list.
	import { getArtifactHeaders } from '$lib/state';
	import { columnLabel } from '$lib/table/columns';
	import type { Column } from '$lib/api/types';

	type NavColumn = Extract<Column, { kind: 'navigation' }>;

	let {
		column,
		columnIndex,
		columns,
		onChange
	}: {
		column: NavColumn;
		columnIndex: number;
		columns: Column[];
		onChange: (next: NavColumn) => void;
	} = $props();

	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	const priorColumns = $derived(columns.slice(0, columnIndex));

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
	function setRef(e: Event): void {
		const ref = (e.currentTarget as HTMLSelectElement).value;
		onChange({ ...column, navigation: ref ? { ref } : {} });
	}
	function setStepIndex(e: Event): void {
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		onChange({ ...column, step_index: raw === '' ? null : Number(raw) });
	}
	function setSortMode(e: Event): void {
		const v = (e.currentTarget as HTMLSelectElement).value as NavColumn['sort_mode'];
		onChange({ ...column, sort_mode: v });
	}
	function setCellCap(e: Event): void {
		const v = Number((e.currentTarget as HTMLInputElement).value);
		onChange({ ...column, cell_cap: Number.isFinite(v) ? v : column.cell_cap });
	}
	function setMode(e: Event): void {
		const v = (e.currentTarget as HTMLSelectElement).value as NavColumn['mode'];
		onChange({ ...column, mode: v });
	}
	function setKeepEmpty(e: Event): void {
		onChange({ ...column, keep_empty: (e.currentTarget as HTMLInputElement).checked });
	}
</script>

<div
	data-testid="nav-column-editor"
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
		<span class="text-muted-foreground/70">navigation</span>
		<select
			aria-label="Saved navigation for column"
			value={column.navigation.ref ?? ''}
			onchange={setRef}
			class="rounded border border-input bg-card px-1 py-0.5"
		>
			<option value="">Select a saved navigation…</option>
			{#each navHeaders as h (h.id)}
				<option value={h.id}>{h.name}</option>
			{/each}
		</select>
		<label class="flex items-center gap-1">
			step
			<input
				type="number"
				class="w-12 rounded border border-input bg-card px-1 py-0.5"
				value={column.step_index ?? ''}
				oninput={setStepIndex}
			/>
		</label>
	</div>
	<div class="flex flex-wrap items-center gap-2">
		<label class="flex items-center gap-1">
			sort
			<select
				aria-label="Sort mode"
				value={column.sort_mode}
				onchange={setSortMode}
				class="rounded border border-input bg-card px-1 py-0.5"
			>
				<option value="value">value</option>
				<option value="count">count</option>
			</select>
		</label>
		<label class="flex items-center gap-1">
			cap
			<input
				type="number"
				class="w-14 rounded border border-input bg-card px-1 py-0.5"
				value={column.cell_cap}
				oninput={setCellCap}
			/>
		</label>
		<label class="flex items-center gap-1">
			mode
			<select
				aria-label="Cell mode"
				value={column.mode}
				onchange={setMode}
				class="rounded border border-input bg-card px-1 py-0.5"
			>
				<option value="collapse">collapse</option>
				<option value="expand">expand</option>
			</select>
		</label>
		<label class="flex items-center gap-1">
			<input type="checkbox" checked={column.keep_empty} onchange={setKeepEmpty} />
			keep empty
		</label>
	</div>
</div>
