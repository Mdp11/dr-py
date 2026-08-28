// Mirror of `core/table/export_layout.py`'s normalizer. DISPLAY ONLY — the
// authoritative layout is the backend's; this exists so the export dialog can
// render the list (including EXCLUDED entries, which the backend's own layout
// drops) without a round trip.
import { describe, expect, it } from 'vitest';
import type { TableDefinition } from '$lib/api/types';
import { ROW_NUMBER_SLOT, displayOrder, exportEntries } from '../export-layout';

function defn(over: Partial<TableDefinition> = {}): TableDefinition {
	return {
		schema_version: 1,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: 'Block',
				hidden: false
			},
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'collapse',
				keep_empty: true,
				header: 'Mass',
				hidden: false
			}
		],
		default_cell_mode: 'collapse',
		show_row_numbers: false,
		export_order: [],
		display_order: [],
		export_row_number: null,
		...over
	} as TableDefinition;
}

describe('exportEntries', () => {
	it('defaults to definition order, all included', () => {
		expect(exportEntries(defn())).toEqual([
			{ index: 0, included: true },
			{ index: 1, included: true }
		]);
	});

	it('keeps an excluded entry in the list so the dialog can show it', () => {
		const d = defn();
		d.columns[1].hidden = true;
		expect(exportEntries(d)).toEqual([
			{ index: 0, included: true },
			{ index: 1, included: false }
		]);
	});

	it('lets a hidden column be opted back in', () => {
		const d = defn();
		d.columns[1].hidden = true;
		d.columns[1].export = { include: true, header: '' };
		expect(exportEntries(d)[1].included).toBe(true);
	});

	it('drops garbage and appends forgotten columns', () => {
		expect(exportEntries(defn({ export_order: [7, 1, 1] })).map((e) => e.index)).toEqual([1, 0]);
	});

	it('leads with the row-number entry when it is unlisted', () => {
		const e = exportEntries(defn({ show_row_numbers: true }));
		expect(e.map((x) => x.index)).toEqual([ROW_NUMBER_SLOT, 0, 1]);
	});

	it('omits the row-number entry when the grid flag is off', () => {
		const e = exportEntries(defn({ export_order: [ROW_NUMBER_SLOT, 0, 1] }));
		expect(e.map((x) => x.index)).toEqual([0, 1]);
	});

	it('marks an excluded row-number entry', () => {
		const e = exportEntries(
			defn({
				show_row_numbers: true,
				export_row_number: { include: false, header: '', key: '' }
			})
		);
		expect(e[0]).toEqual({ index: ROW_NUMBER_SLOT, included: false });
	});
});

describe('displayOrder', () => {
	it('defaults to definition order', () => {
		expect(displayOrder(defn())).toEqual([0, 1]);
	});

	it('drops out-of-range and duplicate entries and appends the forgotten ones', () => {
		expect(displayOrder(defn({ display_order: [7, 1, 1, -1] }))).toEqual([1, 0]);
	});

	it('an empty export order follows the display order', () => {
		expect(exportEntries(defn({ display_order: [1, 0] })).map((e) => e.index)).toEqual([1, 0]);
	});

	it('an explicit export order wins over the display order', () => {
		expect(
			exportEntries(defn({ display_order: [1, 0], export_order: [0, 1] })).map((e) => e.index)
		).toEqual([0, 1]);
	});

	it('a partial export order is completed in display order', () => {
		const d = defn({ display_order: [1, 0], export_order: [] });
		d.columns.push({ ...d.columns[1], header: 'B' });
		d.display_order = [2, 1, 0];
		d.export_order = [0];
		expect(exportEntries(d).map((e) => e.index)).toEqual([0, 2, 1]);
	});

	it('the row-number slot still leads a display-ordered export', () => {
		expect(
			exportEntries(defn({ display_order: [1, 0], show_row_numbers: true })).map((e) => e.index)
		).toEqual([ROW_NUMBER_SLOT, 1, 0]);
	});
});
