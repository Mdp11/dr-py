import { describe, it, expect } from 'vitest';
import {
	addColumn,
	removeColumn,
	moveColumn,
	renameColumn,
	setColumnWidth,
	setColumnMode,
	columnLabel,
	ColumnInUseError
} from '$lib/table/columns';
import type { TableDefinition } from '$lib/api/types';

const base: TableDefinition = {
	schema_version: 1,
	default_cell_mode: 'collapse',
	row_source: { kind: 'scope', types: ['Block'], criteria: [] },
	columns: [
		{ kind: 'element', source: { kind: 'row', chain_index: 0 }, header: '', width_px: null }
	]
};

describe('columns', () => {
	it('addColumn appends', () => {
		const d = addColumn(base, {
			kind: 'property',
			source: { kind: 'row', chain_index: 0 },
			name: 'mass',
			mode: 'collapse',
			keep_empty: true,
			header: '',
			width_px: null
		});
		expect(d.columns).toHaveLength(2);
		expect(base.columns).toHaveLength(1); // immutable
	});

	it('removeColumn throws when another column sources it', () => {
		const withNav = addColumn(base, {
			kind: 'navigation',
			source: { kind: 'column', index: 0 },
			mode: 'collapse',
			keep_empty: true,
			sort_mode: 'value',
			cell_cap: 20,
			header: '',
			width_px: null,
			navigation: {
				definition: {
					kind: 'path',
					schema_version: 2,
					start: { kind: 'scope', types: [], criteria: [] },
					steps: [],
					exclude_visited: true
				}
			}
		});
		expect(() => removeColumn(withNav, 0)).toThrow(ColumnInUseError);
	});

	it('removeColumn shifts down a surviving forward ref', () => {
		// cols: [element(0), property(1), navigation source=column(1)(2)]
		let d = addColumn(base, {
			kind: 'property',
			source: { kind: 'row', chain_index: 0 },
			name: 'mass',
			mode: 'collapse',
			keep_empty: true,
			header: '',
			width_px: null
		});
		d = addColumn(d, {
			kind: 'navigation',
			source: { kind: 'column', index: 1 },
			mode: 'collapse',
			keep_empty: true,
			sort_mode: 'value',
			cell_cap: 20,
			header: '',
			width_px: null,
			navigation: {
				definition: {
					kind: 'path',
					schema_version: 2,
					start: { kind: 'scope', types: [], criteria: [] },
					steps: [],
					exclude_visited: true
				}
			}
		});
		// removing column 0 (which nothing sources) should shift the nav's ref from 1 -> 0
		const next = removeColumn(d, 0);
		expect(next.columns).toHaveLength(2);
		expect(next.columns[1].source).toEqual({ kind: 'column', index: 0 });
	});

	it('moveColumn remaps ColumnRef.index', () => {
		// cols: [element(0), property(1), navigation source=column(1)(2)]
		let d = addColumn(base, {
			kind: 'property',
			source: { kind: 'row', chain_index: 0 },
			name: 'mass',
			mode: 'collapse',
			keep_empty: true,
			header: '',
			width_px: null
		});
		d = addColumn(d, {
			kind: 'navigation',
			source: { kind: 'column', index: 1 },
			mode: 'collapse',
			keep_empty: true,
			sort_mode: 'value',
			cell_cap: 20,
			header: '',
			width_px: null,
			navigation: {
				definition: {
					kind: 'path',
					schema_version: 2,
					start: { kind: 'scope', types: [], criteria: [] },
					steps: [],
					exclude_visited: true
				}
			}
		});
		// move property from 1 → 0; the nav column's source must follow to index 1
		const moved = moveColumn(d, 1, 0);
		const nav = moved.columns[2];
		expect(nav.source).toEqual({ kind: 'column', index: 0 });
	});

	it('moveColumn rejects a move that points a ref forward', () => {
		let d = addColumn(base, {
			kind: 'property',
			source: { kind: 'row', chain_index: 0 },
			name: 'mass',
			mode: 'collapse',
			keep_empty: true,
			header: '',
			width_px: null
		});
		d = addColumn(d, {
			kind: 'navigation',
			source: { kind: 'column', index: 1 },
			mode: 'collapse',
			keep_empty: true,
			sort_mode: 'value',
			cell_cap: 20,
			header: '',
			width_px: null,
			navigation: {
				definition: {
					kind: 'path',
					schema_version: 2,
					start: { kind: 'scope', types: [], criteria: [] },
					steps: [],
					exclude_visited: true
				}
			}
		});
		// moving the nav column (2) before its source (1) would make it point forward
		expect(() => moveColumn(d, 2, 1)).toThrow();
	});

	it('moveColumn is a no-op clone when from === to', () => {
		const moved = moveColumn(base, 0, 0);
		expect(moved).toEqual(base);
		expect(moved).not.toBe(base);
	});

	it('renameColumn does not mutate the input', () => {
		const next = renameColumn(base, 0, 'Name');
		expect(next.columns[0].header).toBe('Name');
		expect(base.columns[0].header).toBe('');
	});

	it('setColumnWidth does not mutate the input', () => {
		const next = setColumnWidth(base, 0, 120);
		expect(next.columns[0].width_px).toBe(120);
		expect(base.columns[0].width_px).toBeNull();
	});

	it('setColumnMode is a no-op on element columns', () => {
		const next = setColumnMode(base, 0, 'expand');
		expect(next.columns[0]).toEqual(base.columns[0]);
	});

	it('setColumnMode sets mode on property columns without mutating the input', () => {
		const withProp = addColumn(base, {
			kind: 'property',
			source: { kind: 'row', chain_index: 0 },
			name: 'mass',
			mode: 'collapse',
			keep_empty: true,
			header: '',
			width_px: null
		});
		const next = setColumnMode(withProp, 1, 'expand');
		const col = next.columns[1];
		expect(col.kind).toBe('property');
		if (col.kind === 'property') expect(col.mode).toBe('expand');
		const original = withProp.columns[1];
		expect(original.kind).toBe('property');
		if (original.kind === 'property') expect(original.mode).toBe('collapse');
	});

	it('columnLabel prefers header, then property name, then kind fallback', () => {
		expect(
			columnLabel({
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: 'Custom',
				width_px: null
			})
		).toBe('Custom');
		expect(
			columnLabel({
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'collapse',
				keep_empty: true,
				header: '',
				width_px: null
			})
		).toBe('mass');
		expect(
			columnLabel({
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: '',
				width_px: null
			})
		).toBe('Element');
		expect(
			columnLabel({
				kind: 'navigation',
				source: { kind: 'row', chain_index: 0 },
				mode: 'collapse',
				keep_empty: true,
				sort_mode: 'value',
				cell_cap: 20,
				header: '',
				width_px: null,
				navigation: {
					definition: {
						kind: 'path',
						schema_version: 2,
						start: { kind: 'scope', types: [], criteria: [] },
						steps: [],
						exclude_visited: true
					}
				}
			})
		).toBe('Navigation');
	});
});
