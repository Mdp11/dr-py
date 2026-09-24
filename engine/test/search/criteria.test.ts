import { describe, expect, it } from 'vitest';
import {
	compileCriteria,
	matchElement,
	matchRelationship,
	Model,
	nameProp,
	PyFloat,
	PyOverflowError,
	readCriteria,
	ReadError,
	type Criterion
} from '../../src/index.ts';
import { nodeMetamodel } from '../model/fixtures.ts';

/** The refusal `run` throws, as `{status, detail}`. */
function refusal(run: () => unknown): { status: number; detail: string } {
	try {
		run();
	} catch (error) {
		if (error instanceof ReadError) return { status: error.status, detail: error.detail };
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('readCriteria', () => {
	it('fills the defaults', () => {
		expect(
			readCriteria(
				[
					{ type: 'entity_type' },
					{ type: 'property', name: 'n', op: 'exists' },
					{ type: 'name_id', field: 'id', op: 'contains' },
					{ type: 'relation_count', op: 'at_least', count: 1, direction: 'either' },
					{ type: 'orphan' },
					{ type: 'connected_to_type', direction: 'outgoing' },
					{ type: 'endpoint_type', endpoint: 'source' },
					{ type: 'any_of' }
				],
				'criteria'
			)
		).toEqual([
			{ type: 'entity_type', names: [] },
			{ type: 'property', name: 'n', datatype: null, op: 'exists', value: '' },
			{ type: 'name_id', field: 'id', op: 'contains', value: '' },
			{ type: 'relation_count', op: 'at_least', count: 1, direction: 'either', rel_types: [] },
			{ type: 'orphan' },
			{ type: 'connected_to_type', direction: 'outgoing', names: [] },
			{ type: 'endpoint_type', endpoint: 'source', names: [] },
			{ type: 'any_of', criteria: [] }
		]);
	});

	it('takes relTypes and rel_types, the alias winning when both are given', () => {
		const count = { type: 'relation_count', op: 'exactly', count: 2, direction: 'incoming' };
		const [a, b, c] = readCriteria(
			[
				{ ...count, relTypes: ['A'] },
				{ ...count, rel_types: ['B'] },
				{ ...count, relTypes: ['A'], rel_types: ['B'] }
			],
			'criteria'
		);
		expect([a, b, c].map((criterion) => (criterion as { rel_types: string[] }).rel_types)).toEqual([
			['A'],
			['B'],
			['A']
		]);
	});

	it('ignores unknown keys, and copies what it reads', () => {
		const names = ['Node'];
		const [read] = readCriteria(
			[{ type: 'entity_type', names, unknown: 1, datatype: 5 }],
			'criteria'
		);
		expect(read).toEqual({ type: 'entity_type', names: ['Node'] });
		names.push('Other');
		expect(read).toEqual({ type: 'entity_type', names: ['Node'] });
	});

	it('refuses a missing type, a nested any_of and a count that is a string, naming the path', () => {
		expect(refusal(() => readCriteria([{ names: [] }], 'criteria'))).toEqual({
			status: 422,
			detail:
				'criteria[0].type: must be one of entity_type, property, name_id, relation_count, ' +
				'orphan, connected_to_type, endpoint_type, any_of'
		});
		expect(
			refusal(() =>
				readCriteria(
					[
						{ type: 'orphan' },
						{ type: 'any_of', criteria: [{ type: 'orphan' }, { type: 'any_of' }] }
					],
					'criteria'
				)
			)
		).toEqual({
			status: 422,
			detail: 'criteria[1].criteria[1].type: an any_of group holds no other group'
		});
		expect(
			refusal(() =>
				readCriteria(
					[{ type: 'relation_count', op: 'at_least', count: '3', direction: 'either' }],
					'definition.criteria'
				)
			)
		).toEqual({ status: 422, detail: 'definition.criteria[0].count: must be an integer' });
	});

	it('refuses what pydantic would coerce or refuse', () => {
		const bad: [unknown, string][] = [
			[{ type: 'x' }, 'criteria[0].type'],
			['orphan', 'criteria[0]'],
			[{ type: 'entity_type', names: 'Node' }, 'criteria[0].names'],
			[{ type: 'entity_type', names: [1] }, 'criteria[0].names'],
			[{ type: 'property', op: 'exists' }, 'criteria[0].name'],
			[{ type: 'property', name: 'n', op: 'nope' }, 'criteria[0].op'],
			[{ type: 'property', name: 'n', op: 'equals', value: 3 }, 'criteria[0].value'],
			[{ type: 'property', name: 'n', op: 'equals', datatype: 3 }, 'criteria[0].datatype'],
			[{ type: 'name_id', field: 'type', op: 'equals' }, 'criteria[0].field'],
			[{ type: 'name_id', field: 'id', op: 'gt' }, 'criteria[0].op'],
			[
				{ type: 'relation_count', op: 'at_least', count: true, direction: 'out' },
				'criteria[0].count'
			],
			[
				{ type: 'relation_count', op: 'at_least', count: 1.5, direction: 'either' },
				'criteria[0].count'
			],
			[
				{ type: 'relation_count', op: 'at_least', count: 1, direction: 'out' },
				'criteria[0].direction'
			],
			[
				{ type: 'relation_count', op: 'at_least', count: 1, direction: 'either', relTypes: null },
				'criteria[0].relTypes'
			],
			[{ type: 'endpoint_type', endpoint: 'both' }, 'criteria[0].endpoint'],
			[{ type: 'any_of', criteria: {} }, 'criteria[0].criteria']
		];
		for (const [criterion, where] of bad) {
			const { status, detail } = refusal(() => readCriteria([criterion], 'criteria'));
			expect(status).toBe(422);
			expect(detail.startsWith(`${where}: `), detail).toBe(true);
		}
		expect(refusal(() => readCriteria(null, 'criteria'))).toEqual({
			status: 422,
			detail: 'criteria: must be a list'
		});
	});
});

describe('compileCriteria', () => {
	const matches = (value: string): Criterion[] =>
		readCriteria([{ type: 'property', name: 'name', op: 'matches', value }], 'criteria');

	it('refuses an unsupported pattern with 501, in an any_of group too', () => {
		const unsupported = { status: 501, detail: 'reaches an unsupported pattern' };
		expect(refusal(() => compileCriteria(matches('(?x)a')))).toEqual(unsupported);
		const grouped = readCriteria(
			[
				{
					type: 'any_of',
					criteria: [{ type: 'name_id', field: 'id', op: 'matches', value: '(?x)a' }]
				}
			],
			'criteria'
		);
		expect(refusal(() => compileCriteria(grouped))).toEqual(unsupported);
	});

	it('refuses a pattern nested too deep to translate with 501', () => {
		const deep = '('.repeat(100_000) + 'a' + ')'.repeat(100_000);
		expect(refusal(() => compileCriteria(matches(deep)))).toEqual({
			status: 501,
			detail: 'reaches an unsupported pattern'
		});
	});

	it('accepts an invalid pattern, which then never matches', () => {
		const model = new Model(nodeMetamodel());
		const element = model.createElement('Node', 'a');
		model.setProperty(element, 'name', '[');
		const criteria = matches('[');
		const compiled = compileCriteria(criteria);
		expect(matchElement(model, element, criteria[0]!, compiled)).toBe(false);
	});
});

describe('the matchers', () => {
	function scene() {
		const model = new Model(nodeMetamodel());
		const a = model.createElement('Node', 'a');
		const b = model.createElement('Node', 'b');
		model.connect('Refers', 'a', 'a', 'loop');
		model.connect('Refers', 'a', 'b', 'ab1');
		model.connect('Refers', 'a', 'b', 'ab2');
		model.connect('Contains', 'b', 'a', 'ba');
		return { model, a, b };
	}

	const check = (model: Model, raw: unknown[]) => {
		const criteria = readCriteria(raw, 'criteria');
		const compiled = compileCriteria(criteria);
		return (subject: ReturnType<Model['getElement']>) =>
			criteria.every((c) => matchElement(model, subject, c, compiled));
	};

	it('counts a self-loop once and parallel edges each', () => {
		const { model, a } = scene();
		const count = (direction: string, n: number, relTypes: string[] = []) =>
			check(model, [{ type: 'relation_count', op: 'exactly', count: n, direction, relTypes }])(a);
		expect(count('outgoing', 3)).toBe(true);
		expect(count('incoming', 2)).toBe(true);
		expect(count('either', 4)).toBe(true);
		expect(count('either', 3, ['Refers'])).toBe(true);
		expect(count('either', 1, ['Contains'])).toBe(true);
	});

	it("reads a self-loop's far end as the element itself", () => {
		const model = new Model(nodeMetamodel());
		const c = model.createElement('Node', 'c');
		const connected = (direction: string, names: string[]) =>
			check(model, [{ type: 'connected_to_type', direction, names }])(c);
		expect(connected('outgoing', ['Node'])).toBe(false);
		model.connect('Refers', 'c', 'c', 'loop');
		expect(connected('outgoing', ['Node'])).toBe(true);
		expect(connected('incoming', ['Node'])).toBe(true);
		expect(connected('either', ['Other'])).toBe(false);
	});

	it('never lets a contains split a surrogate pair', () => {
		const model = new Model(nodeMetamodel());
		const element = model.createElement('Node', 'a');
		model.setProperty(element, 'name', 'x\u{1f600}');
		const contains = (value: string) =>
			check(model, [{ type: 'property', name: 'name', op: 'contains', value }])(element);
		expect(contains('\u{1f600}')).toBe(true);
		expect(contains('x\ud83d')).toBe(false);
		expect(contains('\ude00')).toBe(false);
		expect(contains('')).toBe(true);
	});

	it('throws the int float() cannot take, as Python raises it', () => {
		const model = new Model(nodeMetamodel());
		const element = model.createElement('Node', 'a');
		model.setProperty(element, 'name', 10n ** 400n);
		const gt = check(model, [{ type: 'property', name: 'name', op: 'gt', value: '0' }]);
		expect(() => gt(element)).toThrow(PyOverflowError);
		expect(() => gt(element)).toThrow('int too large to convert to float');
		model.setProperty(element, 'name', new PyFloat(1e308));
		expect(gt(element)).toBe(true);
	});

	it('refuses with 501 a subject too long for the translated pattern to backtrack over', () => {
		const model = new Model(nodeMetamodel());
		const element = model.createElement('Node', 'a');
		model.setProperty(element, 'name', 'a'.repeat(1_000_000));
		const nested = '('.repeat(64) + 'a' + ')'.repeat(64) + '*$';
		const run = check(model, [{ type: 'property', name: 'name', op: 'matches', value: nested }]);
		expect(refusal(() => run(element))).toEqual({
			status: 501,
			detail: 'reaches an unsupported pattern'
		});
	});

	it('lets an element-only criterion pass a relationship and the reverse', () => {
		const { model, a } = scene();
		const rel = model.getRelationship('ab1');
		const criteria = readCriteria(
			[{ type: 'orphan' }, { type: 'endpoint_type', endpoint: 'target', names: ['Nope'] }],
			'criteria'
		);
		const compiled = compileCriteria(criteria);
		expect(matchRelationship(model, rel, criteria[0]!, compiled)).toBe(true);
		expect(matchRelationship(model, rel, criteria[1]!, compiled)).toBe(false);
		expect(matchElement(model, a, criteria[0]!, compiled)).toBe(false);
		expect(matchElement(model, a, criteria[1]!, compiled)).toBe(true);
	});
});

describe('nameProp', () => {
	it('takes a non-empty string only, `name` first, then other casings in order', () => {
		expect(nameProp({ name: ['listed'], Name: 'Cased' })).toBe('Cased');
		expect(nameProp({ NAME: 'upper', name: 'exact' })).toBe('exact');
		expect(nameProp({ name: '', NAME: 'upper', Name: 'cased' })).toBe('upper');
		expect(nameProp({ name: ['listed'] })).toBe(null);
		expect(nameProp({ Name: 1, nAme: 'x' })).toBe('x');
		expect(nameProp({})).toBe(null);
	});
});
