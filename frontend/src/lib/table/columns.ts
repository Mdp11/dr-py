/**
 * Pure column-edit helpers over a TableDefinition. Every
 * mutator returns a NEW TableDefinition — the input is never mutated. No
 * Svelte, no store, no I/O — fully unit-testable, mirroring
 * `lib/navigation/tree.ts`.
 *
 * Two subtleties worth flagging:
 *
 * 1. `moveColumn` must remap every `ColumnSource` of kind 'column' (a
 *    `ColumnRef`) to its source column's NEW position after the reorder, and
 *    reject a move that would leave a ref pointing at or past its own new
 *    position (columns may only source columns that precede them — a forward
 *    or self reference is not evaluable).
 *
 * 2. Every mutator is COPY-ON-WRITE at column granularity: untouched columns
 *    keep their object identity across the edit (only the definition object,
 *    the columns array, and the specific column(s) actually changed are new).
 *    NavigationColumnEditor's draft-mirror loop guard compares
 *    `columns[i].navigation.definition` BY REFERENCE to tell "the user edited
 *    the embedded draft" apart from "this index-keyed editor instance was
 *    handed a different column" — a deep clone here would break every mounted
 *    inline-navigation column's identity on every unrelated edit, blanking
 *    and re-running its live preview each time. (Deep cloning was also how a
 *    leaked `$state` proxy once bricked tables via `structuredClone` —
 *    reference-preserving copies sidestep that entire class of failure.)
 */
import type {
	Column,
	ColumnExportOptions,
	JsonColumnOptions,
	JsonSplitOptions,
	NavigationDefinition,
	RowNumberExportOptions,
	TableDefinition
} from '$lib/api/types';
import { chainColumns } from '$lib/navigation/tree';
import { ROW_NUMBER_SLOT, columnIncluded, displayOrder, exportEntries } from './export-layout';

export class ColumnInUseError extends Error {}

/** Shallow copy-on-write shell: fresh definition + fresh columns array,
 * every column kept by reference (see module doc, subtlety 2). */
function clone(defn: TableDefinition): TableDefinition {
	return { ...defn, columns: defn.columns.slice() };
}

/** `export_order` and `display_order` both hold DEFINITION indices, so every
 * structural column edit has to move them — a stale list would silently
 * reorder the export or the grid, which the backend's normalizers cannot
 * detect (their entries are all still in range). An EMPTY order is left empty
 * throughout: it already means "definition order", which stays correct across
 * every one of these edits. A FRESH empty array, never the input one — a
 * caller that splices into the result (see `cloneColumn`) would otherwise
 * reach into the original definition. `ROW_NUMBER_SLOT` (export only) is
 * passed through untouched: it is not a definition index. */
function remapOrder(order: number[], f: (i: number) => number | null): number[] {
	if (order.length === 0) return [];
	const out: number[] = [];
	for (const i of order) {
		if (i === ROW_NUMBER_SLOT) {
			out.push(i);
			continue;
		}
		const next = f(i);
		if (next !== null) out.push(next);
	}
	return out;
}

/** Both index lists remapped through the same `f`. */
function remapOrders(
	next: TableDefinition,
	defn: TableDefinition,
	f: (i: number) => number | null
): void {
	next.export_order = remapOrder(defn.export_order ?? [], f);
	next.display_order = remapOrder(defn.display_order ?? [], f);
}

/** One `(index, why)` per ColumnRef a column carries: its source plus, for a
 * script column, each input's ref. The remappers below treat them uniformly;
 * `why` only feeds the `ColumnInUseError` message. */
function columnRefs(c: Column): { index: number; why: string }[] {
	const out: { index: number; why: string }[] = [];
	if (c.source.kind === 'column') out.push({ index: c.source.index, why: 'sources' });
	if (c.kind === 'script') {
		for (const i of c.inputs) out.push({ index: i.ref.index, why: `reads input "${i.name}" from` });
	}
	return out;
}

/** Copy-on-write: returns `c` itself when no ref changes. `f` returns the
 * new index for an old one, or throws. */
