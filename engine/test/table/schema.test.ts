import { describe, expect, it } from 'vitest';
import {
	ArtifactSet,
	ReadError,
	readTableDefinition,
	resolveTableRefs,
	tableFetch,
	tableHasScript,
	navigationFetch,
	type CommittedArtifact
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';

const refusal = (run: () => unknown) => {
	const error = thrown(run);
	if (!(error instanceof ReadError)) throw new Error(`expected a refusal, got ${String(error)}`);
	return { status: error.status, detail: error.detail };
};

const scope = { kind: 'scope' };
const linked = {
	kind: 'path',
	start: { kind: 'row' },
	steps: [{ kind: 'relationship', relationship_type: 'Refers' }]
};
const table = (columns: object[], extra: object = {}) => ({
	row_source: scope,
	columns,
	...extra
});
const read = (raw: unknown) => readTableDefinition(raw, 'definition');

const presentation = {
	header: '',
	width_px: null,
	hidden: false,
	json_export: null,
	export: null
};

describe('readTableDefinition', () => {
	it('fills every default and ignores unknown keys', () => {
		expect(
			read({
				unknown: 1,
				row_source: { kind: 'scope', extra: true },
				columns: [
					{ kind: 'element', mystery: 'x' },
					{ kind: 'property', name: 'n' },
					{ kind: 'navigation', navigation: {} },
					{ kind: 'script' }
				]
			})
		).toEqual({
			schema_version: 1,
			row_source: { kind: 'scope', types: [], criteria: [] },
			columns: [
				{ kind: 'element', source: { kind: 'row', chain_index: 0 }, ...presentation },
				{
					kind: 'property',
					source: { kind: 'row', chain_index: 0 },
					name: 'n',
					mode: 'collapse',
					keep_empty: true,
					...presentation
				},
				{
					kind: 'navigation',
					source: { kind: 'row', chain_index: 0 },
					navigation: { ref: null, definition: null },
					step_index: null,
					mode: 'collapse',
					keep_empty: true,
					sort_mode: 'value',
					cell_cap: 20,
					...presentation
				},
				{
					kind: 'script',
					source: { kind: 'row', chain_index: 0 },
					snippet: { ref: null, definition: null },
					inputs: [],
					mode: 'collapse',
					keep_empty: true,
					...presentation
				}
			],
			default_cell_mode: 'collapse',
			show_row_numbers: false,
			export_order: [],
			display_order: [],
			sort: [],
			export_row_number: null,
			json_split: null,
			transform: null
		});
	});

	it('reads every row source and the presentation settings', () => {
		const defn = read({
			row_source: { kind: 'chains', navigation: { definition: linked }, unique: true },
			columns: [
				{
					kind: 'element',
					source: { kind: 'row', chain_index: 1 },
					header: 'H',
					width_px: 120,
					hidden: true,
					json_export: { key: 'k', group: true },
					export: { include: false }
				}
			],
			sort: [{ column: 0 }, { column: 3, direction: 'desc' }],
			export_row_number: { key: 'n' },
			json_split: { enabled: true },
			transform: { ref: 's1' },
			export_order: [-1, 0],
			display_order: [0]
		});
		expect(defn.row_source).toEqual({
			kind: 'chains',
			navigation: {
				ref: null,
				definition: {
					kind: 'path',
					start: { kind: 'row' },
					steps: [
						{
							kind: 'relationship',
							relationship_type: 'Refers',
							direction: 'out',
							target_types: []
						}
					],
					exclude_visited: true
				}
			},
			unique: true
		});
		expect(defn.columns[0]).toEqual({
			kind: 'element',
			source: { kind: 'row', chain_index: 1 },
			header: 'H',
			width_px: 120,
			hidden: true,
			json_export: { key: 'k', item_key: '', value: 'name', group: true, single: false },
			export: { include: false, header: '' }
		});
		expect(defn.sort).toEqual([
			{ column: 0, direction: 'asc' },
			{ column: 3, direction: 'desc' }
		]);
		expect(defn.export_row_number).toEqual({ include: true, header: '', key: 'n' });
		expect(defn.json_split).toEqual({ enabled: true, filename_template: '' });
		expect(defn.transform).toEqual({ ref: 's1', definition: null });
		expect(
			read({
				row_source: { kind: 'navigation', navigation: { ref: 'n1' }, step_index: -1 },
				columns: [{ kind: 'element' }]
			}).row_source
		).toEqual({ kind: 'navigation', navigation: { ref: 'n1', definition: null }, step_index: -1 });
	});

	it.each([
		[
			[{ kind: 'element', source: { kind: 'column', index: 0 } }],
			'definition.columns[0].source: column 0 sources column 0 (must be < 0)'
		],
		[
			[{ kind: 'element' }, { kind: 'property', name: 'n', source: { kind: 'column', index: 3 } }],
			'definition.columns[1].source: column 1 sources column 3 (must be < 1)'
		],
		[
			[
				{ kind: 'element' },
				{ kind: 'property', name: 'n', source: { kind: 'column', index: 0, step_index: 1 } }
			],
			'definition.columns[1].source: column 1: source step_index requires the referenced column to be a navigation column'
		],
		[
			[{ kind: 'element', source: { kind: 'row', chain_index: 1 } }],
			'definition.columns[0].source: chain_index != 0 requires a chains row source'
		],
		[
			[
				{ kind: 'navigation', navigation: {} },
				{ kind: 'element', source: { kind: 'column', index: 0 } }
			],
			'definition.columns[1].source: column 1: element column needs a single-binding source'
		],
		[
			[
				{ kind: 'navigation', navigation: {}, mode: 'expand' },
				{ kind: 'element', source: { kind: 'column', index: 0, step_index: 0 } }
			],
			'definition.columns[1].source: column 1: element column needs a single-binding source'
		],
		[
			[
				{ kind: 'property', name: 'n' },
				{ kind: 'element', source: { kind: 'column', index: 0 } }
			],
			'definition.columns[1].source: column 1: element column needs a single-binding source'
		],
		[
			[
				{ kind: 'element' },
				{
					kind: 'script',
					inputs: [
						{ name: 'a', ref: { index: 0 } },
						{ name: 'a', ref: { index: 0 } }
					]
				}
			],
			"definition.columns[1].inputs: column 1: duplicate input name 'a'"
		],
		[
			[{ kind: 'element' }, { kind: 'script', inputs: [{ name: 'a', ref: { index: 1 } }] }],
			"definition.columns[1].inputs[0].ref: column 1: input 'a' references column 1 (must be < 1)"
		],
		[
			[
				{ kind: 'element' },
				{ kind: 'script', inputs: [{ name: 'a', ref: { index: 0, step_index: 0 } }] }
			],
			"definition.columns[1].inputs[0].ref: column 1: input 'a' step_index requires the referenced column to be a navigation column"
		]
	])('refuses what the core refuses, with a path: %j', (columns, detail) => {
		expect(refusal(() => read(table(columns)))).toEqual({ status: 422, detail });
	});

	it('accepts what the core accepts', () => {
		const ok = [
			[{ kind: 'element' }, { kind: 'element', source: { kind: 'column', index: 0 } }],
			[
				{ kind: 'navigation', navigation: {}, mode: 'expand' },
				{ kind: 'element', source: { kind: 'column', index: 0 } }
			],
			[
				{ kind: 'property', name: 'n', mode: 'expand' },
				{ kind: 'element', source: { kind: 'column', index: 0 } }
			],
			[
				{ kind: 'script', mode: 'expand' },
				{ kind: 'element', source: { kind: 'column', index: 0 } }
			],
			[
				{ kind: 'navigation', navigation: {} },
				{
					kind: 'property',
					name: 'n',
					mode: 'expand',
					source: { kind: 'column', index: 0, step_index: 2 }
				}
			],
			[
				{ kind: 'element' },
				{ kind: 'script', inputs: [{ name: 'élan_2', ref: { kind: 'column', index: 0 } }] }
			]
		];
		for (const columns of ok) expect(() => read(table(columns))).not.toThrow();
		expect(() =>
			read({
				row_source: { kind: 'chains', navigation: {} },
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: 4 } }]
			})
		).not.toThrow();
	});

	it.each([
		[{ columns: [{ kind: 'element' }] }, 'definition.row_source: must be an object'],
		[
			{ row_source: { kind: 'rows' }, columns: [{ kind: 'element' }] },
			'definition.row_source.kind: must be one of scope, navigation, chains'
		],
		[{ row_source: scope, columns: [] }, 'definition.columns: must hold 1 to 50 columns'],
		[
			{ row_source: scope, columns: Array(51).fill({ kind: 'element' }) },
			'definition.columns: must hold 1 to 50 columns'
		],
		[
			{ row_source: scope, columns: [{}] },
			'definition.columns[0].kind: must be one of element, property, navigation, script'
		],
		[
			{ row_source: scope, columns: [{ kind: 'element', source: {} }] },
			'definition.columns[0].source.kind: must be one of row, column'
		],
		[
			{
				row_source: scope,
				columns: [{ kind: 'element', source: { kind: 'row', chain_index: -1 } }]
			},
			'definition.columns[0].source.chain_index: must be an integer of at least 0'
		],
		[
			{ row_source: scope, columns: [{ kind: 'property' }] },
			'definition.columns[0].name: must be a string'
		],
		[
			{ row_source: scope, columns: [{ kind: 'property', name: 'n', mode: 'split' }] },
			'definition.columns[0].mode: must be one of collapse, expand'
		],
		[
			{ row_source: scope, columns: [{ kind: 'navigation' }] },
			'definition.columns[0].navigation: must be an object'
		],
		[
			{
				row_source: scope,
				columns: [{ kind: 'navigation', navigation: { ref: 'n', definition: linked } }]
			},
			'definition.columns[0].navigation: provide at most one of `ref` / `definition`'
		],
		[
			{ row_source: scope, columns: [{ kind: 'navigation', navigation: {}, cell_cap: 0 }] },
			'definition.columns[0].cell_cap: must be an integer of at least 1'
		],
		[
			{ row_source: scope, columns: [{ kind: 'script', snippet: { ref: 's', definition: {} } }] },
			'definition.columns[0].snippet: provide at most one of `ref` / `definition`'
		],
		[
			{
				row_source: scope,
				columns: [{ kind: 'script', inputs: [{ name: 'class', ref: { index: 0 } }] }]
			},
			"definition.columns[0].inputs[0].name: input name 'class' is not a valid identifier"
		],
		[
			{
				row_source: scope,
				columns: [{ kind: 'script', inputs: [{ name: '1a', ref: { index: 0 } }] }]
			},
			"definition.columns[0].inputs[0].name: input name '1a' is not a valid identifier"
		],
		[
			{ row_source: scope, columns: [{ kind: 'element', width_px: 1.5 }] },
			'definition.columns[0].width_px: must be an integer or null'
		],
		[
			{ row_source: scope, columns: [{ kind: 'element' }], sort: [{ column: -1 }] },
			'definition.sort[0].column: must be an integer of at least 0'
		],
		[
			{ row_source: scope, columns: [{ kind: 'element' }], sort: [{ column: 0, direction: 'up' }] },
			'definition.sort[0].direction: must be one of asc, desc'
		],
		[
			{ row_source: scope, columns: [{ kind: 'element' }], show_row_numbers: 'yes' },
			'definition.show_row_numbers: must be a boolean'
		],
		[
			{ row_source: scope, columns: [{ kind: 'element' }], export_order: [0.5] },
			'definition.export_order: must be a list of integers'
		],
		[
			{
				row_source: { kind: 'navigation', navigation: { definition: { kind: 'path' } } },
				columns: [{ kind: 'element' }]
			},
			'definition.row_source.navigation.definition.start: must be an object'
		]
	])('refuses a malformed shape: %j', (raw, detail) => {
		expect(refusal(() => read(raw))).toEqual({ status: 422, detail });
	});
});

