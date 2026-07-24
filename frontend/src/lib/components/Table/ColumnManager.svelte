<script lang="ts">
	// The definition-editing panel: the table's scope (RowSourceEditor) at the
	// top, then a list of columns with per-column controls (rename, reorder,
	// remove — each routed through the pure `columns.ts` helper for that
	// operation, then `updateTableDefinition`), then add buttons for the
	// property/navigation column kinds. `removeColumn`/`moveColumn` can throw
	// (`ColumnInUseError` / a forward-ref error) when the edit would leave a
	// dangling `ColumnRef` — both are caught here and surfaced as an inline
	// message instead of propagating.
	import {
		getTableDraft,
		getTablePage,
		remapTableSortForInsert,
		remapTableSortForMove,
		remapTableSortForRemove,
		updateTableDefinition
	} from '$lib/state';
	import {
		ColumnInUseError,
		addColumn,
		cloneColumn,
		columnKindLabel,
		columnLabel,
		moveColumn,
		newNavigationColumn,
		newPropertyColumn,
		newScriptColumn,
		removeColumn,
		renameColumn,
		replaceColumn
	} from '$lib/table/columns';
	import { createColumnDrag } from '$lib/table/column-dnd.svelte';
	import type { Column, TableDefinition } from '$lib/api/types';
	import { Copy, Eye, EyeOff } from '@lucide/svelte';
	import NavigationColumnEditor from './NavigationColumnEditor.svelte';
	import PropertyColumnEditor from './PropertyColumnEditor.svelte';
	import RowSourceEditor from './RowSourceEditor.svelte';
	import ScriptColumnEditor from './ScriptColumnEditor.svelte';

	let { tabId, focusIndex = null }: { tabId: string; focusIndex?: number | null } = $props();

	const draft = $derived(getTableDraft(tabId));
	const defn = $derived(draft?.definition);

	// The table's first row element binds row-rooted inline-navigation
	// previews (RowStart needs a sample). key[0] is the base row element id
	// for every row-source kind; non-string (missing page / null slot) means
	// "no row" and the embedded editors show a hint instead of previewing.
	const page = $derived(getTablePage(tabId));
	const sampleRowElementId = $derived.by(() => {
		const k = page?.rows?.[0]?.key?.[0];
		return typeof k === 'string' ? k : null;
	});

	let error = $state<string | null>(null);

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

	// The scope (element) column is the row's own binding: with the "+ Element
	// column" button gone, the last remaining element column must not be
	// removable, or the table loses its base column for good. Extra element
	// columns (a chains-derived table has one per chain step) stay removable.
	const elementColumnCount = $derived(
		defn?.columns.filter((c) => c.kind === 'element').length ?? 0
	);

	function onRename(index: number, header: string): void {
		if (!defn) return;
		apply(renameColumn(defn, index, header));
	}

	// Header typing used to be debounced 400ms, because every applied
	// definition edit re-evaluated the whole table and committing per keystroke
	// refetched the grid once per character. This panel only ever renders
	// inside the settings dialog, which now STAGES definition edits until it
	// closes (see TableView's openSettings / table-editor's `_suspended`), so a
	// per-keystroke apply costs a draft object and nothing else — and dropping
	// the timer removes its one sharp edge: a rename typed and then Escaped
	// within the debounce window was silently discarded, since `change` never
	// fires for an input that is unmounted while still focused.

	// remove/move shift column indices, so the active sort must be remapped in
	// the same breath (the remap runs only after the mutator succeeds — a
	// ColumnInUseError/forward-ref throw leaves definition AND sort untouched).
	function onRemove(index: number): void {
		if (!defn) return;
		const current = defn;
		tryApply(() => {
			const next = removeColumn(current, index);
			remapTableSortForRemove(tabId, index);
			return next;
		});
	}

	// Insert a deep copy right after the original. The sort is remapped in the
	// same breath (a sort at/past the insertion point must follow its column),
	// mirroring how onRemove/onMove pair their mutator with a sort remap.
	function onClone(index: number): void {
		if (!defn) return;
		const current = defn;
		tryApply(() => {
			const next = cloneColumn(current, index);
			remapTableSortForInsert(tabId, index + 1);
			return next;
		});
	}

	function onMove(index: number, dir: 'up' | 'down'): void {
		if (!defn) return;
		const to = dir === 'up' ? index - 1 : index + 1;
		if (to < 0 || to >= defn.columns.length) return;
		const current = defn;
		tryApply(() => {
			const next = moveColumn(current, index, to);
			remapTableSortForMove(tabId, index, to);
			return next;
		});
	}

	// Pointer-driven grip drag (mouse/touch/pen), alongside the ↑/↓ buttons kept
	// as the keyboard/screen-reader-reachable fallback. `getDefinition` reads
	// the CURRENT `defn` on every move (not a snapshot at drag-start) so the
	// forward-ref validity check stays correct even if the definition changes
	// underneath the drag.
	const drag = createColumnDrag({
		attr: 'data-col-drop',
		axis: 'y',
		getDefinition: () => defn,
		onDrop: (fromIdx, toIdx) => {
			const current = defn;
			if (!current) return;
			tryApply(() => {
				const next = moveColumn(current, fromIdx, toIdx);
				remapTableSortForMove(tabId, fromIdx, toIdx);
				return next;
			});
		}
	});

	function addPropertyColumn(): void {
		if (!defn) return;
		apply(addColumn(defn, newPropertyColumn()));
	}

	function addNavigationColumn(): void {
		if (!defn) return;
		apply(addColumn(defn, newNavigationColumn()));
	}

	function addScriptColumn(): void {
		if (!defn) return;
		apply(addColumn(defn, newScriptColumn()));
	}

	// Whole-column field replacement for the per-column editors: a same-shape
	// field patch (sort_mode, cell_cap, mode, keep_empty, source, navigation
	// ref/step_index) has none of the structural-ref concerns the add/remove/
	// move mutators guard, so `replaceColumn` just clones the definition and
	// swaps the one column in — routed through the same `updateTableDefinition`
	// as every other edit here.
	function onColumnChange(index: number, next: Column): void {
		if (!defn) return;
		apply(replaceColumn(defn, index, next));
	}
