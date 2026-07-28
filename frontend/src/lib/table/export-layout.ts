/**
 * Client mirror of `core/table/export_layout.py`'s normalizer.
 *
 * DISPLAY ONLY, exactly like `defaultJsonKeys`: the authoritative layout is
 * the backend's, and the JSON preview pane renders through the backend for
 * that reason. This exists because the export dialog must list the EXCLUDED
 * entries too — so the user can opt one back in — and the backend's own
 * `ExportLayout` has already dropped them.
 */
import type { TableDefinition } from '$lib/api/types';

/** `export_order`'s stand-in for the row-number pseudo-column, which has no
 *  definition index of its own. Mirrors the Python constant of the same name. */
export const ROW_NUMBER_SLOT = -1;

export interface ExportEntry {
	/** Definition column index, or `ROW_NUMBER_SLOT`. */
	index: number;
	included: boolean;
}

/** Whether the export contains this definition column. `include == null`
 *  follows `hidden` — the no-migration default. */
export function columnIncluded(defn: TableDefinition, index: number): boolean {
	const opts = defn.columns[index].export;
	if (!opts || opts.include == null) return !defn.columns[index].hidden;
	return opts.include;
}

/** Every export entry in output order, INCLUDED OR NOT. Drops out-of-range and
 *  duplicate `export_order` entries, drops the row-number slot when the grid
 *  flag is off, and appends any definition column the list forgot. */
export function exportEntries(defn: TableDefinition): ExportEntry[] {
	const n = defn.columns.length;
	const seen = new Set<number>();
	const order: number[] = [];
	for (const i of defn.export_order ?? []) {
		if (i === ROW_NUMBER_SLOT) {
			if (!defn.show_row_numbers || seen.has(i)) continue;
		} else if (!Number.isInteger(i) || i < 0 || i >= n || seen.has(i)) {
			continue;
		}
		seen.add(i);
		order.push(i);
	}
	if (defn.show_row_numbers && !seen.has(ROW_NUMBER_SLOT)) order.unshift(ROW_NUMBER_SLOT);
	for (let i = 0; i < n; i++) if (!seen.has(i)) order.push(i);

	return order.map((index) => ({
		index,
		included:
			index === ROW_NUMBER_SLOT
				? (defn.export_row_number?.include ?? true)
				: columnIncluded(defn, index)
	}));
}
