import { describe, expect, it } from 'vitest';
import { computeWindow, shouldLoadMore, edgeScrollDelta } from './windowing';

describe('computeWindow', () => {
	it('returns the first slice at scrollTop 0 with overscan', () => {
		const w = computeWindow({ scrollTop: 0, viewportH: 240, rowH: 24, total: 100, overscan: 4 });
		expect(w.start).toBe(0);
		expect(w.end).toBe(14);
		expect(w.padTop).toBe(0);
		expect(w.padBottom).toBe((100 - 14) * 24);
	});

	it('offsets start by floor(scrollTop/rowH) minus overscan, clamped at 0', () => {
		const w = computeWindow({ scrollTop: 240, viewportH: 240, rowH: 24, total: 100, overscan: 4 });
		expect(w.start).toBe(6);
		expect(w.padTop).toBe(6 * 24);
		expect(w.end).toBe(Math.min(100, 6 + Math.ceil(240 / 24) + 4 * 2));
		expect(w.end).toBe(24);
	});

	it('clamps end to total and never produces negative padding', () => {
		const w = computeWindow({ scrollTop: 100000, viewportH: 240, rowH: 24, total: 30, overscan: 4 });
		expect(w.end).toBe(30);
		expect(w.padBottom).toBe(0);
		expect(w.start).toBeLessThanOrEqual(30);
		expect(w.padTop).toBe(w.start * 24);
	});

	it('handles an empty list', () => {
		const w = computeWindow({ scrollTop: 0, viewportH: 240, rowH: 24, total: 0, overscan: 4 });
		expect(w).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
	});
});

describe('shouldLoadMore', () => {
	it('is true when the window approaches the loaded count and more remain', () => {
		expect(shouldLoadMore({ windowEnd: 95, loadedCount: 100, total: 500, threshold: 10 })).toBe(true);
	});
	it('is false when everything is already loaded', () => {
		expect(shouldLoadMore({ windowEnd: 95, loadedCount: 100, total: 100, threshold: 10 })).toBe(false);
	});
	it('is false when the window is far from the end', () => {
		expect(shouldLoadMore({ windowEnd: 40, loadedCount: 100, total: 500, threshold: 10 })).toBe(false);
	});
});

describe('edgeScrollDelta', () => {
	it('is zero in the middle of the viewport', () => {
		expect(edgeScrollDelta({ pointerY: 300, top: 100, bottom: 500, edge: 40, maxSpeed: 24 })).toBe(0);
	});
	it('is negative (scroll up) near the top edge and scales with proximity', () => {
		const atEdge = edgeScrollDelta({ pointerY: 100, top: 100, bottom: 500, edge: 40, maxSpeed: 24 });
		expect(atEdge).toBe(-24);
		const partial = edgeScrollDelta({ pointerY: 120, top: 100, bottom: 500, edge: 40, maxSpeed: 24 });
		expect(partial).toBeLessThan(0);
		expect(partial).toBeGreaterThan(-24);
	});
	it('is positive (scroll down) near the bottom edge', () => {
		expect(edgeScrollDelta({ pointerY: 500, top: 100, bottom: 500, edge: 40, maxSpeed: 24 })).toBe(24);
	});
});
