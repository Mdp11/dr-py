import { expect, it } from 'vitest';
import { PyFloat, pyEq, type Value } from '../../src/index.ts';

const withProto = (value: Value): Value => {
	const out: { [key: string]: Value } = {};
	Object.defineProperty(out, '__proto__', {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
	return out;
};

it('compares a dict with an own __proto__ key by that key', () => {
	expect(pyEq(withProto(1), withProto(1))).toBe(true);
	expect(pyEq(withProto(1), withProto(2))).toBe(false);
	expect(pyEq(withProto(1), {})).toBe(false);
	expect(pyEq({}, withProto(1))).toBe(false);
	expect(pyEq(withProto(1), { a: 1 })).toBe(false);
});

it('compares a 10,000-deep nested list', () => {
	const nest = (leaf: Value): Value => {
		let v: Value = leaf;
		for (let i = 0; i < 10_000; i++) v = [v];
		return v;
	};
	expect(pyEq(nest(1), nest(1))).toBe(true);
	expect(pyEq(nest(1), nest(2))).toBe(false);
});

it('compares a bigint with a PyFloat exactly and symmetrically', () => {
	const big = 2n ** 53n + 1n;
	const cases: [Value, Value, boolean][] = [
		[big, new PyFloat(2 ** 53), false],
		[2n ** 53n, new PyFloat(2 ** 53), true],
		[2n ** 70n, new PyFloat(2 ** 70), true],
		[2n ** 70n + 1n, new PyFloat(2 ** 70), false],
		[big, new PyFloat(Infinity), false],
		[big, new PyFloat(NaN), false],
		[big, new PyFloat(2 ** 53 + 0.5), false]
	];
	for (const [a, b, eq] of cases) {
		expect(pyEq(a, b)).toBe(eq);
		expect(pyEq(b, a)).toBe(eq);
	}
});

it('treats booleans, ints and floats as numbers', () => {
	expect(pyEq(true, 1)).toBe(true);
	expect(pyEq(false, new PyFloat(-0))).toBe(true);
	expect(pyEq(new PyFloat(NaN), new PyFloat(NaN))).toBe(false);
	expect(pyEq('1', 1)).toBe(false);
	expect(pyEq(null, false)).toBe(false);
	expect(pyEq([], {})).toBe(false);
});
