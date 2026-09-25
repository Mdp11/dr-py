import { describe, expect, it } from 'vitest';
import {
	buildRowsSteps,
	DEFAULT_TABLE_LIMITS,
	drain,
	Metamodel,
	Meter,
	Model,
	NavMemo,
	orderRowsSteps,
	readTableDefinition,
	sortKeys,
	type MetamodelDoc,
	type Value
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';

const prop = (name: string, datatype = 'string') => ({
	name,
	datatype,
	multiplicity: '0..1',
	min: null,
	max: null,
	pattern: null,
	max_length: null
});

const DOC: MetamodelDoc = {
	enums: {},
	elements: [
		{
			name: 'Thing',
			abstract: false,
			extends: null,
			properties: [prop('name'), prop('s'), prop('n', 'integer')],
			key: null
		}
	],
	relationships: []
};

function things(values: [id: string, s: Value | undefined, n?: Value][]): Model {
	const model = new Model(Metamodel.fromJSON(DOC));
	for (const [id, s, n] of values) {
		const element = model.createElement('Thing', id);
		if (s !== undefined) model.setProperty(element, 's', s);
		if (n !== undefined) model.setProperty(element, 'n', n);
	}
	return model;
}

const definition = (sort: object[]) =>
	readTableDefinition(
		{
			row_source: { kind: 'scope' },
			columns: [
				{ kind: 'element' },
				{ kind: 'property', name: 's' },
				{ kind: 'property', name: 'n' }
			],
			sort
		},
		'definition'
	);

/** The row ids in the order the sort gives them. */
function ordered(model: Model, sort: object[]): string[] {
	const defn = definition(sort);
	const meter = new Meter(0);
	const built = drain(buildRowsSteps(model, defn, DEFAULT_TABLE_LIMITS, meter, new NavMemo()));
	const keys = drain(
		orderRowsSteps(model, defn, built.keys, built.baseSlots, meter, new NavMemo())
	);
	return keys.map((key) => key[0] as string);
}

describe('orderRowsSteps', () => {
	const model = things([
		['a', 'x'],
		['b', 'y'],
		['c', 'x'],
		['d', 'y'],
		['e', undefined],
		['f', 'X']
	]);

	it('keeps equal rows in build order, ascending and descending, empties last', () => {
		expect(ordered(model, [{ column: 1 }])).toEqual(['a', 'c', 'f', 'b', 'd', 'e']);
		expect(ordered(model, [{ column: 1, direction: 'desc' }])).toEqual([
			'b',
			'd',
			'a',
			'c',
			'f',
			'e'
		]);
	});

	it('never reverses the ascending order to sort descending', () => {
		const asc = ordered(model, [{ column: 1 }]);
		const desc = ordered(model, [{ column: 1, direction: 'desc' }]);
		expect(desc).not.toEqual([...asc.slice(0, -1)].reverse().concat('e'));
	});

	it('breaks the ties of a key with the next one', () => {
		expect(
			ordered(model, [
				{ column: 1, direction: 'desc' },
				{ column: 0, direction: 'desc' }
			])
		).toEqual(['d', 'b', 'f', 'c', 'a', 'e']);
	});

	it('orders ints past 2^53 as Python floats them', () => {
		const big = things([
			['a', 'x', 2n ** 53n + 1n],
			['b', 'x', 2 ** 53],
			['c', 'x', 2n ** 64n],
			['d', 'x', -1]
		]);
		expect(ordered(big, [{ column: 2 }])).toEqual(['d', 'a', 'b', 'c']);
		expect(ordered(big, [{ column: 2, direction: 'desc' }])).toEqual(['c', 'a', 'b', 'd']);
	});

	it('throws, as Python does, on an int no float holds', () => {
		const huge = things([
			['a', 'x', 10n ** 400n],
			['b', 'x', 1]
		]);
		const error = thrown(() => ordered(huge, [{ column: 2 }]));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('int too large to convert to float');
		expect(ordered(huge, [{ column: 1 }])).toEqual(['a', 'b']);
	});
});

describe('sortKeys', () => {
	it('drops out-of-range and repeated columns, the first one winning', () => {
		expect(
			sortKeys(
				definition([
					{ column: 5 },
					{ column: 1 },
					{ column: 1, direction: 'desc' },
					{ column: 0, direction: 'desc' },
					{ column: 3 }
				])
			)
		).toEqual([
			{ column: 1, direction: 'asc' },
			{ column: 0, direction: 'desc' }
		]);
	});
});
