<script lang="ts">
	// Shared column-source row: kind select (Row / Earlier column), a
	// chain-step input for a `chains` row source, and an earlier-column
	// select — identical in NavigationColumnEditor and PropertyColumnEditor,
	// so it lives here once. When the selected earlier column is itself a
	// `navigation` column, also renders a "Step to use" numeric input bound to
	// `source.step_index` (ColumnRef.step_index: which chain step of THAT
	// navigation this column reads; null = the referenced column's own
	// projection). Fully controlled: emits a whole new `ColumnSource` via
	// `onSourceChange`; callers spread `{ ...column, source }`.
	import * as api from '$lib/api/artifacts';
	import { columnLabel, navMaxStepIndex } from '$lib/table/columns';
	import type { Column, ColumnSource, NavigationDefinition, RowSource } from '$lib/api/types';

	let {
		source,
		columns,
		columnIndex,
		rowSource,
		onSourceChange
	}: {
		source: ColumnSource;
		columns: Column[];
		columnIndex: number;
		rowSource: RowSource | null;
		onSourceChange: (next: ColumnSource) => void;
	} = $props();

	const priorColumns = $derived(columns.slice(0, columnIndex));

	const refColumn = $derived(source.kind === 'column' ? (columns[source.index] ?? null) : null);
	// Max addressable chain step of the referenced navigation: inline
	// definitions are computed synchronously; a saved ref is fetched once and
	// cached per artifact id. While unknown the input is unconstrained — the
	// backend still 422s an out-of-range value.
	const stepCache = new Map<string, number>(); // control state, not reactive
	let refMaxStep = $state<number | null>(null);
	$effect(() => {
		if (refColumn?.kind !== 'navigation') {
			refMaxStep = null;
			return;
		}
		const nav = refColumn.navigation;
		if (nav.definition) {
			refMaxStep = navMaxStepIndex(nav.definition);
			return;
		}
		if (!nav.ref) {
			refMaxStep = null;
			return;
		}
		const cached = stepCache.get(nav.ref);
		if (cached !== undefined) {
			refMaxStep = cached;
			return;
		}
		refMaxStep = null;
		const ref = nav.ref;
		void api
			.getArtifact(ref)
			.then((a) => {
				const max = navMaxStepIndex(a.payload as unknown as NavigationDefinition);
				stepCache.set(ref, max);
				if (refColumn?.kind === 'navigation' && refColumn.navigation.ref === ref) refMaxStep = max;
			})
			.catch(() => {});
	});

	function setSourceKind(e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value;
		if (kind === 'row') onSourceChange({ kind: 'row', chain_index: 0 });
		else {
			const index = priorColumns.length > 0 ? priorColumns.length - 1 : 0;
			onSourceChange({ kind: 'column', index, step_index: null });
		}
	}
	function setSourceChainIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLInputElement).value) || 0;
		onSourceChange({ kind: 'row', chain_index: v });
	}
	function setSourceColumnIndex(e: Event): void {
		const v = Number((e.currentTarget as HTMLSelectElement).value) || 0;
		onSourceChange({ kind: 'column', index: v, step_index: null });
	}
	function setStepIndex(e: Event): void {
		if (source.kind !== 'column') return;
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		let v = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
		if (v !== null && !Number.isFinite(v)) v = null;
		if (v !== null && refMaxStep !== null) v = Math.min(v, refMaxStep);
		onSourceChange({ ...source, step_index: v });
	}
</script>

<div class="flex flex-wrap items-center gap-2">
	<span class="text-muted-foreground/70">source</span>
	<select
		aria-label="Column source kind"
		value={source.kind}
		onchange={setSourceKind}
		class="rounded border border-input bg-card px-1 py-0.5"
	>
		<option value="row">Row</option>
		<option value="column" disabled={priorColumns.length === 0}>Earlier column</option>
	</select>
	{#if source.kind === 'row'}
		<!-- chain_index only means something for a `chains` row source (it picks
		     which chain step the column reads); the schema rejects != 0 for any
		     other row source, so don't offer it there. -->
		{#if rowSource?.kind === 'chains'}
			<label
				class="flex items-center gap-1"
				title="Which step of the row's chain this column reads (0 = the chain's first element)"
			>
				chain step
				<input
					type="number"
					min="0"
					class="w-12 rounded border border-input bg-card px-1 py-0.5"
					value={source.chain_index}
					oninput={setSourceChainIndex}
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
				title="Which chain step of that navigation this column reads (0 = its start; empty = the step the column itself shows)"
			>
				Step to use
				<input
					data-testid="source-step-index"
					type="number"
					min="0"
					max={refMaxStep ?? undefined}
					placeholder="column's step"
					class="w-20 rounded border border-input bg-card px-1 py-0.5"
					value={source.step_index ?? ''}
					oninput={setStepIndex}
				/>
			</label>
		{/if}
	{/if}
</div>