function remapColumnRefs(c: Column, f: (i: number) => number): Column {
	let next: Column = c;
	if (c.source.kind === 'column') {
		const to = f(c.source.index);
		if (to !== c.source.index) next = { ...next, source: { ...c.source, index: to } };
	}
	if (c.kind === 'script' && c.inputs.some((i) => f(i.ref.index) !== i.ref.index)) {
		const inputs = c.inputs.map((i) =>
			f(i.ref.index) === i.ref.index ? i : { ...i, ref: { ...i.ref, index: f(i.ref.index) } }
		);
		next = { ...(next as Extract<Column, { kind: 'script' }>), inputs };
	}
	return next;
}

/** Fresh default columns for the two addable kinds — shared by ColumnManager's
 * add buttons and the grid header's "+" menu. */
export function newPropertyColumn(): Column {
	return {
		kind: 'property',
		source: { kind: 'row', chain_index: 0 },
		name: '',
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null,
		hidden: false
	};
}

export function newNavigationColumn(): Column {
	return {
		kind: 'navigation',
		source: { kind: 'row', chain_index: 0 },
		navigation: {},
		step_index: null,
		mode: 'collapse',
		keep_empty: true,
		sort_mode: 'value',
		cell_cap: 20,
		header: '',
		width_px: null,
		hidden: false
	};
}

export function newScriptColumn(): Column {
	return {
		kind: 'script',
		source: { kind: 'row', chain_index: 0 },
		snippet: {},
		inputs: [],
		mode: 'collapse',
		keep_empty: true,
		header: '',
		width_px: null,
		hidden: false
	};
}

/** Highest addressable chain step of a navigation definition: a path has one
 * column per relationship/property hop plus the start (index 0); a set_op
 * root exposes a single implicit column. */
export function navMaxStepIndex(defn: NavigationDefinition): number {
	return defn.kind === 'path' ? Math.max(0, chainColumns(defn).length - 1) : 0;
}

export function addColumn(defn: TableDefinition, col: Column): TableDefinition {
	const next = clone(defn);
	next.columns.push(col);
	// the appended column takes the next index
	remapOrders(next, defn, (i) => i);
	if (next.export_order.length) next.export_order = [...next.export_order, defn.columns.length];
	if (next.display_order.length) next.display_order = [...next.display_order, defn.columns.length];
	return next;
}

/**
 * Insert `col` at definition index `at` (0..length; `length` appends). Every
 * `ColumnRef.index` at or past `at` shifts up one — the column it names moved
 * — and, unlike `moveColumn`, no move can turn a backward ref forward: the
 * new column is fresh (no refs of its own) and every existing ref keeps its
 * relative position. Both index lists shift the same way and place the new
 * column next to its ANCHOR — the column at `at` when `place` is 'before',
 * the one at `at - 1` when 'after' — in the anchor's own slot of that list,
 * which is what "before/after column X" means on a grid or export whose
 * order differs from the definition's (an empty list stays empty: it already
 * means definition order, where the new column IS at `at`). Callers with an
 * active sort must remap it with `remapTableSortForInsert(tabId, at)` in the
 * same breath.
 */
export function insertColumn(
	defn: TableDefinition,
	at: number,
	col: Column,
	place: 'before' | 'after' = 'before'
): TableDefinition {
	const n = defn.columns.length;
	if (at < 0 || at > n) throw new Error(`insert position ${at} out of range`);
	const next = clone(defn);
	// copy-on-write: only the columns whose ref actually shifts are re-made
	next.columns = next.columns.map((c) => remapColumnRefs(c, (i) => (i >= at ? i + 1 : i)));
	next.columns.splice(at, 0, col);
	remapOrders(next, defn, (i) => (i >= at ? i + 1 : i));
	const anchorOld = place === 'before' ? at : at - 1;
	const anchor = anchorOld < 0 || anchorOld >= n ? -1 : anchorOld >= at ? anchorOld + 1 : anchorOld;
	for (const key of ['export_order', 'display_order'] as const) {
		const order = next[key];
		if (order.length === 0) continue;
		const slot = anchor < 0 ? -1 : order.indexOf(anchor);
		if (slot < 0) order.push(at);
		else order.splice(place === 'before' ? slot : slot + 1, 0, at);
	}
	return next;
}

