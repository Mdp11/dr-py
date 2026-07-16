import { describe, it, expect, test } from 'vitest';
import {
	addColumn,
	removeColumn,
	moveColumn,
	renameColumn,
	replaceColumn,
	setColumnWidth,
	setColumnMode,
	columnKindLabel,
	columnLabel,
	ColumnInUseError,
	navMaxStepIndex,
	newNavigationColumn,
	newPropertyColumn
} from '$lib/table/columns';
import { ColumnSchema, TableDefinitionSchema } from '$lib/api/types';
import type { NavigationDefinition, TableDefinition } from '$lib/api/types';

const base: TableDefinition = {
	schema_version: 1,
	default_cell_mode: 'collapse',
	row_source: { kind: 'scope', types: ['Block'], criteria: [] },
	columns: [
		{
			kind: 'element',
			source: { kind: 'row', chain_index: 0 },
			header: '',
			width_px: null,
			hidden: false
		}
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
			width_px: null,
			hidden: false
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
			hidden: false,
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
			width_px: null,
			hidden: false
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
			hidden: false,
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
			width_px: null,
			hidden: false
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
			hidden: false,
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
			width_px: null,
			hidden: false
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
			hidden: false,
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

	it('setColumnWidth rounds fractional widths to an integer (the backend schema requires int)', () => {
		// Drag deltas come from PointerEvent.clientX, which is fractional under
		// browser zoom / HiDPI — a float width_px 422s every evaluate of the table.
		expect(setColumnWidth(base, 0, 123.4).columns[0].width_px).toBe(123);
		expect(setColumnWidth(base, 0, 123.6).columns[0].width_px).toBe(124);
		expect(setColumnWidth(base, 0, null).columns[0].width_px).toBeNull();
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
			width_px: null,
			hidden: false
		});
		const next = setColumnMode(withProp, 1, 'expand');
		const col = next.columns[1];
		expect(col.kind).toBe('property');
		if (col.kind === 'property') expect(col.mode).toBe('expand');
		const original = withProp.columns[1];
		expect(original.kind).toBe('property');
		if (original.kind === 'property') expect(original.mode).toBe('collapse');
	});

	it('replaceColumn swaps one column, keeping it BY REFERENCE, without mutating the input', () => {
		const replacement = {
			kind: 'property' as const,
			source: { kind: 'row' as const, chain_index: 0 },
			name: 'mass',
			mode: 'collapse' as const,
			keep_empty: true,
			header: '',
			width_px: null,
			hidden: false
		};
		const next = replaceColumn(base, 0, replacement);
		expect(next.columns[0]).toBe(replacement); // reference-preserving (mirror-loop guard)
		expect(base.columns[0].kind).toBe('element');
	});

	it('helpers tolerate definitions that embed reactive-state proxies', () => {
		// Regression: a Svelte $state proxy leaked into an inline navigation
		// definition made every structuredClone-based edit throw DataCloneError
		// ("#<Object> could not be cloned"), permanently bricking the table.
		// The copy-on-write helpers never deep-clone, so they must keep working
		// even when a proxy is present.
		const proxied = new Proxy(
			{
				kind: 'path',
				schema_version: 2,
				start: { kind: 'row' },
				steps: [],
				exclude_visited: true
			},
			{}
		);
		const withNav: TableDefinition = {
			...base,
			columns: [
				...base.columns,
				{
					kind: 'navigation',
					source: { kind: 'row', chain_index: 0 },
					mode: 'collapse',
					keep_empty: true,
					sort_mode: 'value',
					cell_cap: 20,
					header: '',
					width_px: null,
					hidden: false,
					navigation: { definition: proxied as never }
				}
			]
		};
		expect(() => structuredClone(withNav)).toThrow(); // the proxy really is uncloneable
		const renamed = renameColumn(withNav, 1, 'Nav');
		expect(renamed.columns[1].header).toBe('Nav');
		expect(() => moveColumn(withNav, 1, 0)).not.toThrow();
		expect(() => removeColumn(withNav, 0)).not.toThrow();
		expect(() => setColumnWidth(withNav, 1, 200)).not.toThrow();
	});

	it('mutators are copy-on-write: untouched columns keep their identity', () => {
		// NavigationColumnEditor's mirror-loop guard compares
		// columns[i].navigation.definition by REFERENCE; an unrelated edit must
		// not mint new objects for columns it didn't touch (that would blank
		// and re-run every inline-navigation preview on every keystroke).
		const nav: TableDefinition['columns'][number] = {
			kind: 'navigation',
			source: { kind: 'row', chain_index: 0 },
			mode: 'collapse',
			keep_empty: true,
			sort_mode: 'value',
			cell_cap: 20,
			header: 'Nav',
			width_px: null,
			hidden: false,
			navigation: {
				definition: {
					kind: 'path',
					schema_version: 2,
					start: { kind: 'row' },
					steps: [],
					exclude_visited: true
				}
			}
		};
		const defn: TableDefinition = { ...base, columns: [...base.columns, nav] };
		expect(renameColumn(defn, 0, 'X').columns[1]).toBe(nav);
		expect(setColumnWidth(defn, 0, 120).columns[1]).toBe(nav);
		expect(replaceColumn(defn, 0, defn.columns[0]).columns[1]).toBe(nav);
		expect(addColumn(defn, defn.columns[0]).columns[1]).toBe(nav);
		// A reorder keeps a ref-free column's identity too (only ColumnRef
		// carriers are re-made, to remap their index).
		expect(moveColumn(defn, 1, 0).columns[0]).toBe(nav);
		expect(removeColumn(defn, 0).columns[0]).toBe(nav);
	});

	it('columnKindLabel maps element to Scope and passes unknown kinds through', () => {
		expect(columnKindLabel('element')).toBe('Scope');
		expect(columnKindLabel('property')).toBe('Property');
		expect(columnKindLabel('navigation')).toBe('Navigation');
		expect(columnKindLabel('mystery')).toBe('mystery');
	});

	it('columnLabel prefers header, then property name, then kind fallback', () => {
		expect(
			columnLabel({
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: 'Custom',
				width_px: null,
				hidden: false
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
				width_px: null,
				hidden: false
			})
		).toBe('mass');
		expect(
			columnLabel({
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: '',
				width_px: null,
				hidden: false
			})
		).toBe('Scope');
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
				hidden: false,
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

test('factories produce schema-valid defaults', () => {
	expect(ColumnSchema.parse(newPropertyColumn())).toMatchObject({ hidden: false, name: '' });
	expect(ColumnSchema.parse(newNavigationColumn())).toMatchObject({ hidden: false, cell_cap: 20 });
});

test('navMaxStepIndex counts chain columns', () => {
	const path = {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: [], criteria: [] },
		steps: [
			{
				kind: 'relationship',
				relationship_type: 'r',
				direction: 'out',
				target_types: [],
				children: []
			},
			{ kind: 'filter', criteria: [] },
			{
				kind: 'relationship',
				relationship_type: 's',
				direction: 'out',
				target_types: [],
				children: []
			}
		],
		exclude_visited: true
	} as NavigationDefinition;
	expect(navMaxStepIndex(path)).toBe(2); // start + 2 relationship hops → max index 2
	expect(
		navMaxStepIndex({
			kind: 'set_op',
			schema_version: 2,
			op: 'union',
			operands: []
		} as NavigationDefinition)
	).toBe(0);
});

test('hidden and source step_index round-trip through the definition schema', () => {
	const defn = TableDefinitionSchema.parse({
		row_source: { kind: 'scope', types: [] },
		columns: [
			{ kind: 'element', source: { kind: 'row' } },
			{ kind: 'navigation', navigation: {}, hidden: true },
			{ kind: 'property', name: 'p', source: { kind: 'column', index: 1, step_index: 1 } }
		]
	});
	expect(defn.columns[1].hidden).toBe(true);
	expect((defn.columns[2].source as { step_index?: number | null }).step_index).toBe(1);
});
