<script lang="ts">
	// Per-column editor for a `navigation`-kind column: the column's `source`
	// (a row slot / an earlier column's output), the navigation itself —
	// either a saved-artifact REF or an INLINE definition edited with the
	// real navigation builder — plus `step_index`, `sort_mode`, `cell_cap`,
	// `mode`, `keep_empty`. A fully controlled component: emits a whole new
	// column via `onChange`. Inline mode hosts an EMBEDDED draft in the
	// navigation-editor store (see ensureEmbeddedDraft) and renders
	// NavigationNode against it; the column's stored definition stays the
	// source of truth — the draft is only the editing surface. ColumnManager
	// keys its columns each-block by INDEX, so a reorder/remove does NOT remount
	// this editor: Svelte reuses the instance by screen position and swaps the
	// `column` prop under it. The mirror effect below detects such an external
	// column swap and re-seeds the draft FROM the new column, rather than
	// relying on a remount.
	import { onDestroy } from 'svelte';
	import * as api from '$lib/api/artifacts';
	import {
		closeDraft,
		ensureEmbeddedDraft,
		getArtifactHeaders,
		getDraft,
		setEmbeddedRowElement,
		updateDefinition
	} from '$lib/state';
	import { emptyRowPath } from '$lib/navigation/tree';
	import type { Column, NavigationDefinition, RowSource } from '$lib/api/types';
	import ColumnSourceEditor from './ColumnSourceEditor.svelte';
	import NavigationNode from '../Navigation/NavigationNode.svelte';

	type NavColumn = Extract<Column, { kind: 'navigation' }>;

	let {
		column,
		columnIndex,
		columns,
		rowSource = null,
		sampleRowElementId = null,
		onChange
	}: {
		column: NavColumn;
		columnIndex: number;
		columns: Column[];
		/** The hosting table's row source — gates the chain-step input (only a
		 * `chains` row source has chain slots to pick from). */
		rowSource?: RowSource | null;
		/** The hosting table's first row element — binds row-rooted previews.
		 * Null (no rows) shows the "no row to preview against" hint. */
		sampleRowElementId?: string | null;
		onChange: (next: NavColumn) => void;
	} = $props();

	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));

	// One embedded-draft id per mounted editor instance (never persisted).
	const embId = `navemb:${crypto.randomUUID()}`;

	const inline = $derived(column.navigation.definition != null);
	const embDraft = $derived(getDraft(embId));

	// The last inline definition, kept while in ref mode so toggling
	// saved -> inline -> saved within one mount doesn't lose work. Only the
	// active mode is ever written to the column.
	//
	// `$state.raw`, NOT `$state`: the definition is stored and read back WHOLE
	// (never deep-mutated), and a deep `$state` would hand back a PROXY of it.
	// That proxy would be seeded into the embedded draft and mirrored into the
	// table definition, where the next `structuredClone` dies with
	// DataCloneError ("#<Object> could not be cloned") — permanently bricking
	// every subsequent edit of the table.
	let lastInline = $state.raw<NavigationDefinition | null>(null);
	let seeding = $state(false);

	// The definition object last agreed between this editor's embedded draft and
	// the column prop. Distinguishes a user draft-edit (draft.definition changed)
	// from an EXTERNAL column swap (the column prop was replaced under us by a
	// reorder/remove — index-keyed columns reuse this instance by position). On an
	// external swap we must reseed the draft FROM the new column, not clobber the
	// new column with our stale draft.
	//
	// `$state.raw`, NOT `$state`: this holds a definition purely for REFERENCE
	// comparison. Plain `$state` deep-proxies any object assigned to it, so
	// `colDef !== lastSynced` would compare a raw definition against a proxy of
	// itself and never match (Svelte's `state_proxy_equality_mismatch`),
	// defeating the swap detection. `.raw` stores the reference untouched.
	let lastSynced = $state.raw<NavigationDefinition | null>(null);

	// Lifecycle: an inline column needs its embedded draft (e.g. a saved
	// table reopened with an inline definition already in the payload); a
	// ref-mode column must not leave one behind.
	$effect(() => {
		if (inline && !getDraft(embId)) {
			ensureEmbeddedDraft(embId, column.navigation.definition!, {
				rowContext: true,
				rowElementId: sampleRowElementId
			});
			// Record the seeded state so the first mirror-effect run recognizes
			// the draft and column as in sync (ensureEmbeddedDraft normalizes; for
			// already-normalized definitions normalize returns the SAME ref, so
			// this equals the draft's definition).
			lastSynced = column.navigation.definition!;
		} else if (!inline && getDraft(embId)) {
			closeDraft(embId);
		}
	});

	// Keep the embedded draft and the column definition in sync, in the correct
	// DIRECTION. `lastSynced` is the definition both last agreed on:
	//   - colDef === draftDef: already in sync (record it, no-op).
	//   - colDef !== lastSynced: the COLUMN changed from what we last agreed on
	//     → an EXTERNAL swap (this index-keyed instance was reused for a
	//     different column by a reorder/remove). Reseed the draft from the
	//     column; do NOT push the stale draft onto the new column.
	//   - otherwise the DRAFT changed (user edited via NavigationNode) while the
	//     column still holds lastSynced → mirror draft → column.
	// Terminates: reseed sets draft.definition = colDef (updateDefinition assigns
	// by reference); the draft mirror round-trips through ColumnManager, which
	// preserves the definition ref, so the next run is in sync either way.
	$effect(() => {
		if (!inline || !embDraft) return;
		const colDef = column.navigation.definition!;
		const draftDef = embDraft.definition;
		if (colDef === draftDef) {
			lastSynced = colDef; // in sync
			return;
		}
		if (colDef !== lastSynced) {
			updateDefinition(embId, colDef);
			lastSynced = colDef;
		} else {
			onChange({ ...column, navigation: { definition: draftDef } });
			lastSynced = draftDef;
		}
	});

	// Keep the preview row binding in sync with the hosting table's rows.
	$effect(() => {
		if (getDraft(embId)) setEmbeddedRowElement(embId, sampleRowElementId);
	});

	onDestroy(() => closeDraft(embId));

	async function switchToInline(): Promise<void> {
		if (inline || seeding) return;
		// Seed preference: the in-memory definition from an earlier toggle, a
		// COPY of the currently selected saved navigation ("customize this
		// one"), then a fresh row-rooted path.
		let seed: NavigationDefinition | null = lastInline;
		if (!seed && column.navigation.ref) {
			seeding = true;
			try {
				const artifact = await api.getArtifact(column.navigation.ref);
				seed = artifact.payload as unknown as NavigationDefinition;
			} catch {
				seed = null; // unknown/foreign ref: fall through to a fresh path
			} finally {
				seeding = false;
			}
		}
		const draft = ensureEmbeddedDraft(embId, seed ?? emptyRowPath(), {
			rowContext: true,
			rowElementId: sampleRowElementId
		});
		// Write the draft's (normalized) definition so the mirror effect's
		// reference-equality guard holds from the first render.
		onChange({ ...column, navigation: { definition: draft.definition } });
		lastSynced = draft.definition;
	}

	function switchToRef(): void {
		if (!inline) return;
		lastInline = column.navigation.definition ?? null;
		closeDraft(embId);
		onChange({ ...column, navigation: {} });
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
		// The schema requires cell_cap >= 1 — a cleared/zero/negative input must
		// not reach the definition (it would 422 every evaluate of the table).
		const v = Math.floor(Number((e.currentTarget as HTMLInputElement).value));
		onChange({ ...column, cell_cap: Number.isFinite(v) && v >= 1 ? v : column.cell_cap });
	}
	function setSplit(e: Event): void {
		const checked = (e.currentTarget as HTMLInputElement).checked;
		onChange({ ...column, mode: checked ? 'expand' : 'collapse' });
	}
	function setKeepEmpty(e: Event): void {
		onChange({ ...column, keep_empty: (e.currentTarget as HTMLInputElement).checked });
	}
</script>

<div
	data-testid="nav-column-editor"
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
		<span class="text-muted-foreground/70">navigation</span>
		<div class="flex overflow-hidden rounded border border-input">
			<button
				type="button"
				data-testid="nav-mode-ref"
				class="px-1.5 py-0.5 {inline ? 'hover:bg-muted' : 'bg-muted font-medium'}"
				disabled={seeding}
				onclick={switchToRef}
			>
				saved
			</button>
			<button
				type="button"
				data-testid="nav-mode-inline"
				class="border-l border-input px-1.5 py-0.5 {inline
					? 'bg-muted font-medium'
					: 'hover:bg-muted'}"
				disabled={seeding}
				onclick={switchToInline}
			>
				inline
			</button>
		</div>
		{#if !inline}
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
		{/if}
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
	{#if inline && embDraft}
		<div data-testid="inline-nav-editor" class="mt-1">
			<NavigationNode tabId={embId} path={[]} />
		</div>
	{/if}
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
		<label
			class="flex items-center gap-1"
			title="One row per reached element instead of listing them all in one cell"
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
			title="Keep a row with an empty cell when nothing is reached (unchecked drops those rows — with or without splitting)"
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
