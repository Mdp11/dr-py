import { describe, expect, it } from 'vitest';
import { applyEntryOverrides, entryForTable, overridesFromDefinition } from '../exporter';
import type { TableDefinition } from '$lib/api/types';

const defn: TableDefinition = {
	schema_version: 1,
	row_source: { kind: 'scope', types: ['Block'], criteria: [] },
	columns: [
		{
			kind: 'element',
			source: { kind: 'row', chain_index: 0 },
			header: 'A',
			width_px: null,
			hidden: false,
			json_export: { key: 'a', item_key: '', value: 'name', group: false },
			export: { include: false, header: '' }
		},
		{
			kind: 'element',
			source: { kind: 'row', chain_index: 0 },
			header: 'B',
			width_px: null,
			hidden: false,
			json_export: null,
			export: null
		}
	],
	default_cell_mode: 'collapse',
	show_row_numbers: true,
	export_order: [1, 0],
	export_row_number: null,
	json_split: null
};

describe('exporter helpers', () => {
	it('entryForTable copies the table settings at add time', () => {
		const e = entryForTable('tbl-1', defn, 'My table');
		expect(e.source).toEqual({ ref: 'tbl-1' });
		expect(e.name).toBe('My table');
		expect(e.columns).toEqual([
			{
				index: 0,
				export: { include: false, header: '' },
				json_export: { key: 'a', item_key: '', value: 'name', group: false }
			}
		]); // column 1 has nothing to copy
		expect(e.export_order).toEqual([1, 0]);
		expect(e.show_row_numbers).toBe(true);
	});

	it('applyEntryOverrides mirrors overridden_table: defaults, drift, no mutation', () => {
		const e = entryForTable('tbl-1', defn, 'n');
		const out = applyEntryOverrides(defn, {
			...e,
			columns: [
				{ index: 0, export: { include: true, header: 'X' }, json_export: null },
				{ index: 99, export: null, json_export: null }
			],
			export_order: [0, 1],
			show_row_numbers: false
		});
		expect(out.columns[0].export).toEqual({ include: true, header: 'X' });
		expect(out.columns[1].export).toBeNull(); // unmentioned -> DEFAULT
		expect(out.columns[1].json_export).toBeNull();
		expect(out.export_order).toEqual([0, 1]);
		expect(defn.columns[0].export).toEqual({ include: false, header: '' });
	});

	it('overridesFromDefinition extracts exactly the presentation set', () => {
		const o = overridesFromDefinition(defn);
		expect(Object.keys(o).sort()).toEqual([
			'columns',
			'export_order',
			'export_row_number',
			'json_split',
			'show_row_numbers'
		]);
	});
});
