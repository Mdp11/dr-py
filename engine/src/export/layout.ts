/**
 * Which columns an export holds, in what order, under what names, as
 * `core/table/export_layout.py` answers it. An export never permutes the
 * definition, whose column order is structural: the layout is an output order
 * the writers walk the definition through.
 */
import type { Column, TableDefinition } from '../table/schema.ts';

/** `export_order`'s stand-in for the row-number column, which has no definition index. */
export const ROW_NUMBER_SLOT = -1;

const DEFAULT_ROW_NUMBER_HEADER = '#';
const DEFAULT_ROW_NUMBER_KEY = 'row_number';

/**
 * Where every column lands in one file. `order` lists the included definition
 * indices in output order; `rank` is each definition column's output position,
 * an excluded one past every included one; `rowNumberAt` is the row number's
 * position in the same space, or `null` when it is not in the file. `headers`
 * are the file's headers, the row number's included.
 */
export type ExportLayout = {
	order: number[];
	rank: number[];
	rowNumberAt: number | null;
	rowNumberHeader: string;
	rowNumberKey: string;
	headers: string[];
};

/** Per column, whether the export holds it: an unset `include` follows `hidden`. */
function included(defn: TableDefinition): boolean[] {
	return defn.columns.map((col) => {
		const include = col.export?.include ?? null;
		return include === null ? !col.hidden : include;
	});
}

/** `display_order` without out-of-range and repeated entries, the columns it forgot appended. */
export function normalizedDisplayOrder(defn: TableDefinition): number[] {
	const n = defn.columns.length;
	const seen = new Set<number>();
	for (const i of defn.display_order) {
		if (0 <= i && i < n) seen.add(i);
	}
	const out = [...seen];
	for (let i = 0; i < n; i++) if (!seen.has(i)) out.push(i);
	return out;
}

/**
 * `export_order` made safe, excluded columns included: out-of-range and
 * repeated entries dropped, the row-number slot dropped unless row numbers
 * show, then every forgotten column in display order. A row number shown and
 * not placed leads.
 */
export function normalizedOrder(defn: TableDefinition): number[] {
	const n = defn.columns.length;
	const seen = new Set<number>();
	for (const i of defn.export_order) {
		if (i === ROW_NUMBER_SLOT ? defn.show_row_numbers : 0 <= i && i < n) seen.add(i);
	}
	const out = [...seen];
	if (defn.show_row_numbers && !seen.has(ROW_NUMBER_SLOT)) out.unshift(ROW_NUMBER_SLOT);
	for (const i of normalizedDisplayOrder(defn)) if (!seen.has(i)) out.push(i);
	return out;
}

/** The xlsx and CSV header of a column: its export header, else its header, else its kind. */
export function exportHeader(defn: TableDefinition, index: number): string {
	const col = defn.columns[index]!;
	return (col.export?.header ?? '') || col.header || col.kind;
}

/** The definition's export settings as output positions. */
export function exportLayout(defn: TableDefinition): ExportLayout {
	const inFile = included(defn);
	const rn = defn.export_row_number;
	const rowNumberIn = defn.show_row_numbers && (rn === null || rn.include);
	const order: number[] = [];
	const rank = defn.columns.map(() => defn.columns.length + 1);
	let rowNumberAt: number | null = null;
	let pos = 0;
	for (const i of normalizedOrder(defn)) {
		if (i === ROW_NUMBER_SLOT) {
			if (!rowNumberIn) continue;
			rowNumberAt = pos;
		} else {
			if (!inFile[i]) continue;
			rank[i] = pos;
			order.push(i);
		}
		pos++;
	}
	const rowNumberHeader = (rn?.header ?? '') || DEFAULT_ROW_NUMBER_HEADER;
	const headers = order.map((i) => exportHeader(defn, i));
	if (rowNumberAt !== null) headers.splice(rowNumberAt, 0, rowNumberHeader);
	return {
		order,
		rank,
		rowNumberAt,
		rowNumberHeader,
		rowNumberKey: (rn?.key ?? '') || DEFAULT_ROW_NUMBER_KEY,
		headers
	};
}

/**
 * A copy of `defn` whose `hidden` says what the export holds, for the JSON
 * renderer only: evaluation keeps the definition as written.
 */
export function exportDefinition(defn: TableDefinition): TableDefinition {
	const inFile = included(defn);
	const columns = defn.columns.map((col, i): Column =>
		col.hidden === !inFile[i] ? col : { ...col, hidden: !inFile[i] }
	);
	return { ...defn, columns };
}
