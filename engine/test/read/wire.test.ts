import { describe, expect, it } from 'vitest';
import {
	ElementRec,
	PyFloat,
	ReadError,
	readOps,
	RelRec,
	toWire,
	wireElement,
	wireRelationship,
	type UpdateElementOp,
	type Value
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';

describe('toWire', () => {
	it('gives a float as its number and a big integer as the nearest double', () => {
		expect(toWire(new PyFloat(1))).toBe(1);
		expect(toWire(new PyFloat(-0.5))).toBe(-0.5);
		expect(toWire(9007199254740993n)).toBe(9007199254740992);
	});

	it('copies lists and dicts', () => {
		const source: Value = { a: [1, { b: 'x' }], c: { d: new PyFloat(2.5) } };
		const copy = toWire(source) as { a: [number, { b: string }]; c: { d: number } };
		expect(copy).toEqual({ a: [1, { b: 'x' }], c: { d: 2.5 } });
		copy.a[1].b = 'changed';
		copy.a.push(9);
		expect(source).toEqual({ a: [1, { b: 'x' }], c: { d: new PyFloat(2.5) } });
	});

	it('keeps an own __proto__ key an own key', () => {
		const source = JSON.parse('{"__proto__": {"x": 1}, "k": 2}') as Value;
		const copy = toWire(source) as object;
		expect(Object.keys(copy)).toEqual(['__proto__', 'k']);
		expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
		expect(JSON.stringify(copy)).toBe('{"__proto__":{"x":1},"k":2}');
	});

	it('writes entities in the response field order', () => {
		const a = new ElementRec('a', 'T', { name: 'A', w: new PyFloat(1) }, 3, 0);
		const b = new ElementRec('b', 'T', {}, 0, 1);
		expect(JSON.stringify(wireElement(a))).toBe(
			'{"id":"a","type_name":"T","properties":{"name":"A","w":1},"rev":3}'
		);
		expect(JSON.stringify(wireRelationship(new RelRec('r', 'R', a, b, {}, 1, 2)))).toBe(
			'{"id":"r","type_name":"R","source_id":"a","target_id":"b","properties":{},"rev":1}'
		);
		expect(wireElement(a).properties).not.toBe(a.props);
	});
});

describe('readOps', () => {
	it('reads values as the server reads what a client sends', () => {
		const [op] = readOps([
			{
				kind: 'update_element',
				id: 'x',
				properties_patch: { a: 1.5, b: 1, c: 1e21, d: -0, e: NaN, f: 2 ** 60, g: undefined }
			}
		]);
		expect(op).toEqual({
			kind: 'update_element',
			id: 'x',
			properties_patch: {
				a: new PyFloat(1.5),
				b: 1,
				c: new PyFloat(1e21),
				d: 0,
				e: null,
				// What `JSON.stringify` writes of 2 ** 60, and so what the server reads.
				f: 1152921504606847000n
			}
		});
		expect(Object.is((op as UpdateElementOp).properties_patch['d'], 0)).toBe(true);
	});

	it('keeps every op shape', () => {
		const ops = [
			{ kind: 'create_element', temp_id: 'tmp_a', type_name: 'T', properties: { n: 'a' } },
			{ kind: 'create_element', temp_id: 'tmp_b', type_name: 'T', id: 'b' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'R',
				source_id: 'tmp_a',
				target_id: 'b',
				id: null
			},
			{ kind: 'update_relationship', id: 'r', properties_patch: {} },
			{ kind: 'delete_relationship', id: 'r' },
			{ kind: 'delete_element', id: 'a' }
		];
		expect(readOps(ops)).toEqual(ops);
	});

	it.each<[string, unknown, string]>([
		['a non-list', { kind: 'delete_element', id: 'a' }, 'ops: must be a list'],
		['a non-object op', ['x'], 'ops[0]: must be an object'],
		[
			'an unknown kind',
			[{ kind: 'rename', id: 'a' }],
			'ops[0].kind: must be one of create_element, update_element, delete_element, ' +
				'create_relationship, update_relationship, delete_relationship'
		],
		['a missing id', [{ kind: 'delete_element' }], 'ops[0].id: must be a string'],
		[
			'a non-object patch',
			[{ kind: 'update_element', id: 'a', properties_patch: [1] }],
			'ops[0].properties_patch: must be an object'
		],
		[
			'a later op',
			[
				{ kind: 'delete_element', id: 'a' },
				{ kind: 'create_element', temp_id: 'tmp_x' }
			],
			'ops[1].type_name: must be a string'
		]
	])('refuses %s', (_, raw, detail) => {
		const error = thrown(() => readOps(raw));
		expect(error).toBeInstanceOf(ReadError);
		expect([(error as ReadError).status, (error as ReadError).detail]).toEqual([422, detail]);
	});
});