</script>

{#if defn}
	<div data-testid="column-manager" class="space-y-3 text-xs">
		{#if focusIndex === null}
			<RowSourceEditor {tabId} {defn} />
			<label
				class="flex w-fit items-center gap-1.5"
				title="Show a numbered first column (1-based, follows the current sort; also included in Excel exports)"
			>
				<input
					type="checkbox"
					data-testid="toggle-row-numbers"
					checked={defn.show_row_numbers}
					onchange={(e) =>
						apply({ ...defn, show_row_numbers: (e.currentTarget as HTMLInputElement).checked })}
				/>
				Show row numbers
			</label>
		{/if}

		{#if error}
			<p data-testid="column-manager-error" class="text-destructive">{error}</p>
		{/if}

		<div class="space-y-1.5">
			{#each defn.columns as col, i (i)}
				{#if focusIndex === null || focusIndex === i}
					<div
						class="rounded border border-border/70 p-1.5"
						data-col-drop={i}
						style="transform:translateY({drag.offsetOf(i)}px)"
						class:transition-transform={drag.dragging}
						class:duration-150={drag.dragging}
						class:ring-1={drag.over === i && drag.from !== null && !drag.valid}
						class:ring-destructive={drag.over === i && drag.from !== null && !drag.valid}
						class:opacity-50={drag.from === i}
					>
						<div class="flex flex-wrap items-center gap-1.5" class:opacity-60={col.hidden}>
							{#if focusIndex === null}
								<span
									role="button"
									tabindex="-1"
									data-testid="drag-column-{i}"
									aria-label="Drag to reorder"
									title="Drag to reorder"
									class="shrink-0 cursor-grab touch-none select-none text-muted-foreground/50"
									onpointerdown={(e) => drag.onPointerDown(e, i)}
									onpointermove={(e) => drag.onPointerMove(e)}
									onpointerup={(e) => drag.onPointerUp(e)}
									onpointercancel={(e) => drag.onPointerCancel(e)}>⠿</span
								>
							{/if}
							<span class="w-4 shrink-0 text-center font-mono text-[10px] text-muted-foreground/70">
								{i}
							</span>
							<span
								class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground uppercase"
							>
								{columnKindLabel(col.kind)}
							</span>
							<input
								class="min-w-0 flex-1 rounded border border-input bg-card px-1.5 py-0.5"
								placeholder={columnLabel(col)}
								value={col.header}
								oninput={(e) => onRename(i, (e.currentTarget as HTMLInputElement).value)}
							/>
							{#if focusIndex === null}
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
							{/if}
							<button
								type="button"
								data-testid="toggle-hidden-{i}"
								class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted"
								aria-label={col.hidden ? 'Show column' : 'Hide column'}
								title={col.hidden
									? 'Show this column in the table and exports again'
									: 'Hide from the table and exports — still computed and usable as an "Earlier column" source'}
								onclick={() => onColumnChange(i, { ...col, hidden: !col.hidden })}
							>
								{#if col.hidden}<EyeOff class="size-3" data-testid="eye-off-icon" />{:else}<Eye
										class="size-3"
									/>{/if}
							</button>
							{#if focusIndex === null}
								<button
									type="button"
									data-testid="clone-column-{i}"
									class="rounded border border-input px-1 py-0.5 text-[10px] hover:bg-muted"
									aria-label="Duplicate column"
									title="Duplicate this column (inserted below)"
									onclick={() => onClone(i)}
								>
									<Copy class="size-3" />
								</button>
								<button
									type="button"
									data-testid="remove-column-{i}"
									class="rounded border border-destructive/40 px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10 disabled:opacity-30"
									disabled={col.kind === 'element' && elementColumnCount <= 1}
									title={col.kind === 'element' && elementColumnCount <= 1
										? 'The scope column cannot be removed'
										: 'Remove this column'}
									onclick={() => onRemove(i)}
								>
									remove
								</button>
							{/if}
						</div>
						{#if col.kind === 'navigation'}
							<NavigationColumnEditor
								column={col}
								columnIndex={i}
								columns={defn.columns}
								rowSource={defn.row_source}
								{sampleRowElementId}
								onChange={(next) => onColumnChange(i, next)}
							/>
						{:else if col.kind === 'property'}
							<PropertyColumnEditor
								column={col}
								columnIndex={i}
								columns={defn.columns}
								rowSource={defn.row_source}
								onChange={(next) => onColumnChange(i, next)}
							/>
						{:else if col.kind === 'script'}
							<ScriptColumnEditor
								column={col}
								columnIndex={i}
								columns={defn.columns}
								rowSource={defn.row_source}
								{tabId}
								onChange={(next) => onColumnChange(i, next)}
							/>
						{/if}
					</div>
				{/if}
			{/each}
		</div>

		{#if drag.dragging && drag.ghost && drag.ghost.w > 0 && drag.from !== null}
			{@const dragCol = defn.columns[drag.from]}
			<!-- Detached drag ghost: a slim copy of the grabbed row following the
			     pointer (position:fixed so the settings panel doesn't clip it). -->
			<div
				data-testid="column-drag-ghost"
				class="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded border border-primary/40 bg-card p-1.5 text-xs opacity-90 shadow-lg"
				style="left:{drag.ghost.x}px; top:{drag.ghost.y}px; width:{drag.ghost.w}px"
			>
				<span class="shrink-0 text-muted-foreground/50">⠿</span>
				<span
					class="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground uppercase"
				>
					{dragCol ? columnKindLabel(dragCol.kind) : ''}
				</span>
				<span class="truncate">{dragCol ? dragCol.header || columnLabel(dragCol) : ''}</span>
			</div>
		{/if}

		{#if focusIndex === null}
			<div class="flex flex-wrap items-center gap-2 border-t border-border pt-2">
				<button
					type="button"
					data-testid="add-property-column"
					class="rounded border border-input px-2 py-1 text-[11px] hover:bg-muted"
					onclick={addPropertyColumn}
				>
					+ Property
				</button>
				<button
					type="button"
					data-testid="add-navigation-column"
					class="rounded border border-input px-2 py-1 text-[11px] hover:bg-muted"
					onclick={addNavigationColumn}
				>
					+ Navigation
				</button>
				<button
					type="button"
					data-testid="add-script-column"
					class="rounded border border-input px-2 py-1 text-[11px] hover:bg-muted"
					onclick={addScriptColumn}
				>
					+ Script
				</button>
			</div>
		{/if}
	</div>
{/if}