/**
 * Replace one column wholesale (the per-column editors' same-shape field
 * patches: sort_mode, cell_cap, mode, keep_empty, source, navigation). The
 * replacement is kept BY REFERENCE, not cloned: NavigationColumnEditor's
 * draft-mirror loop guard relies on `columns[index].navigation.definition`
 * keeping reference-identity with the embedded draft's definition across this
 * round-trip.
 */
export function replaceColumn(defn: TableDefinition, index: number, col: Column): TableDefinition {
	const next = clone(defn);
	next.columns[index] = col;
	return next;
}

export function removeColumn(defn: TableDefinition, index: number): TableDefinition {
	for (let i = 0; i < defn.columns.length; i++) {
		if (i === index) continue;
		const ref = columnRefs(defn.columns[i]).find((r) => r.index === index);
		if (ref) throw new ColumnInUseError(`column ${i} ${ref.why} column ${index}`);
	}
	const next = clone(defn);
	next.columns.splice(index, 1);
	// shift down any ColumnRef.index that pointed past the removed column
	// (copy-on-write: only the columns whose ref actually shifts are re-made)
	next.columns = next.columns.map((c) => remapColumnRefs(c, (i) => (i > index ? i - 1 : i)));
	// drop it, shift the ones above down
	remapOrders(next, defn, (i) => (i === index ? null : i > index ? i - 1 : i));
	return next;
}

/**
 * Deep-copy the column at `index` and insert the copy immediately after it.
 * A non-empty header gains a ` (copy)` suffix; an empty one stays empty (the
 * grid already falls back to the kind label).
 *
 * The copy is a plain-JSON round-trip, deliberately NOT `structuredClone`
 * (see module doc, subtlety 2 — a leaked `$state` proxy bricks it) and NOT a
 * reference-preserving shallow copy: the whole point of a clone is that
 * editing it (its inline navigation/snippet definition included) can never
 * bleed into the original, so the two must share no references at all.
 *
 * Ref bookkeeping mirrors `removeColumn`'s shift-down, in reverse: every
 * `ColumnRef.index` pointing PAST `index` shifts up one (its target moved).
 * Refs pointing AT `index` keep pointing at the original, and the clone's own
 * source ref — backward-only by schema invariant, so always `<= index` — is
 * untouched and stays valid. Callers with an active sort must remap it with
 * `remapTableSortForInsert(tabId, index + 1)` in the same breath.
 */
export function cloneColumn(defn: TableDefinition, index: number): TableDefinition {
	const src = defn.columns[index];
	const copy = JSON.parse(JSON.stringify(src)) as Column;
	if (copy.header) copy.header = `${copy.header} (copy)`;
	const next = clone(defn);
	// copy-on-write: only the columns whose ref actually shifts are re-made
	next.columns = next.columns.map((c) => remapColumnRefs(c, (i) => (i > index ? i + 1 : i)));
	next.columns.splice(index + 1, 0, copy);
	// the copy lands at index + 1, so shift and then insert it right after
	// its original in both lists
	remapOrders(next, defn, (i) => (i > index ? i + 1 : i));
	for (const order of [next.export_order, next.display_order]) {
		const at = order.indexOf(index);
		if (at >= 0) order.splice(at + 1, 0, index + 1);
	}
	return next;
}

export function moveColumn(defn: TableDefinition, from: number, to: number): TableDefinition {
	const n = defn.columns.length;
	if (from === to) return clone(defn);
	// build the new index mapping: old position → new position
	const order = [...Array(n).keys()];
	order.splice(to, 0, order.splice(from, 1)[0]);
	const oldToNew = new Map<number, number>();
	order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));

	const next = clone(defn);
	// remap every ColumnRef to its source's new position, and validate backward
	// (copy-on-write: only ref-carrying columns are re-made)
	next.columns = order.map((oldIdx, newIdx) => {
		const c = defn.columns[oldIdx];
		return remapColumnRefs(c, (i) => {
			const remapped = oldToNew.get(i);
			if (remapped === undefined) throw new Error('dangling column source');
			if (remapped >= newIdx) {
				throw new Error(`move makes column ${newIdx} source column ${remapped} (forward)`);
			}
			return remapped;
		});
	});
	// reuse the oldToNew map the function already built above
	remapOrders(next, defn, (i) => oldToNew.get(i) ?? null);
	return next;
}

