<script lang="ts">
	// Per-column editor for a `property`-kind column: the property `name`
	// (a single combobox — free text with a metamodel-aware suggestion list,
	// so instance-only keys the metamodel doesn't declare still work), the
	// column `source` (mirrors NavigationColumnEditor), the split-into-rows
	// toggle (`mode`), and `keep_empty` (only meaningful while splitting).
	// Fully controlled: emits a whole new column via `onChange`.
	import { getMetamodel } from '$lib/state/metamodel.svelte';
	import {
		effectivePropertiesForTypes,
		propertyDeclared,
		propertyDeclaredMany
	} from '$lib/metamodel/helpers';
	import type { Column, RowSource } from '$lib/api/types';
	import type { PropertyItem } from '$lib/search/property-ops';
	import ColumnSourceEditor from './ColumnSourceEditor.svelte';

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

	// The name field is a COMBOBOX: the input's text is the column's name, and
	// focusing/typing opens a suggestion list filtered by that text. Picking a
	// suggestion just sets the name — free text that matches nothing stays valid.
	let suggestOpen = $state(false);
	let comboEl: HTMLElement | null = $state(null);

	const filtered = $derived.by(() => {
		const q = column.name.trim().toLowerCase();
		if (q === '') return items;
		return items.filter(
			(it) => it.name.toLowerCase().includes(q) || (it.datatype ?? '').toLowerCase().includes(q)
		);
	});

	function pickName(name: string): void {
		suggestOpen = false;
		onChange({ ...column, name });
	}

	function onComboFocusOut(e: FocusEvent): void {
		// Close only when focus truly left the combobox (an option click moves
		// focus within it first).
		if (!comboEl?.contains(e.relatedTarget as Node)) suggestOpen = false;
	}

	function setName(e: Event): void {
		suggestOpen = true;
		onChange({ ...column, name: (e.currentTarget as HTMLInputElement).value });
	}
	// Splitting is provably a no-op when every scoped type declares the property
	// single-valued: grey the toggle out then (with an explaining tooltip). Only
	// a PROVABLE "no" disables — an unknowable source (navigation/chains rows,
	// earlier-column sources: any type may arrive) or an undeclared property
	// (instance data may still hold lists) keeps it enabled, and the backend
	// expands scalars to one row rather than erroring either way. An already-
	// checked stale config also stays enabled so the user can still uncheck it.
	const splitDisabled = $derived.by(() => {
		if (column.mode === 'expand') return false;
		if (mm === null) return false;
		if (column.source.kind !== 'row' || rowSource.kind !== 'scope') return false;
		const name = column.name.trim();
		if (name === '') return false;
		if (!propertyDeclared(mm, rowSource.types, name)) return false;
		return !propertyDeclaredMany(mm, rowSource.types, name);
	});

	function setSplit(e: Event): void {
		const checked = (e.currentTarget as HTMLInputElement).checked;
		onChange({ ...column, mode: checked ? 'expand' : 'collapse' });
	}
	function setKeepEmpty(e: Event): void {
		onChange({ ...column, keep_empty: (e.currentTarget as HTMLInputElement).checked });
	}
</script>

<div
	data-testid="property-column-editor"
	class="mt-1.5 space-y-1.5 rounded border border-border/60 bg-muted/30 p-2 text-[11px]"
>
	<ColumnSourceEditor
		source={column.source}
		{columns}
		{columnIndex}
		{rowSource}
		onSourceChange={(source) => onChange({ ...column, source })}
	/>
	<div class="flex flex-wrap items-center gap-2">
		<span class="text-muted-foreground/70">property</span>
		<div class="relative" bind:this={comboEl} onfocusout={onComboFocusOut}>
			<input
				data-testid="property-name-input"
				aria-label="Property name"
				autocomplete="off"
				class="w-40 rounded border border-input bg-card px-1.5 py-0.5"
				placeholder="property name"
				value={column.name}
				oninput={setName}
				onfocus={() => (suggestOpen = true)}
				onkeydown={(e) => {
					if (e.key === 'Escape') suggestOpen = false;
				}}
			/>
			{#if suggestOpen && filtered.length > 0}
				<ul
					data-testid="property-suggestions"
					class="absolute top-full left-0 z-50 mt-1 max-h-48 w-64 overflow-auto rounded border border-border bg-popover py-1 shadow-xl"
				>
					{#each filtered as it (`${it.name} ${it.datatype ?? ''}`)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-2 px-2 py-1 text-left transition-colors hover:bg-muted"
								onclick={() => pickName(it.name)}
							>
								<span class="truncate text-foreground/90">{it.name}</span>
								<span
									class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
								>
									{it.datatype ?? 'untyped'}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
		<label
			class="flex items-center gap-1 {splitDisabled ? 'opacity-50' : ''}"
			title={splitDisabled
				? 'This property is single-valued for the scoped types — there are no multiple values to split'
				: 'One row per property value instead of listing them all in one cell'}
		>
			<input
				type="checkbox"
				aria-label="Split multiple values in multiple rows"
				checked={column.mode === 'expand'}
				disabled={splitDisabled}
				onchange={setSplit}
			/>
			Split multiple values in multiple rows
		</label>
		<label
			class="flex items-center gap-1"
			title="Keep a row with an empty cell when the property has no value (unchecked drops those rows — with or without splitting)"
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
