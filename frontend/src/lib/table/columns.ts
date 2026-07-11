/**
 * Pure column-edit helpers over a TableDefinition (Stage 2 tables). Every
 * mutator returns a NEW TableDefinition — the input is never mutated. No
 * Svelte, no store, no I/O — fully unit-testable, mirroring
 * `lib/navigation/tree.ts`.
 *
 * The one subtlety worth flagging: `moveColumn` must remap every
 * `ColumnSource` of kind 'column' (a `ColumnRef`) to its source column's NEW
 * position after the reorder, and reject a move that would leave a ref
 * pointing at or past its own new position (columns may only source columns
 * that precede them — a forward or self reference is not evaluable).
 */
import type { Column, ColumnSource, TableDefinition } from '$lib/api/types';

export class ColumnInUseError extends Error {}

function clone(defn: TableDefinition): TableDefinition {
	return structuredClone(defn);
}

function sourcesColumn(source: ColumnSource, index: number): boolean {
	return source.kind === 'column' && source.index === index;
}

export function addColumn(defn: TableDefinition, col: Column): TableDefinition {
	const next = clone(defn);
	next.columns.push(structuredClone(col));
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
	for (const c of next.columns) {
		if (c.source.kind === 'column' && c.source.index > index) c.source.index -= 1;
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
	next.columns = order.map((oldIdx) => structuredClone(defn.columns[oldIdx]));
	// remap every ColumnRef to its source's new position, and validate backward
	next.columns.forEach((c, newIdx) => {
		if (c.source.kind === 'column') {
			const remapped = oldToNew.get(c.source.index);
			if (remapped === undefined) throw new Error('dangling column source');
			if (remapped >= newIdx) {
				throw new Error(`move makes column ${newIdx} source column ${remapped} (forward)`);
			}
			c.source.index = remapped;
		}
	});
	return next;
}

export function renameColumn(
	defn: TableDefinition,
	index: number,
	header: string
): TableDefinition {
	const next = clone(defn);
	next.columns[index].header = header;
	return next;
}

export function setColumnWidth(
	defn: TableDefinition,
	index: number,
	width_px: number | null
): TableDefinition {
	const next = clone(defn);
	next.columns[index].width_px = width_px;
	return next;
}

export function setColumnMode(
	defn: TableDefinition,
	index: number,
	mode: 'collapse' | 'expand'
): TableDefinition {
	const next = clone(defn);
	const c = next.columns[index];
	if (c.kind !== 'element') c.mode = mode;
	return next;
}

export function columnLabel(col: Column): string {
	if (col.header) return col.header;
	if (col.kind === 'property') return col.name;
	if (col.kind === 'element') return 'Element';
	return 'Navigation';
}
