import { describe, expect, it } from 'vitest';
import { renderFilenames, sanitizeStem, TakenNames } from '../../src/index.ts';

/**
 * The oracle's loop as written in `render_filenames` and `_dedupe_path`:
 * `base`, then `base_2`, `base_3`, … from 2 every time, against every name
 * taken so far.
 */
function referenceClaim(taken: Set<string>, base: string): string {
	let candidate = base;
	for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
	taken.add(candidate);
	return candidate;
}

/** `render_filenames` with the oracle's loop, for the `${name}` template. */
function referenceFilenames(items: readonly (readonly [string, string])[]): string[] {
	const taken = new Set<string>();
	return items.map(([fallback, name]) =>
		referenceClaim(taken, sanitizeStem(name) || sanitizeStem(fallback) || 'element')
	);
}

/** A deterministic PRNG (mulberry32), so a failing sequence replays. */
function prng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('renderFilenames dedupes as the oracle does', () => {
	it('names mixed bases, literal suffixed names and late arrivals as the loop does', () => {
		const names = [
			'x',
			'x_2',
			'x',
			'x',
			'y',
			'x_3',
			'x',
			'x_2',
			'x_2',
			'y',
			'',
			'',
			'x_5',
			'x',
			'x',
			'y_2',
			'y',
			'x_2_2',
			'x_2'
		];
		const items = names.map((name, i) => [`id${i % 3}`, name] as const);
		const got = renderFilenames('${name}', items);
		expect(got).toEqual(referenceFilenames(items));
		expect(got).toEqual([
			'x',
			'x_2',
			'x_3',
			'x_4',
			'y',
			'x_3_2',
			'x_5',
			'x_2_2',
			'x_2_3',
			'y_2',
			'id1',
			'id2',
			'x_5_2',
			'x_6',
			'x_7',
			'y_2_2',
			'y_3',
			'x_2_2_2',
			'x_2_4'
		]);
	});

	it('matches the loop over random sequences of colliding names', () => {
		const pool = ['x', 'x_2', 'x_3', 'x_4', 'x_2_2', 'y', 'y_2', 'x_10', ''];
		for (let seed = 1; seed <= 200; seed++) {
			const next = prng(seed);
			const items = Array.from({ length: 1 + Math.floor(next() * 60) }, () => {
				const name = pool[Math.floor(next() * pool.length)]!;
				return [next() < 0.5 ? 'x' : 'id', name] as const;
			});
			expect(renderFilenames('${name}', items), `seed ${seed}`).toEqual(referenceFilenames(items));
		}
	});

	it('names 20,000 partitions of one name in well under a second', () => {
		const items = Array.from({ length: 20_000 }, (_, i) => [`e${i}`, 'Same'] as const);
		const start = performance.now();
		const got = renderFilenames('${name}', items);
		const elapsed = performance.now() - start;
		expect(got[0]).toBe('Same');
		expect(got[19_999]).toBe('Same_20000');
		expect(new Set(got).size).toBe(20_000);
		expect(elapsed).toBeLessThan(1000);
	});
});

describe('TakenNames', () => {
	it('claims as the loop does with names added between claims, folder prefixes included', () => {
		const bases = ['a/x', 'a/x_2', 'x', 'b/x', 'a/y', 'a/x_3'];
		for (let seed = 1; seed <= 200; seed++) {
			const next = prng(seed);
			const taken = new TakenNames();
			const reference = new Set<string>();
			for (let i = 0; i < 80; i++) {
				const base = bases[Math.floor(next() * bases.length)]!;
				if (next() < 0.25) {
					// A split entry's own member paths, taken without a claim.
					const literal = next() < 0.5 ? base : `${base}_${2 + Math.floor(next() * 6)}`;
					taken.add(literal);
					reference.add(literal);
					continue;
				}
				expect(taken.claim(base), `seed ${seed}, claim ${i}`).toBe(referenceClaim(reference, base));
			}
			for (const name of reference) expect(taken.has(name)).toBe(true);
		}
	});
});
