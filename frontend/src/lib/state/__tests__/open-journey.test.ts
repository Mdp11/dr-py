import { describe, expect, it } from 'vitest';
import {
	SPLINES,
	splineAt,
	cycleAt,
	shuffled,
	easeToward,
	clampMonotonic,
	phaseSlice,
	statusToProgress,
	setSplineRandom
} from '../open-journey';

describe('open-journey pure helpers', () => {
	it('has 19 verbatim splines, first is the arrow line', () => {
		expect(SPLINES).toHaveLength(19);
		expect(SPLINES[0]).toBe('Asking every arrow where it thinks it’s going…');
		expect(SPLINES[18]).toBe('Walking the navigation chain so you don’t have to…');
	});

	it('splineAt wraps and never returns undefined, including negatives', () => {
		expect(splineAt(0)).toBe(SPLINES[0]);
		expect(splineAt(19)).toBe(SPLINES[0]);
		expect(splineAt(20)).toBe(SPLINES[1]);
		expect(splineAt(-1)).toBe(SPLINES[18]);
	});

	it('cycleAt wraps over any list, tolerating negatives', () => {
		const list = ['a', 'b', 'c'];
		expect(cycleAt(list, 0)).toBe('a');
		expect(cycleAt(list, 3)).toBe('a');
		expect(cycleAt(list, 4)).toBe('b');
		expect(cycleAt(list, -1)).toBe('c');
	});

	// THE property the whole RNG seam rests on: the forward Fisher-Yates
	// variant degenerates to identity at rand()===0, which is what lets the
	// journey tests below keep their verbatim SPLINES[0]/SPLINES[1]
	// expectations. The conventional backward variant does NOT have this
	// property (it swaps out[i] with out[0]), so this test is load-bearing.
	it('shuffled with a zero rand is the identity permutation', () => {
		expect(shuffled(SPLINES, () => 0)).toEqual([...SPLINES]);
	});

	it('shuffled returns a permutation and never mutates the input', () => {
		const before = [...SPLINES];
		let n = 0;
		const out = shuffled(SPLINES, () => ((n = (n * 9301 + 49297) % 233280), n / 233280));
		expect(out).toHaveLength(SPLINES.length);
		expect([...out].sort()).toEqual([...SPLINES].sort());
		expect(SPLINES).toEqual(before);
	});

	// Math.random never returns exactly 1, but setSplineRandom is a public
	// seam, so a stub that does must not produce an out-of-range index.
	it('shuffled clamps a rand that returns 1', () => {
		const out = shuffled(SPLINES, () => 1);
		expect(out).toHaveLength(SPLINES.length);
		expect(out.every((s) => typeof s === 'string')).toBe(true);
		expect([...out].sort()).toEqual([...SPLINES].sort());
	});

	it('easeToward approaches ceil asymptotically and never exceeds it', () => {
		expect(easeToward(0, 72, 0, 1200)).toBe(0);
		const mid = easeToward(0, 72, 1200, 1200);
		expect(mid).toBeGreaterThan(0);
		expect(mid).toBeLessThan(72);
		expect(easeToward(0, 72, 100000, 1200)).toBeLessThanOrEqual(72);
	});

	it('clampMonotonic never decreases and caps at 100', () => {
		expect(clampMonotonic(40, 30)).toBe(40);
		expect(clampMonotonic(20, 30)).toBe(30);
		expect(clampMonotonic(150, 30)).toBe(100);
	});

	it('phaseSlice returns the approved budgets', () => {
		expect(phaseSlice('create', 'upload')).toEqual([0, 30]);
		expect(phaseSlice('create', 'hydrate')).toEqual([42, 80]);
		expect(phaseSlice('create', 'finalize')).toEqual([96, 100]);
		expect(phaseSlice('open', 'hydrate')).toEqual([0, 72]);
		expect(phaseSlice('open', 'validate')).toEqual([72, 95]);
		expect(phaseSlice('open', 'finalize')).toEqual([95, 100]);
	});

	it('statusToProgress maps every backend state', () => {
		expect(
			statusToProgress({ state: 'validating', validation: { running: true, done: 5, total: 10 } })
		).toEqual({ phase: 'validate', fraction: 0.5 });
		expect(
			statusToProgress({ state: 'hydrating', hydration: { phase: 'build', done: 3, total: 4 } })
		).toEqual({ phase: 'hydrate', fraction: 0.75 });
		expect(
			statusToProgress({ state: 'hydrating', hydration: { phase: 'download', done: 0, total: 0 } })
		).toEqual({ phase: 'hydrate', fraction: null });
		expect(statusToProgress({ state: 'ready', model_rev: 1 })).toEqual({
			phase: 'ready',
			fraction: 1
		});
		expect(statusToProgress({ state: 'empty' })).toEqual({ phase: 'ready', fraction: 1 });
		expect(statusToProgress({ state: 'cold' })).toEqual({ phase: 'cold', fraction: null });
	});
});

