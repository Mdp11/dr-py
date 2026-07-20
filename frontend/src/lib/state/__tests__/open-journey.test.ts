import { describe, expect, it } from 'vitest';
import {
	SPLINES,
	splineAt,
	easeToward,
	clampMonotonic,
	phaseSlice,
	statusToProgress
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
