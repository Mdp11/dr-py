import { expect, it } from 'vitest';
import { pyDumps } from '../../src/index.ts';
import { loadFixture, untag, type Tagged } from '../golden/load.ts';

it('serializes byte for byte as json.dumps does', () => {
	const cases =
		loadFixture<{ value: Tagged; compact?: string; indented?: string; default?: string }[]>(
			'json_dumps'
		);
	for (const c of cases) {
		const value = untag(c.value);
		if (c.default !== undefined) {
			expect(pyDumps(value, undefined, { ascii: true, spaced: true, allowNan: true })).toBe(
				c.default
			);
			continue;
		}
		expect(pyDumps(value)).toBe(c.compact);
		expect(pyDumps(value, 2)).toBe(c.indented);
	}
});
