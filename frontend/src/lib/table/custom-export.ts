/**
 * Client mirror of core/table/custom_export.py::overridden_table — used by
 * the entry layout dialog and the json-preview call. Display-only; the
 * backend re-applies overrides itself at /exports/run time, so drift here
 * cannot corrupt an export (same stance as table/export-layout.ts).
 */
import type { ColumnOverride, ExportEntry, TableDefinition } from '$lib/api/types';

export function applyEntryOverrides(defn: TableDefinition, entry: ExportEntry): TableDefinition {
	const byIndex = new Map<number, ColumnOverride>();
	for (const ov of entry.columns) {
		if (ov.index >= 0 && ov.index < defn.columns.length && !byIndex.has(ov.index))
			byIndex.set(ov.index, ov);
	}
	return {
		...defn,
		columns: defn.columns.map((col, i) => {
			const ov = byIndex.get(i);
			return { ...col, export: ov?.export ?? null, json_export: ov?.json_export ?? null };
		}),
		export_order: [...entry.export_order],
		show_row_numbers: entry.show_row_numbers,
		export_row_number: entry.export_row_number ?? null,
		json_split: entry.json_split ?? null
	};
}

export function overridesFromDefinition(
	defn: TableDefinition
): Pick<
	ExportEntry,
	'columns' | 'export_order' | 'show_row_numbers' | 'export_row_number' | 'json_split'
> {
	const columns: ColumnOverride[] = [];
	defn.columns.forEach((col, index) => {
		if (col.export != null || col.json_export != null)
			columns.push({
				index,
				export: col.export ?? null,
				json_export: col.json_export ?? null
			});
	});
	return {
		columns,
		export_order: [...defn.export_order],
		show_row_numbers: defn.show_row_numbers,
		export_row_number: defn.export_row_number ?? null,
		json_split: defn.json_split ?? null
	};
}

export function entryForTable(tableId: string, defn: TableDefinition, name: string): ExportEntry {
	return {
		source: { ref: tableId },
		name,
		format: 'xlsx',
		...overridesFromDefinition(defn)
	};
}
