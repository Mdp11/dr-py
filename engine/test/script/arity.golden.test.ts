import { describe, expect, it } from 'vitest';
import { entryArities, entryArity } from '../../src/script/arity.ts';
import { loadFixture } from '../golden/load.ts';

type Row = { code: string; name: string; arity: number | null; entry_points: string[] };
const fixture = loadFixture<{ cases: Row[]; unparsed: Row[] }>('script_arity');

describe('entryArity against the oracle', () => {
	it.each(fixture.cases.map((row, i) => [i, row] as const))('case %i', (_i, row) => {
		expect(entryArity(row.code, row.name), JSON.stringify(row.code)).toBe(row.arity);
	});

	// `derive_entry_points`: an entry is accepted when any top-level `def` of its name takes an accepted count.
	const ACCEPTED: { [name: string]: readonly number[] } = {
		value: [1, 2],
		step: [1],
		transform: [1]
	};
	it.each(
		fixture.cases
			.filter((row) => Object.hasOwn(ACCEPTED, row.name))
			.map((row, i) => [i, row] as const)
	)('every top-level def of an entry, case %i', (_i, row) => {
		const accepted = (entryArities(row.code, row.name) ?? []).some((count) =>
			ACCEPTED[row.name]!.includes(count)
		);
		expect(accepted, JSON.stringify(row.code)).toBe(row.entry_points.includes(row.name));
	});

	it('lists every arity in source order, none for no def, null for unreadable code', () => {
		expect(entryArities('def f(a, b): pass\ndef f(a): pass\nx = 1\ndef f(): pass', 'f')).toEqual([
			2, 1, 0
		]);
		expect(entryArities('x = 1', 'f')).toEqual([]);
		expect(entryArities('def f(a): pass\nx = (1,', 'f')).toBeNull();
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
