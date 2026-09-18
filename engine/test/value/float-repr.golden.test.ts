import { expect, it } from 'vitest';
import { pyFloatRepr } from '../../src/index.ts';
import { doubleFromHex, loadFixture } from '../golden/load.ts';

it('renders every double as repr(float) does', () => {
	const cases = loadFixture<{ hex: string; repr: string }[]>('float_repr');
	expect(cases.length).toBeGreaterThanOrEqual(2000);
	for (const c of cases) expect(pyFloatRepr(doubleFromHex(c.hex)), c.hex).toBe(c.repr);
});
