import { describe, expect, it } from 'vitest';
import {
	SPLINES,
	splineAt,
	cycleAt,
	shuffled,
	easeToward,
	clampMonotonic,
	phaseSlice,
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
		expect(phaseSlice('create', 'upload')).toEqual([0, 22]);
		expect(phaseSlice('create', 'hydrate')).toEqual([32, 52]);
		expect(phaseSlice('create', 'finalize')).toEqual([97, 100]);
		expect(phaseSlice('open', 'hydrate')).toEqual([0, 34]);
		expect(phaseSlice('open', 'download')).toEqual([34, 43]);
		expect(phaseSlice('open', 'finalize')).toEqual([96, 100]);
	});
});

import { afterEach, beforeEach, vi } from 'vitest';
import {
	beginJourney,
	journeyUpload,
	journeyReplica,
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
		// create/upload slice is [0,22]; 100% bytes → phase advances to create[22,32]
		expect(pct()).toBeGreaterThanOrEqual(22);
	});

	it('open journey creeps in the hydrate slice and never exceeds its ceil', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80 * 200); // long creep
		const p = pct()!;
		expect(p).toBeGreaterThan(0);
		expect(p).toBeLessThanOrEqual(34);
	});

	it('is monotonic across a full open sequence and finishes at 100', () => {
		beginJourney('open');
		const seen: number[] = [];
		const step = () => {
			vi.advanceTimersByTime(80);
			seen.push(pct()!);
		};
		journeyReplica({ task: 'download', done: 1, total: 4 });
		step();
		journeyReplica({ task: 'parse', done: 2, total: 10 });
		step();
		journeyReplica({ task: 'index', done: 1, total: 1 });
		step();
		journeyReplica({ task: 'tail', done: 1, total: 1 });
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
		// the replica reports it has barely started — the old mapping froze here
		journeyReplica({ task: 'parse', done: 1, total: 100 });
		vi.advanceTimersByTime(80 * 10);
		const afterFirst = pct()!;
		expect(afterFirst).toBeGreaterThan(crept);
		journeyReplica({ task: 'parse', done: 20, total: 100 });
		vi.advanceTimersByTime(80 * 10);
		expect(pct()!).toBeGreaterThan(afterFirst);
	});

	it('eases into a jump instead of teleporting (hydrate → tail)', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80 * 5);
		const before = pct()!;
		journeyReplica({ task: 'tail', done: 1, total: 1 });
		vi.advanceTimersByTime(80); // a single tick must not land on the ceil
		expect(pct()!).toBeLessThan(95);
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

	it('journeyReplica/journeyUpload are no-ops when inactive', () => {
		journeyReplica({ task: 'download', done: 1, total: 2 });
		journeyUpload(1, 2);
		expect(getActiveProgress()).toBeNull();
	});

	it('ignores a late report after finishJourney so the bar still tears down (no strand at 95%)', () => {
		beginJourney('open');
		journeyReplica({ task: 'index', done: 5, total: 10 });
		vi.advanceTimersByTime(80 * 10); // past MIN_VISIBLE
		finishJourney();
		// a stray report that arrived AFTER finishJourney (the bug trigger)
		journeyReplica({ task: 'index', done: 9, total: 10 });
		vi.advanceTimersByTime(80 * 40); // let the ticker run to teardown
		expect(getActiveProgress()).toBeNull(); // was stuck at {done:95} before the guard
	});
});