/** Reorder the GRID. `from`/`to` are positions in `displayOrder(defn)`, not
 *  definition indices, and the move carries none of `moveColumn`'s
 *  backward-reference constraints: the definition (computation) order is
 *  untouched, only what the user sees moves. Always writes a FULL order,
 *  materializing the natural one first, so the result no longer depends on
 *  the empty-means-definition-order fallback. */
export function moveDisplayColumn(
	defn: TableDefinition,
	from: number,
	to: number
): TableDefinition {
	const order = displayOrder(defn);
	if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) {
		return clone(defn);
	}
	order.splice(to, 0, order.splice(from, 1)[0]);
	return { ...clone(defn), display_order: order };
}

/** Back to computation order (`[]`). */
export function resetDisplayOrder(defn: TableDefinition): TableDefinition {
	return { ...clone(defn), display_order: [] };
}

export function renameColumn(
	defn: TableDefinition,
	index: number,
	header: string
): TableDefinition {
	const next = clone(defn);
	next.columns[index] = { ...defn.columns[index], header };
	return next;
}

export function setColumnWidth(
	defn: TableDefinition,
	index: number,
	width_px: number | null
): TableDefinition {
	const next = clone(defn);
	// Round here (the single write point) — drag deltas come from
	// PointerEvent.clientX, fractional under zoom/HiDPI, and the backend
	// schema requires an int (a float width_px 422s every evaluate).
	next.columns[index] = {
		...defn.columns[index],
		width_px: width_px === null ? null : Math.round(width_px)
	};
	return next;
}

export function setColumnMode(
	defn: TableDefinition,
	index: number,
	mode: 'collapse' | 'expand'
): TableDefinition {
	const next = clone(defn);
	const c = defn.columns[index];
	if (c.kind !== 'element') next.columns[index] = { ...c, mode };
	return next;
}

/**
 * Build a transient TableDefinition ("Open as table") from a navigation
 * draft. `chainColumns` only accepts a `PathNavigation` — a `set_op`
 * definition has no single chain to project columns from, so it falls back
 * to one `Start` column sourced from chain_index 0, keeping `columns`
 * non-empty (the schema's minimum) until the table editor lets the user pick
 * real columns.
 */
export function navigationAsTableDefinition({
	artifactId,
	definition
}: {
	artifactId: string | null;
	definition: NavigationDefinition;
}): TableDefinition {
	const columns: Column[] =
		definition.kind === 'path'
			? chainColumns(definition).map((col) => ({
					kind: 'element',
					source: { kind: 'row', chain_index: col.index },
					header: col.label,
					width_px: null,
					hidden: false
				}))
			: [
					{
						kind: 'element',
						source: { kind: 'row', chain_index: 0 },
						header: 'Start',
						width_px: null,
						hidden: false
					}
				];
	return {
		schema_version: 1,
		row_source: {
			kind: 'chains',
			navigation: artifactId ? { ref: artifactId } : { definition },
			unique: false
		},
		columns,
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		export_order: [],
		display_order: []
	};
}

export function columnLabel(col: Column): string {
	if (col.header) return col.header;
	if (col.kind === 'property') return col.name;
	if (col.kind === 'element') return 'Scope';
	if (col.kind === 'script') return 'Script';
	return 'Navigation';
}

/**
 * Display label for a column KIND (definition column or evaluate-response
 * column-out, whose `kind` is a plain string). The element column is the row's
 * own binding — the user-facing name for it is "Scope".
 */
export function columnKindLabel(kind: string): string {
	if (kind === 'element') return 'Scope';
	if (kind === 'property') return 'Property';
	if (kind === 'navigation') return 'Navigation';
	if (kind === 'script') return 'Script';
	return kind;
}

const DEFAULT_JSON_OPTIONS: JsonColumnOptions = {
	key: '',
	item_key: '',
	value: 'name',
	group: false
};

const DEFAULT_EXPORT_OPTIONS: ColumnExportOptions = { include: null, header: '' };
const DEFAULT_ROW_NUMBER_OPTIONS: RowNumberExportOptions = {
	include: true,
	header: '',
	key: ''
};

