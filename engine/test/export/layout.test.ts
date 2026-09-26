import { describe, expect, it } from 'vitest';
import {
	exportDefinition,
	exportHeader,
	exportLayout,
	normalizedDisplayOrder,
	normalizedOrder,
	readTableDefinition,
	ROW_NUMBER_SLOT
} from '../../src/index.ts';

const BLOCK = { kind: 'element', source: { kind: 'row' }, header: 'Block' };
const MASS = { kind: 'property', source: { kind: 'row' }, name: 'mass', header: 'Mass' };

const defn = (over: object = {}) =>
	readTableDefinition(
		{ row_source: { kind: 'scope', types: ['Block'] }, columns: [BLOCK, MASS], ...over },
		'definition'
	);

describe('exportLayout', () => {
	it('is definition order with no row number by default', () => {
		const layout = exportLayout(defn());
		expect(layout.order).toEqual([0, 1]);
		expect(layout.rank).toEqual([0, 1]);
		expect(layout.rowNumberAt).toBeNull();
		expect(layout.headers).toEqual(['Block', 'Mass']);
	});

	it('leaves a hidden column out, unless its export options take it in', () => {
		expect(exportLayout(defn({ columns: [BLOCK, { ...MASS, hidden: true }] })).order).toEqual([0]);
		const optedIn = defn({
			columns: [BLOCK, { ...MASS, hidden: true, export: { include: true } }]
		});
		expect(exportLayout(optedIn).order).toEqual([0, 1]);
		expect(exportDefinition(optedIn).columns[1]!.hidden).toBe(false);
	});

	it('leaves a visible column out when its export options say so', () => {
		const optedOut = defn({ columns: [BLOCK, { ...MASS, export: { include: false } }] });
		expect(exportLayout(optedOut).order).toEqual([0]);
		expect(exportDefinition(optedOut).columns[1]!.hidden).toBe(true);
		// Only the copy changes.
		expect(optedOut.columns[1]!.hidden).toBe(false);
	});

	it('permutes the output only', () => {
		const table = defn({ export_order: [1, 0] });
		const layout = exportLayout(table);
		expect(layout.order).toEqual([1, 0]);
		expect(layout.rank).toEqual([1, 0]);
		expect(layout.headers).toEqual(['Mass', 'Block']);
		expect(table.columns.map((col) => col.header)).toEqual(['Block', 'Mass']);
	});

	it('leads with the row number when the order does not place it', () => {
		const table = defn({ show_row_numbers: true });
		const layout = exportLayout(table);
		expect(normalizedOrder(table)).toEqual([ROW_NUMBER_SLOT, 0, 1]);
		expect(layout.rowNumberAt).toBe(0);
		expect(layout.order).toEqual([0, 1]);
		expect(layout.rank).toEqual([1, 2]);
		expect(layout.headers).toEqual(['#', 'Block', 'Mass']);
		expect(layout.rowNumberHeader).toBe('#');
		expect(layout.rowNumberKey).toBe('row_number');
	});

	it('puts the row number where the order puts it', () => {
		const layout = exportLayout(
			defn({ show_row_numbers: true, export_order: [0, ROW_NUMBER_SLOT, 1] })
		);
		expect(layout.rowNumberAt).toBe(1);
		expect(layout.rank).toEqual([0, 2]);
		expect(layout.headers).toEqual(['Block', '#', 'Mass']);
	});

	it('gives an excluded column before the row number no position', () => {
		const table = defn({
			show_row_numbers: true,
			export_order: [0, ROW_NUMBER_SLOT, 1],
			columns: [{ ...BLOCK, export: { include: false } }, MASS]
		});
		const layout = exportLayout(table);
		expect(layout.order).toEqual([1]);
		expect(layout.rowNumberAt).toBe(0);
		expect(layout.rank[1]).toBe(1);
		expect(layout.headers).toEqual(['#', 'Mass']);
	});

	it('leaves the row number out when its export options say so', () => {
		const layout = exportLayout(
			defn({ show_row_numbers: true, export_row_number: { include: false } })
		);
		expect(layout.rowNumberAt).toBeNull();
		expect(layout.rank).toEqual([0, 1]);
		expect(layout.headers).toEqual(['Block', 'Mass']);
	});

	it('names the row number as its options say, blanks falling back', () => {
		const named = exportLayout(
			defn({ show_row_numbers: true, export_row_number: { header: 'No.', key: 'idx' } })
		);
		expect([named.rowNumberHeader, named.rowNumberKey]).toEqual(['No.', 'idx']);
		const blank = exportLayout(
			defn({ show_row_numbers: true, export_row_number: { header: '', key: '' } })
		);
		expect([blank.rowNumberHeader, blank.rowNumberKey]).toEqual(['#', 'row_number']);
	});

	it('ranks an excluded column past every included one', () => {
		const layout = exportLayout(
			defn({ columns: [BLOCK, { ...MASS, export: { include: false } }] })
		);
		expect(layout.rank).toEqual([0, 3]);
	});
});

describe('normalizedOrder', () => {
	it('drops out-of-range and repeated entries and a row number not shown, then appends the rest', () => {
		expect(normalizedOrder(defn({ export_order: [7, 1, 1, ROW_NUMBER_SLOT] }))).toEqual([1, 0]);
	});

	it('keeps one row number entry, where it first stands', () => {
		const table = defn({ show_row_numbers: true, export_order: [1, -1, 0, -1, -2] });
		expect(normalizedOrder(table)).toEqual([1, ROW_NUMBER_SLOT, 0]);
	});

	it('appends what the order forgot in display order', () => {
		const three = [BLOCK, MASS, { ...MASS, name: 'volume', header: 'Volume' }];
		expect(normalizedOrder(defn({ columns: three, display_order: [2, 0, 1] }))).toEqual([2, 0, 1]);
		expect(
			normalizedOrder(defn({ columns: three, display_order: [2, 0], export_order: [0] }))
		).toEqual([0, 2, 1]);
	});

	it('is definition order when both orders are empty', () => {
		expect(normalizedOrder(defn())).toEqual([0, 1]);
	});
});

describe('normalizedDisplayOrder', () => {
	it('drops out-of-range and repeated entries and appends every column it forgot', () => {
		const three = [BLOCK, MASS, { ...MASS, name: 'volume' }];
		expect(normalizedDisplayOrder(defn({ columns: three, display_order: [5, 2, 2, -1] }))).toEqual([
			2, 0, 1
		]);
	});
});

describe('exportHeader', () => {
	it('is the export header, else the header, else the kind', () => {
		const table = defn({
			columns: [
				{ ...BLOCK, export: { header: 'Over' } },
				{ ...MASS, header: '' },
				{ ...MASS, export: { header: '' } }
			]
		});
		expect([0, 1, 2].map((i) => exportHeader(table, i))).toEqual(['Over', 'property', 'Mass']);
	});
});