describe('open-journey replica phases', () => {
	beforeEach(() => {
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

	it('hydrate fills 0-34', () => {
		beginJourney('open');
		vi.advanceTimersByTime(80 * 300); // long creep
		const p = pct()!;
		expect(p).toBeGreaterThan(0);
		expect(p).toBeLessThanOrEqual(34);
	});

	it('a download report puts the target inside its own (tuned) slice, past hydrate', () => {
		const [downloadFloor, downloadCeil] = phaseSlice('open', 'download');
		beginJourney('open');
		vi.advanceTimersByTime(80 * 50); // creep partway through hydrate
		journeyReplica({ task: 'download', done: 1, total: 2 });
		vi.advanceTimersByTime(80 * 50);
		const p = pct()!;
		expect(p).toBeGreaterThan(downloadFloor); // past download's own floor
		expect(p).toBeLessThanOrEqual(downloadCeil);
	});

	it('parse supersedes download; a later, higher-done download report is ignored — phase stays parse, percent never drops', () => {
		const [, downloadCeil] = phaseSlice('open', 'download');
		const [, parseCeil] = phaseSlice('open', 'parse');
		beginJourney('open');
		journeyReplica({ task: 'download', done: 1, total: 4 });
		vi.advanceTimersByTime(80 * 50);
		const afterDownload = pct()!;
		journeyReplica({ task: 'parse', done: 1, total: 4 });
		vi.advanceTimersByTime(80 * 50);
		const afterParse = pct()!;
		expect(afterParse).toBeGreaterThan(afterDownload);
		// A late download report, even with a higher `done` than parse's own —
		// forward-only drops it whole.
		journeyReplica({ task: 'download', done: 4, total: 4 });
		expect(pct()).toBe(afterParse); // no tick elapsed yet: nothing moved at all
		vi.advanceTimersByTime(80 * 400); // long creep, well past download's own ceiling
		const p = pct()!;
		expect(p).toBeGreaterThan(afterParse); // never dropped
		expect(p).toBeGreaterThan(downloadCeil); // proves the phase stayed 'parse', not 'download'
		expect(p).toBeLessThanOrEqual(parseCeil);
	});

	it('a same-phase report still updates the fraction under the forward-only guard (parse advancing)', () => {
		beginJourney('open');
		journeyReplica({ task: 'parse', done: 1, total: 4 });
		vi.advanceTimersByTime(80 * 40);
		const first = pct()!;
		journeyReplica({ task: 'parse', done: 3, total: 4 }); // same phase, higher fraction
		vi.advanceTimersByTime(80 * 40);
		const second = pct()!;
		expect(second).toBeGreaterThan(first);
	});

	it('verify, sweep and scripts are ignored outright', () => {
		beginJourney('open');
		journeyReplica({ task: 'download', done: 1, total: 2 });
		vi.advanceTimersByTime(80 * 30);
		const before = pct()!;
		journeyReplica({ task: 'verify', done: 1, total: 1 });
		journeyReplica({ task: 'sweep', done: 1, total: 1 });
		journeyReplica({ task: 'scripts', done: 1, total: 1 });
		expect(pct()).toBe(before); // no tick yet: they touched nothing at all
		vi.advanceTimersByTime(80 * 30);
		const [, downloadCeil] = phaseSlice('open', 'download');
		expect(pct()!).toBeLessThanOrEqual(downloadCeil); // still in download's own slice, not pushed anywhere
	});

	it('total: null creeps inside its own slice', () => {
		const [floor, ceil] = phaseSlice('open', 'index');
		beginJourney('open');
		journeyReplica({ task: 'index', done: 0, total: null });
		vi.advanceTimersByTime(80 * 400); // long creep
		const p = pct()!;
		expect(p).toBeGreaterThan(floor);
		expect(p).toBeLessThanOrEqual(ceil);
	});

	it('finishJourney ramps to 100 from wherever the replica phase left it', () => {
		beginJourney('open');
		journeyReplica({ task: 'tail', done: 1, total: 1 });
		vi.advanceTimersByTime(80 * 5);
		finishJourney();
		vi.advanceTimersByTime(80 * 20); // past MIN_VISIBLE + fill to 100
		expect(getActiveProgress()).toBeNull();
	});

	it('journeyReplica without a journey is a no-op', () => {
		journeyReplica({ task: 'download', done: 1, total: 2 });
		expect(getActiveProgress()).toBeNull();
	});
});
