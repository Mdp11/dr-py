/**
 * Client mirror of core/table/exporter.py::overridden_table — used by
 * the entry layout dialog and the json-preview call. Display-only; the
 * backend re-applies overrides itself at /exports/run time, so drift here
 * cannot corrupt an export (same stance as table/export-layout.ts).
 */
import type { ColumnOverride, ExporterEntry, TableDefinition } from '$lib/api/types';

export function applyEntryOverrides(defn: TableDefinition, entry: ExporterEntry): TableDefinition {
	const byIndex = new Map<number, ColumnOverride>();
	for (const ov of entry.columns) {
		if (ov.index >= 0 && ov.index < defn.columns.length && !byIndex.has(ov.index))
			byIndex.set(ov.index, ov);
	}
	return {
		...defn,
		columns: defn.columns.map((col, i) => {
			const ov = byIndex.get(i);
			// Clone, don't alias, the entry's option objects — the sibling of the
			// same clone in overridesFromDefinition below. This display defn is
			// exactly the shape a table-settings dialog edits through the ordinary
			// column mutators (setColumnExportOptions/setColumnJsonOptions in
			// columns.ts), which are pure and REPLACE the object; nothing here
			// stops a future non-pure editor from doing `col.export.header = x`
			// in place instead, which — unaliased — would rewrite the entry's
			// STORED options out from under it.
			return {
				...col,
				export: ov?.export ? { ...ov.export } : null,
				json_export: ov?.json_export ? { ...ov.json_export } : null
			};
		}),
		export_order: [...entry.export_order],
		show_row_numbers: entry.show_row_numbers,
		// Same clone-not-alias reasoning as columns' export/json_export above:
		// both are flat plain option objects the entry owns.
		export_row_number: entry.export_row_number ? { ...entry.export_row_number } : null,
		json_split: entry.json_split ? { ...entry.json_split } : null
	};
}

export function overridesFromDefinition(
	defn: TableDefinition
): Pick<
	ExporterEntry,
	'columns' | 'export_order' | 'show_row_numbers' | 'export_row_number' | 'json_split'
> {
	const columns: ColumnOverride[] = [];
	defn.columns.forEach((col, index) => {
		if (col.export != null || col.json_export != null)
			columns.push({
				index,
				// Clone, don't alias, the column's option objects: this entry is
				// STAGED and PERSISTED as the exporter artifact's payload (see
				// entryForTable below), unlike applyEntryOverrides' display-only
				// output. Aliasing col.export/col.json_export here would let a LATER
				// in-place edit of the source table silently rewrite an
				// already-committed entry — copy-at-add has to mean copy, all the
				// way down to the objects a column carries, not just the arrays.
				export: col.export ? { ...col.export } : null,
				json_export: col.json_export ? { ...col.json_export } : null
			});
	});
	return {
		columns,
		export_order: [...defn.export_order],
		show_row_numbers: defn.show_row_numbers,
		// Same clone-not-alias reasoning as columns' export/json_export above:
		// both are flat plain option objects (RowNumberExportOptions,
		// JsonSplitOptions) on the DEFINITION, and this entry is staged and
		// persisted — a later in-place edit of the table's row-number or
		// json-split settings must not rewrite an already-committed entry.
		export_row_number: defn.export_row_number ? { ...defn.export_row_number } : null,
		json_split: defn.json_split ? { ...defn.json_split } : null
	};
}

export function entryForTable(tableId: string, defn: TableDefinition, name: string): ExporterEntry {
	return {
		source: { ref: tableId },
		name,
		format: 'xlsx',
		folder: '',
		...overridesFromDefinition(defn)
	};
}
