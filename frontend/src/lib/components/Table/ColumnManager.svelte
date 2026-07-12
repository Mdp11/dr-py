<script lang="ts">
	// The definition-editing panel: row source at the top (RowSourceEditor),
	// then a list of columns with per-column controls (rename, mode toggle,
	// reorder, remove — each routed through the pure `columns.ts` helper for
	// that operation, then `updateTableDefinition`), then add buttons for the
	// three column kinds. `removeColumn`/`moveColumn` can throw
	// (`ColumnInUseError` / a forward-ref error) when the edit would leave a
	// dangling `ColumnRef` — both are caught here and surfaced as an inline
	// message instead of propagating.
	import { getTableDraft, updateTableDefinition } from '$lib/state';
	import {
		ColumnInUseError,
		addColumn,
		columnLabel,
		moveColumn,
		removeColumn,
		renameColumn,
		setColumnMode
	} from '$lib/table/columns';
	import type { Column, TableDefinition } from '$lib/api/types';
	import NavigationColumnEditor from './NavigationColumnEditor.svelte';
	import RowSourceEditor from './RowSourceEditor.svelte';

	let { tabId }: { tabId: string } = $props();

	const draft = $derived(getTableDraft(tabId));
	const defn = $derived(draft?.definition);

	let error = $state<string | null>(null);
	// Free-text property name (Stage 2 sanctioned shortcut — no metamodel
	// effective-properties fetch here; see task report for the rationale).
	let newPropertyName = $state('');

	function apply(next: TableDefinition): void {
		error = null;
		updateTableDefinition(tabId, next);
	}

	function tryApply(build: () => TableDefinition): void {
		try {
			apply(build());
		} catch (e) {
			error = e instanceof ColumnInUseError || e instanceof Error ? e.message : String(e);
		}
	}

	function onRename(index: number, header: string): void {
		if (!defn) return;
		apply(renameColumn(defn, index, header));
	}

	function onModeToggle(index: number, mode: 'collapse' | 'expand'): void {
		if (!defn) return;
		apply(setColumnMode(defn, index, mode));
	}

	function onRemove(index: number): void {
		if (!defn) return;
		const current = defn;
		tryApply(() => removeColumn(current, index));
	}

	function onMove(index: number, dir: 'up' | 'down'): void {
		if (!defn) return;
		const to = dir === 'up' ? index - 1 : index + 1;
		if (to < 0 || to >= defn.columns.length) return;
		const current = defn;
		tryApply(() => moveColumn(current, index, to));
	}

	function addElementColumn(): void {
		if (!defn) return;
		apply(
			addColumn(defn, {
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: '',
				width_px: null
			})
		);
	}

	function addPropertyColumn(): void {
		if (!defn) return;
		apply(
			addColumn(defn, {
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: newPropertyName.trim(),
				mode: 'collapse',
				keep_empty: true,
				header: '',
				width_px: null
			})
		);
		newPropertyName = '';
	}

	function addNavigationColumn(): void {
		if (!defn) return;
		apply(
			addColumn(defn, {
				kind: 'navigation',
				source: { kind: 'row', chain_index: 0 },
				navigation: {},
				step_index: null,
				mode: 'collapse',
				keep_empty: true,
				sort_mode: 'value',
				cell_cap: 20,
				header: '',
				width_px: null
			})
		);
	}

	// Whole-column field replacement for the nav-column editor: none of the
	// existing columns.ts mutators fit (those guard structural ref integrity
	// on add/remove/move; a same-shape field patch — sort_mode, cell_cap,
	// mode, keep_empty, source, navigation ref/step_index — has none of those
	// concerns), so this clones the definition and swaps the one column in
	// place before routing through the same `updateTableDefinition` as every
	// other edit here.
	function onNavColumnChange(index: number, next: Column): void {
		if (!defn) return;
		const clone = structuredClone(defn);
		clone.columns[index] = next;
		apply(clone);
	}
</script>

{#if defn}
	<div data-testid="column-manager" class="space-y-3 border-b border-border p-3 text-xs">
		<RowSourceEditor {tabId} {defn} />

		{#if error}
			<p data-testid="column-manager-error" class="text-destructive">{error}</p>
		{/if}

		<div class="space-y-1.5">
			{#each defn.columns as col, i (i)}
				<div class="rounded border border-border/70 p-1.5">
					<div class="flex flex-wrap items-center gap-1.5">
						<span class="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground/70">
							{i}
						</span>
						<span
							class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground uppercase"
						>
							{col.kind}
						</span>
						<input
							class="min-w-0 flex-1 rounded border border-input bg-card px-1.5 py-0.5"
							placeholder={columnLabel(col)}
							value={col.header}
							oninput={(e) => onRename(i, (e.currentTarget as HTMLInputElement).value)}
						/>
						{#if col.kind !== 'element'}
							<button
								type="button"
								class="rounded border border-input px-1.5 py-0.5 text-[10px] hover:bg-muted"
								onclick={() => onModeToggle(i, col.mode === 'expand' ? 'collapse' : 'expand')}
							>
								{col.mode}
							</button>
						{/if}
						<button
							type="button"
							data-testid="move-up-{i}"
							class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted disabled:opacity-30"
							disabled={i === 0}
							onclick={() => onMove(i, 'up')}
						>
							&uarr;
						</button>
						<button
							type="button"
							data-testid="move-down-{i}"
							class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted disabled:opacity-30"
							disabled={i === defn.columns.length - 1}
							onclick={() => onMove(i, 'down')}
						>
							&darr;
						</button>
						<button
							type="button"
							data-testid="remove-column-{i}"
							class="rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
							onclick={() => onRemove(i)}
						>
							remove
						</button>
					</div>
					{#if col.kind === 'navigation'}
						<NavigationColumnEditor
							column={col}
							columnIndex={i}
							columns={defn.columns}
							onChange={(next) => onNavColumnChange(i, next)}
						/>
					{/if}
				</div>
			{/each}
		</div>

		<div class="flex flex-wrap items-center gap-2 border-t border-border pt-2">
			<button
				type="button"
				data-testid="add-element-column"
				class="rounded border border-input px-2 py-1 text-[11px] hover:bg-muted"
				onclick={addElementColumn}
			>
				+ Element column
			</button>
			<input
				class="w-32 rounded border border-input bg-card px-1.5 py-0.5 text-[11px]"
				placeholder="property name"
				bind:value={newPropertyName}
			/>
			<button
				type="button"
				data-testid="add-property-column"
				class="rounded border border-input px-2 py-1 text-[11px] hover:bg-muted"
				onclick={addPropertyColumn}
			>
				+ Property column
			</button>
			<button
				type="button"
				data-testid="add-navigation-column"
				class="rounded border border-input px-2 py-1 text-[11px] hover:bg-muted"
				onclick={addNavigationColumn}
			>
				+ Navigation column
			</button>
		</div>
	</div>
{/if}
