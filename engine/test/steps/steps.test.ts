import { describe, expect, it } from 'vitest';
import { drain, sortedInSlices, type Progress, type Steps } from '../../src/index.ts';
import { seededRandom } from '../golden/model-steps.ts';

type Item = { key: number; at: number };

const byKey = (a: Item, b: Item) => a.key - b.key;

function items(length: number, keys: number, seed: number): Item[] {
	const random = seededRandom(seed);
	return Array.from({ length }, (_, at) => ({ key: Math.floor(random() * keys), at }));
}

/** Every progress report, and the value. */
function run<T>(steps: Steps<T>): { reports: Progress[]; value: T } {
	const reports: Progress[] = [];
	for (;;) {
		const next = steps.next();
		if (next.done === true) return { reports, value: next.value };
		reports.push(next.value);
	}
}

describe('drain', () => {
	it('runs every step and returns the value', () => {
		const seen: number[] = [];
		function* counting(): Steps<string> {
			for (let i = 1; i <= 3; i++) {
				seen.push(i);
				yield { done: i, total: 3 };
			}
			return 'end';
		}
		expect(drain(counting())).toBe('end');
		expect(seen).toEqual([1, 2, 3]);
	});
});

describe('sortedInSlices', () => {
	const RUN = 8;

	it.each([0, 1, RUN - 1, RUN, RUN + 1, 10 * RUN + 7])(
		'sorts %i items as the native sort does',
		(length) => {
			const input = items(length, 1_000_000, length + 1);
			const expected = [...input].sort(byKey);
			expect(drain(sortedInSlices(input, byKey, RUN))).toEqual(expected);
		}
	);

	it('sorts 5,000 items with the default run', () => {
		const input = items(5000, 1_000_000, 7);
		const expected = [...input].sort(byKey);
		expect(drain(sortedInSlices(input, byKey))).toEqual(expected);
	});

	it('keeps equal keys in input order', () => {
		for (const length of [RUN + 1, 10 * RUN + 7, 5000]) {
			const input = items(length, 5, length);
			const sorted = drain(sortedInSlices(input, byKey, RUN));
			expect(sorted).toEqual([...input].sort((a, b) => a.key - b.key || a.at - b.at));
		}
	});

	it('bounds the work of every step', () => {
		const length = 10 * RUN + 7;
		let calls = 0;
		let touched = new Set<Item>();
		const counting = (a: Item, b: Item) => {
			calls++;
			touched.add(a);
			touched.add(b);
			return byKey(a, b);
		};
		const steps = sortedInSlices(items(length, 1000, 3), counting, RUN);
		const runSteps = Math.ceil(length / RUN);
		let step = 0;
		for (let next = steps.next(); next.done !== true; next = steps.next()) {
			if (step < runSteps) expect(touched.size).toBeLessThanOrEqual(RUN);
			else expect(calls).toBeLessThanOrEqual(RUN);
			step++;
			calls = 0;
			touched = new Set();
		}
	});

	it('reports progress that never decreases and ends at its total', () => {
		for (const length of [1, RUN, RUN + 1, 10 * RUN + 7]) {
			const { reports } = run(sortedInSlices(items(length, 100, 5), byKey, RUN));
			const total = reports[0]!.total;
			for (let i = 1; i < reports.length; i++) {
				expect(reports[i]!.done).toBeGreaterThanOrEqual(reports[i - 1]!.done);
				expect(reports[i]!.total).toBe(total);
			}
			expect(reports.at(-1)).toEqual({ done: total, total });
		}
	});
});
