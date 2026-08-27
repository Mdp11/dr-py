<script lang="ts">
	// Shared column-source row: kind select (Row / Earlier column), a
	// chain-step picker for a `chains` row source, and an earlier-column
	// select — identical in NavigationColumnEditor and PropertyColumnEditor,
	// so it lives here once. When the selected earlier column is itself a
	// `navigation` column, also renders a "Step to use" picker bound to
	// `source.step_index` (ColumnRef.step_index: which chain step of THAT
	// navigation this column reads; null = the referenced column's own
	// projection). Both step fields are ChainStepSelects listing the steps by
	// the numbers the navigation editor badges. Fully controlled: emits a whole
	// new `ColumnSource` via `onSourceChange`; callers spread
	// `{ ...column, source }`.
	import * as api from '$lib/api/artifacts';
	import { columnLabel } from '$lib/table/columns';
	import { chainStepOptions } from '$lib/table/chain-steps';
	import type { Column, ColumnSource, NavigationDefinition, RowSource } from '$lib/api/types';
	import ChainStepSelect from './ChainStepSelect.svelte';

	let {
		source,
		columns,
		columnIndex,
		rowSource,
		allowRow = true,
		label = 'source',
		onSourceChange
	}: {
		source: ColumnSource;
		columns: Column[];
		columnIndex: number;
		rowSource: RowSource | null;
		/** false hides the kind select and pins this editor to `column` refs —
		 * for a column-only caller (ScriptInputsEditor) whose source is never a
		 * row slot. */
		allowRow?: boolean;
		label?: string;
		onSourceChange: (next: ColumnSource) => void;
	} = $props();

	const priorColumns = $derived(columns.slice(0, columnIndex));

	const refColumn = $derived(source.kind === 'column' ? (columns[source.index] ?? null) : null);

	// The navigation behind each step field — the ROW SOURCE's for `chain step`,
	// the REFERENCED COLUMN's for `Step to use` — resolved so both fields can
	// LIST their steps by name instead of asking for a bare number. Inline
	// definitions are read synchronously; a saved ref is fetched once and cached
	// per artifact id. While a definition is unknown the field degrades to an
	// unconstrained numeric input — the backend still 422s an out-of-range value.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- control state, never read from templates
	const defnCache = new Map<string, NavigationDefinition>();
	// `$state.raw`: definitions are stored and read back WHOLE. A deep `$state`
	// would hand back a PROXY that could reach a table definition and break its
	// next `structuredClone` (see NavigationColumnEditor's lastInline note).
	let rowNavDefn = $state.raw<NavigationDefinition | null>(null);
	let refNavDefn = $state.raw<NavigationDefinition | null>(null);

	/** Resolve a navigation source to a definition, fetching a saved ref once.
	 * `wantedRef` re-reads the CURRENT ref when the fetch lands, so a field that
	 * moved on meanwhile (another column picked, another row source) is not
	 * overwritten with a stale payload. */
	function resolveNav(
		nav: { ref?: string | null; definition?: NavigationDefinition | null } | null,
		assign: (defn: NavigationDefinition | null) => void,
		wantedRef: () => string | null
	): void {
		if (nav?.definition) {
			assign(nav.definition);
			return;
		}
		const ref = nav?.ref ?? null;
		if (!ref) {
			assign(null);
			return;
		}
		const cached = defnCache.get(ref);
		if (cached) {
			assign(cached);
			return;
		}
		assign(null);
		void api
			.getArtifact(ref)
			.then((a) => {
				const defn = a.payload as unknown as NavigationDefinition;
				defnCache.set(ref, defn);
				if (wantedRef() === ref) assign(defn);
			})
			.catch(() => {}); // unknown/foreign ref: stays unconstrained
	}

	$effect(() => {
		resolveNav(
			rowSource?.kind === 'chains' ? rowSource.navigation : null,
			(d) => (rowNavDefn = d),
			() => (rowSource?.kind === 'chains' ? (rowSource.navigation.ref ?? null) : null)
		);
	});
	$effect(() => {
		resolveNav(
			refColumn?.kind === 'navigation' ? refColumn.navigation : null,
			(d) => (refNavDefn = d),
			() => (refColumn?.kind === 'navigation' ? (refColumn.navigation.ref ?? null) : null)
		);
	});

	const rowStepOptions = $derived(chainStepOptions(rowNavDefn));
	const refStepOptions = $derived(chainStepOptions(refNavDefn));

	// Re-clamp a stored step_index the referenced chain no longer has (it
	// shrank under us), mirroring NavigationColumnEditor/RowSourceEditor.
	// Converges: after the clamped write the condition is false.
	$effect(() => {
		if (source.kind !== 'column' || source.step_index == null || refStepOptions === null) return;
		const max = refStepOptions.length - 1;
		if (source.step_index > max) onSourceChange({ ...source, step_index: max });
	});

	function setSourceKind(e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value;
		if (kind === 'row') onSourceChange({ kind: 'row', chain_index: 0 });
		else {
			const index = priorColumns.length > 0 ? priorColumns.length - 1 : 0;
			onSourceChange({ kind: 'column', index, step_index: null });
		}
	}
	function setSourceChainIndex(next: number | null): void {
		onSourceChange({ kind: 'row', chain_index: next ?? 0 });
	}
	function setSourceColumnIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLSelectElement).value) || 0;
		onSourceChange({ kind: 'column', index: v, step_index: null });
	}
	function setStepIndex(next: number | null): void {
		if (source.kind !== 'column') return;
		// null = the referenced column's own projection. The picker only offers
		// steps that chain has; a number typed into its fallback (chain still
		// unknown) is re-clamped by the effect above once the payload arrives.
		onSourceChange({ ...source, step_index: next });
	}
</script>

<div class="flex flex-wrap items-center gap-2">
	<span class="text-muted-foreground/70">{label}</span>
	{#if allowRow}
		<select
			aria-label="Column source kind"
			value={source.kind}
			onchange={setSourceKind}
			class="rounded border border-input bg-card px-1 py-0.5"
		>
			<option value="row">Row</option>
			<option value="column" disabled={priorColumns.length === 0}>Earlier column</option>
		</select>
	{/if}
	{#if source.kind === 'row'}
		<!-- chain_index only means something for a `chains` row source (it picks
		     which chain step the column reads); the schema rejects != 0 for any
		     other row source, so don't offer it there. -->
		{#if rowSource?.kind === 'chains'}
			<label
				class="flex items-center gap-1"
				title="Which step of the row's chain this column reads"
			>
				chain step
				<ChainStepSelect
					options={rowStepOptions}
					value={source.chain_index}
					ariaLabel="Chain step"
					testId="source-chain-index"
					onChange={setSourceChainIndex}
				/>
			</label>
		{/if}
	{:else}
		<select
			aria-label="Source column"
			value={source.index}
			onchange={setSourceColumnIndex}
			class="rounded border border-input bg-card px-1 py-0.5"
		>
			{#each priorColumns as c, i (i)}
				<option value={i}>{i}: {columnLabel(c)}</option>
			{/each}
		</select>
		{#if refColumn?.kind === 'navigation'}
			<label
				class="flex items-center gap-1"
				title="Which chain step of that navigation this column reads"
			>
				Step to use
				<ChainStepSelect
					options={refStepOptions}
					value={source.step_index}
					emptyLabel="column's step"
					ariaLabel="Step to use"
					testId="source-step-index"
					onChange={setStepIndex}
				/>
			</label>
		{/if}
	{/if}
</div>
