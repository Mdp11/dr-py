import { describe, expect, it } from 'vitest';
import {
	computeWindow,
	shouldLoadMore,
	shouldLoadMoreExcluded,
	shouldLoadMoreRoots,
	edgeScrollDelta
} from './windowing';

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
		const w = computeWindow({
			scrollTop: 100000,
			viewportH: 240,
			rowH: 24,
			total: 30,
			overscan: 4
		});
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
		expect(shouldLoadMore({ windowEnd: 95, loadedCount: 100, total: 500, threshold: 10 })).toBe(
			true
		);
	});
	it('is false when everything is already loaded', () => {
		expect(shouldLoadMore({ windowEnd: 95, loadedCount: 100, total: 100, threshold: 10 })).toBe(
			false
		);
	});
	it('is false when the window is far from the end', () => {
		expect(shouldLoadMore({ windowEnd: 40, loadedCount: 100, total: 500, threshold: 10 })).toBe(
			false
		);
	});
});

describe('shouldLoadMoreExcluded', () => {
	// A collapsed "Not in view" section drops its already-fetched rows out of
	// visibleRows, so the short list always reads as "at the bottom" while the
	// server still has more — left ungated this pages the entire pool into memory.
	it('never loads more while the section is collapsed, even at the apparent bottom', () => {
		expect(
			shouldLoadMoreExcluded({
				sectionCollapsed: true,
				windowEnd: 3,
				loadedCount: 3,
				total: 5000,
				threshold: 20
			})
		).toBe(false);
	});

	it('delegates to shouldLoadMore when the section is expanded', () => {
		expect(
			shouldLoadMoreExcluded({
				sectionCollapsed: false,
				windowEnd: 95,
				loadedCount: 100,
				total: 500,
				threshold: 10
			})
		).toBe(true);
		expect(
			shouldLoadMoreExcluded({
				sectionCollapsed: false,
				windowEnd: 40,
				loadedCount: 100,
				total: 500,
				threshold: 10
			})
		).toBe(false);
	});
});

describe('shouldLoadMoreRoots', () => {
	// In view mode the tree renders view folders/artifacts only — raw containment
	// roots are never tree rows (unplaced roots live in the excluded pool). The
	// window-vs-loaded-count math then compares visible ROWS against remaining
	// raw ROOTS: a handful of collapsed folders always reads as "at the bottom",
	// so an ungated check bumps the page limit on every pass and pages the
	// entire root set of a large model into memory with nothing on screen.
	it('never loads more in view mode, even at the apparent bottom', () => {
		expect(
			shouldLoadMoreRoots({
				inViewMode: true,
				windowEnd: 5,
				loadedCount: 5,
				total: 50000,
				threshold: 40
			})
		).toBe(false);
	});

	it('delegates to shouldLoadMore in no-view mode', () => {
		expect(
			shouldLoadMoreRoots({
				inViewMode: false,
				windowEnd: 95,
				loadedCount: 100,
				total: 500,
				threshold: 10
			})
		).toBe(true);
		expect(
			shouldLoadMoreRoots({
				inViewMode: false,
				windowEnd: 40,
				loadedCount: 100,
				total: 500,
				threshold: 10
			})
		).toBe(false);
	});
});

describe('edgeScrollDelta', () => {
	it('is zero in the middle of the viewport', () => {
		expect(edgeScrollDelta({ pointerY: 300, top: 100, bottom: 500, edge: 40, maxSpeed: 24 })).toBe(
			0
		);
	});
	it('is negative (scroll up) near the top edge and scales with proximity', () => {
		const atEdge = edgeScrollDelta({
			pointerY: 100,
			top: 100,
			bottom: 500,
			edge: 40,
			maxSpeed: 24
		});
		expect(atEdge).toBe(-24);
		const partial = edgeScrollDelta({
			pointerY: 120,
			top: 100,
			bottom: 500,
			edge: 40,
			maxSpeed: 24
		});
		expect(partial).toBeLessThan(0);
		expect(partial).toBeGreaterThan(-24);
	});
	it('is positive (scroll down) near the bottom edge', () => {
		expect(edgeScrollDelta({ pointerY: 500, top: 100, bottom: 500, edge: 40, maxSpeed: 24 })).toBe(
			24
		);
	});
});