import { afterEach, beforeEach, vi } from 'vitest';
import {
	beginJourney,
	journeyUpload,
	journeyStatus,
	finishJourney,
	cancelJourney,
	resetJourney
} from '../open-journey';
import { getActiveProgress, resetProgress } from '../progress.svelte';

describe('open-journey controller', () => {
	beforeEach(() => {
		// Identity permutation — see `shuffled`'s docstring. Keeps every
		// SPLINES[n] expectation in this block literally true.
		setSplineRandom(() => 0);
		vi.useFakeTimers();
		resetProgress();
		resetJourney();
	});
	afterEach(() => {
		resetJourney();
		resetProgress();
		vi.useRealTimers();
	});

	const pct = () => getActiveProgress()?.done ?? null;

	it('starts one entry showing the first spline at 0%', () => {
		beginJourney('open');
		const e = getActiveProgress();
		expect(e).not.toBeNull();
		expect(e?.label).toBe(SPLINES[0]);
		expect(e?.done).toBe(0);
		expect(e?.total).toBe(100);
	});

	it('beginJourney is idempotent — no second entry, kind is preserved', () => {
		beginJourney('create');
		journeyUpload(50, 100); // create-only signal takes effect
		beginJourney('open'); // must no-op (kind stays create)
		journeyUpload(100, 100); // still honored → proves kind is still create
		vi.advanceTimersByTime(80 * 40); // the bar eases toward the new phase floor
		// create/upload slice is [0,30]; 100% bytes → phase advances to create[30,42]
		expect(pct()).toBeGreaterThanOrEqual(30);
	});

	it('open journey creeps in the hydrate slice and never exceeds its ceil', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80 * 200); // long creep
		const p = pct()!;
		expect(p).toBeGreaterThan(0);
		expect(p).toBeLessThanOrEqual(72);
	});

	it('is monotonic across a full open sequence and finishes at 100', () => {
		beginJourney('open');
		const seen: number[] = [];
		const step = () => {
			vi.advanceTimersByTime(80);
			seen.push(pct()!);
		};
		journeyStatus({ state: 'hydrating', hydration: { phase: 'build', done: 1, total: 4 } });
		step();
		journeyStatus({ state: 'validating', validation: { running: true, done: 2, total: 10 } });
		step();
		journeyStatus({ state: 'ready', model_rev: 1 });
		step();
		finishJourney();
		vi.advanceTimersByTime(80 * 20); // past MIN_VISIBLE + fill to 100
		// monotonic non-decrease
		for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
		// teardown after finish
		expect(getActiveProgress()).toBeNull();
	});

	it('keeps moving when a real fraction lands below the creep (no mid-open freeze)', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80 * 20); // creep runs ahead of the server
		const crept = pct()!;
		expect(crept).toBeGreaterThan(0);
		// server reports it has barely started — the old mapping froze here
		journeyStatus({ state: 'hydrating', hydration: { phase: 'build', done: 1, total: 100 } });
		vi.advanceTimersByTime(80 * 10);
		const afterFirst = pct()!;
		expect(afterFirst).toBeGreaterThan(crept);
		journeyStatus({ state: 'hydrating', hydration: { phase: 'build', done: 20, total: 100 } });
		vi.advanceTimersByTime(80 * 10);
		expect(pct()!).toBeGreaterThan(afterFirst);
	});

	it('eases into a jump instead of teleporting (ready → validate ceil)', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80 * 5);
		const before = pct()!;
		journeyStatus({ state: 'ready', model_rev: 1 });
		vi.advanceTimersByTime(80); // a single tick must not land on the ceil
		expect(pct()!).toBeLessThan(72);
		expect(pct()!).toBeGreaterThan(before);
		vi.advanceTimersByTime(80 * 40);
		expect(pct()!).toBeGreaterThan(90); // but it does get there
	});

	it('rotates the spline label on the spline ticker', () => {
		beginJourney('open');
		expect(getActiveProgress()?.label).toBe(SPLINES[0]);
		vi.advanceTimersByTime(3000);
		expect(getActiveProgress()?.label).toBe(SPLINES[0]); // still on the first line
		vi.advanceTimersByTime(1200); // 4200ms total: one spline period
		expect(getActiveProgress()?.label).toBe(SPLINES[1]);
	});

	it('walks all 19 distinct lines before repeating any', () => {
		// A rotating rand: each draw picks the LAST candidate in the remaining
		// window, so the order is a real permutation, not the identity.
		setSplineRandom(() => 0.999);
		beginJourney('open');
		const seen = [getActiveProgress()?.label];
		for (let i = 1; i < SPLINES.length; i++) {
			vi.advanceTimersByTime(4200);
			seen.push(getActiveProgress()?.label);
		}
		expect(new Set(seen).size).toBe(SPLINES.length);
		expect([...seen].sort()).toEqual([...SPLINES].sort());
		// The set/length checks above pass even for the UNSHUFFLED authored
		// order, so on their own they don't prove `beginJourney` shuffles at
		// all. Under this test's rand = () => 0.999, the forward Fisher-Yates
		// places SPLINES[18] at index 0 — pin that the walked order is not
		// simply the authored one.
		expect(seen).not.toEqual([...SPLINES]);
	});

	it('re-shuffles on wrap instead of replaying the same permutation', () => {
		// A continuously ADVANCING rand: the second shuffle must draw from a
		// different part of the sequence than the first. A short repeating
		// pattern would not do — `shuffled` draws exactly n-1 (18) times per
		// shuffle, so any period dividing 18 hands the second shuffle the same
		// numbers and the same permutation, testing nothing.
		let seed = 1;
		setSplineRandom(() => ((seed = (seed * 9301 + 49297) % 233280), seed / 233280));
		beginJourney('open');
		const first: (string | undefined)[] = [getActiveProgress()?.label];
		for (let i = 1; i < SPLINES.length; i++) {
			vi.advanceTimersByTime(4200);
			first.push(getActiveProgress()?.label);
		}
		// Tick 19 wraps: a fresh shuffle must be in effect.
		const second: (string | undefined)[] = [];
		for (let i = 0; i < SPLINES.length; i++) {
			vi.advanceTimersByTime(4200);
			second.push(getActiveProgress()?.label);
		}
		expect(second).not.toEqual(first);
		expect([...second].sort()).toEqual([...SPLINES].sort());
	});

	it('finishJourney holds the entry for the minimum visible duration', () => {
		beginJourney('open');
		finishJourney();
		vi.advanceTimersByTime(240); // < MIN_VISIBLE_MS (600)
		expect(getActiveProgress()).not.toBeNull();
		vi.advanceTimersByTime(600); // now past the floor
		expect(getActiveProgress()).toBeNull();
	});

	it('cancelJourney tears down immediately with no hold', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80);
		cancelJourney();
		expect(getActiveProgress()).toBeNull();
	});

	it('journeyStatus/journeyUpload are no-ops when inactive', () => {
		journeyStatus({ state: 'ready', model_rev: 1 });
		journeyUpload(1, 2);
		expect(getActiveProgress()).toBeNull();
	});

	it('ignores a late status poll after finishJourney so the bar still tears down (no strand at 95%)', () => {
		beginJourney('open');
		journeyStatus({ state: 'validating', validation: { running: true, done: 5, total: 10 } });
		vi.advanceTimersByTime(80 * 10); // past MIN_VISIBLE
		finishJourney();
		// a stray poll that resolved in-flight AFTER finishJourney (the bug trigger)
		journeyStatus({ state: 'validating', validation: { running: true, done: 9, total: 10 } });
		vi.advanceTimersByTime(80 * 40); // let the ticker run to teardown
		expect(getActiveProgress()).toBeNull(); // was stuck at {done:95} before the guard
	});
});
