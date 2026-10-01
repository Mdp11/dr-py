import { describe, expect, it } from 'vitest';
import { entryArity } from '../../src/script/arity.ts';
import { loadFixture } from '../golden/load.ts';

type Row = { code: string; name: string; arity: number | null };
const fixture = loadFixture<{ cases: Row[]; unparsed: Row[] }>('script_arity');

describe('entryArity against the oracle', () => {
	it.each(fixture.cases.map((row, i) => [i, row] as const))('case %i', (_i, row) => {
		expect(entryArity(row.code, row.name), JSON.stringify(row.code)).toBe(row.arity);
	});

	it('defaults to value', () => {
		expect(entryArity('def value(a, b): pass')).toBe(2);
	});

	it('answers a count for code the oracle does not parse and the scan cannot tell', () => {
		for (const row of fixture.unparsed) {
			expect(row.arity).toBeNull();
			expect(typeof entryArity(row.code, row.name)).toBe('number');
		}
	});
});