/**
 * The JSON key each column gets, mirroring `resolve_json_keys` in
 * `core/table/json_export.py`: explicit key, else header, else `kind_index`,
 * with later duplicates suffixed `_2`, `_3`. A column the export EXCLUDES gets
 * `null` and consumes no name.
 *
 * Keyed off `columnIncluded`, NOT off `hidden`. The backend renders through
 * `export_definition`, which rewrites each `hidden` flag to say what the export
 * contains before `resolve_json_keys` ever sees it — so a grid-hidden column
 * that was opted back in does get a key and does appear in the file, and an
 * opted-OUT visible column gets neither. Reading `hidden` here would have shown
 * a blank placeholder (and refused to snake_case) for a column the download
 * emits, and vice versa.
 *
 * DISPLAY ONLY — this is what the export dialog shows as a placeholder. The
 * authoritative keys are the backend's, and the preview pane renders through
 * the backend for exactly that reason.
 */
export function defaultJsonKeys(defn: TableDefinition): (string | null)[] {
	const used = new Set<string>();
	return defn.columns.map((col, i) => {
		if (!columnIncluded(defn, i)) return null;
		const base = col.json_export?.key || col.header || `${col.kind}_${i}`;
		let key = base;
		let n = 2;
		while (used.has(key)) key = `${base}_${n++}`;
		used.add(key);
		return key;
	});
}

/** "Component Mass" -> "component_mass". Used only by the settings pane's
 *  "snake_case all" button, which writes the result into each column's
 *  `json_export.key` — the backend has no notion of slugification. */
export function snakeCaseKey(s: string): string {
	return s
		.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
		.replace(/[^a-zA-Z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toLowerCase();
}

/** Merge a patch into one column's JSON-export options, materializing the
 *  options object if the column had none. Pure — returns a new definition. */
export function setColumnJsonOptions(
	defn: TableDefinition,
	index: number,
	patch: Partial<JsonColumnOptions>
): TableDefinition {
	const next = clone(defn);
	const current = defn.columns[index].json_export ?? DEFAULT_JSON_OPTIONS;
	next.columns[index] = {
		...defn.columns[index],
		json_export: { ...current, ...patch }
	};
	return next;
}

/** Merge a patch into one column's export options, materializing the options
 *  object if the column had none. Pure — returns a new definition. */
export function setColumnExportOptions(
	defn: TableDefinition,
	index: number,
	patch: Partial<ColumnExportOptions>
): TableDefinition {
	const next = clone(defn);
	const current = defn.columns[index].export ?? DEFAULT_EXPORT_OPTIONS;
	next.columns[index] = { ...defn.columns[index], export: { ...current, ...patch } };
	return next;
}

/** Merge a patch into the row-number pseudo-column's export options. */
export function setRowNumberExportOptions(
	defn: TableDefinition,
	patch: Partial<RowNumberExportOptions>
): TableDefinition {
	const current = defn.export_row_number ?? DEFAULT_ROW_NUMBER_OPTIONS;
	return { ...clone(defn), export_row_number: { ...current, ...patch } };
}

export const DEFAULT_JSON_SPLIT: JsonSplitOptions = {
	enabled: false,
	filename_template: ''
};

export const SPLIT_TOKEN = '${name}';

/** Mirrors core/table/split.py::validate_template — the dialog blocks saving
 * a tokenless template; the server 422 stays as backstop. */
export function templateIsValid(template: string): boolean {
	return template.includes(SPLIT_TOKEN);
}

/** Merge a patch into the JSON per-element split options, materializing the
 *  options object if the definition had none. Pure — returns a new definition. */
export function setJsonSplitOptions(
	defn: TableDefinition,
	patch: Partial<JsonSplitOptions>
): TableDefinition {
	const current = defn.json_split ?? DEFAULT_JSON_SPLIT;
	return { ...clone(defn), json_split: { ...current, ...patch } };
}

/** Reorder the EXPORT list. `from`/`to` are positions in `exportEntries`, not
 *  definition indices — the export list has its own coordinate space, and the
 *  row-number entry has no definition index at all. Always writes a FULL
 *  order, materializing the natural one first, so the result no longer depends
 *  on the empty-means-natural fallback. */
export function moveExportEntry(defn: TableDefinition, from: number, to: number): TableDefinition {
	const order = exportEntries(defn).map((e) => e.index);
	if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) {
		return clone(defn);
	}
	order.splice(to, 0, order.splice(from, 1)[0]);
	return { ...clone(defn), export_order: order };
}
