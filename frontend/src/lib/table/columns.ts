/**
 * Pure column-edit helpers over a TableDefinition (Stage 2 tables). Every
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
import type { Column, ColumnSource, NavigationDefinition, TableDefinition } from '$lib/api/types';
import { chainColumns } from '$lib/navigation/tree';

export class ColumnInUseError extends Error {}

/** Shallow copy-on-write shell: fresh definition + fresh columns array,
 * every column kept by reference (see module doc, subtlety 2). */
function clone(defn: TableDefinition): TableDefinition {
	return { ...defn, columns: defn.columns.slice() };
}

function sourcesColumn(source: ColumnSource, index: number): boolean {
	return source.kind === 'column' && source.index === index;
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
		if (i !== index && sourcesColumn(defn.columns[i].source, index)) {
			throw new ColumnInUseError(`column ${i} sources column ${index}`);
		}
	}
	const next = clone(defn);
	next.columns.splice(index, 1);
	// shift down any ColumnRef.index that pointed past the removed column
	// (copy-on-write: only the columns whose ref actually shifts are re-made)
	next.columns = next.columns.map((c) =>
		c.source.kind === 'column' && c.source.index > index
			? { ...c, source: { ...c.source, index: c.source.index - 1 } }
			: c
	);
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
	next.columns = next.columns.map((c) =>
		c.source.kind === 'column' && c.source.index > index
			? { ...c, source: { ...c.source, index: c.source.index + 1 } }
			: c
	);
	next.columns.splice(index + 1, 0, copy);
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
		if (c.source.kind !== 'column') return c;
		const remapped = oldToNew.get(c.source.index);
		if (remapped === undefined) throw new Error('dangling column source');
		if (remapped >= newIdx) {
			throw new Error(`move makes column ${newIdx} source column ${remapped} (forward)`);
		}
		return { ...c, source: { ...c.source, index: remapped } };
	});
	return next;
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
			navigation: artifactId ? { ref: artifactId } : { definition }
		},
		columns,
		default_cell_mode: 'collapse',
		show_row_numbers: false
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
