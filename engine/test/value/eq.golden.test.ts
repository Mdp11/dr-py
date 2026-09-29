import { expect, it } from 'vitest';
import { pyEq } from '../../src/index.ts';
import { loadFixture, untag, type Tagged } from '../golden/load.ts';

it('compares values exactly as Python == does, in both orders', () => {
	const c = loadFixture<{ pairs: { a: Tagged; b: Tagged; eq: boolean }[] }>('py_eq');
	expect(c.pairs.length).toBeGreaterThan(0);
	for (const { a, b, eq } of c.pairs) {
		const x = untag(a);
		const y = untag(b);
		expect(pyEq(x, y), JSON.stringify([a, b])).toBe(eq);
		expect(pyEq(y, x), JSON.stringify([b, a])).toBe(eq);
	}
});