describe('a stored table', () => {
	const artifact = (id: string, kind: string, payload: object): CommittedArtifact => ({
		id,
		kind,
		name: id,
		rev: 1,
		payload: payload as CommittedArtifact['payload']
	});
	const raw = {
		schema_version: 1,
		row_source: { kind: 'navigation', navigation: { ref: 'n1' } },
		columns: [{ kind: 'element' }, { kind: 'navigation', navigation: { definition: linked } }],
		sort: [{ column: 1, direction: 'desc' }]
	};

	it('reads as an inline definition reads', () => {
		const set = new ArtifactSet();
		set.setCommitted([artifact('t1', 'table', raw), artifact('n1', 'navigation', linked)]);
		expect(tableFetch(set)('t1')).toEqual(read(raw));
	});

	it('refuses an id no table has', () => {
		const set = new ArtifactSet();
		set.setCommitted([artifact('n1', 'navigation', linked)]);
		expect(thrown(() => tableFetch(set)('n1'))).toMatchObject({ name: 'RefNotFoundError' });
		expect(thrown(() => tableFetch(set)('nope'))).toMatchObject({ name: 'RefNotFoundError' });
	});

	it('resolves its navigations and sees a script through a ref', () => {
		const scripted = {
			kind: 'path',
			start: { kind: 'row' },
			steps: [{ kind: 'script', snippet: { ref: 's1' } }]
		};
		const set = new ArtifactSet();
		set.setCommitted([
			artifact('n1', 'navigation', linked),
			artifact('n2', 'navigation', scripted),
			artifact('n3', 'navigation', { kind: 'set_op', op: 'union', operands: [{ ref: 'gone' }] })
		]);
		const fetch = navigationFetch(set);
		const plain = resolveTableRefs(read(raw), fetch);
		expect(plain.row_source).toMatchObject({ navigation: { ref: null, definition: linked } });
		expect(tableHasScript(plain)).toBe(false);
		const viaRef = read(table([{ kind: 'navigation', navigation: { ref: 'n2' } }]));
		expect(tableHasScript(viaRef)).toBe(false);
		expect(tableHasScript(resolveTableRefs(viaRef, fetch))).toBe(true);
		expect(
			refusal(() =>
				resolveTableRefs(read(table([{ kind: 'navigation', navigation: { ref: 'x' } }])), fetch)
			)
		).toEqual({ status: 422, detail: 'unknown artifact x' });
		expect(
			refusal(() =>
				resolveTableRefs(read(table([{ kind: 'navigation', navigation: { ref: 'n3' } }])), fetch)
			)
		).toEqual({ status: 422, detail: "unknown navigation artifact 'gone'" });
	});
});
