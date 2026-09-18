import { expect, it } from 'vitest';
import { pyFloatRepr } from '../../src/index.ts';

it('lays floats out as Python does', () => {
	const cases: [number, string][] = [
		[0, '0.0'],
		[-0, '-0.0'],
		[5, '5.0'],
		[-2.5, '-2.5'],
		[0.1, '0.1'],
		[1e15, '1000000000000000.0'],
		[1e16, '1e+16'],
		[1.5e300, '1.5e+300'],
		[0.0001, '0.0001'],
		[0.00001, '1e-05'],
		[5e-324, '5e-324'],
		[NaN, 'nan'],
		[Infinity, 'inf'],
		[-Infinity, '-inf']
	];
	for (const [x, expected] of cases) expect(pyFloatRepr(x)).toBe(expected);
});
