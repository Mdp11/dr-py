import { expect, it } from 'vitest';
import { pyRepr } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';

it('renders repr(str) as Python does', () => {
	const cases = loadFixture<{ s: string; repr: string }[]>('py_repr');
	for (const c of cases) expect(pyRepr(c.s)).toBe(c.repr);
});
