import { afterEach, describe, expect, it } from 'vitest';
import {
	INLINE_DEFAULT_H,
	INLINE_MAX_H,
	INLINE_MIN_H,
	SPLIT_DEFAULT_RATIO,
	clampInlineHeight,
	clampSplitRatio,
	loadInlineHeight,
	loadSplitRatio,
	ratioFromPointer,
	saveInlineHeight,
	saveSplitRatio,
	splitHeights
} from '../editor-size';

afterEach(() => localStorage.clear());

describe('clampInlineHeight', () => {
	it('clamps to the bounds and rounds', () => {
		expect(clampInlineHeight(10)).toBe(INLINE_MIN_H);
		expect(clampInlineHeight(9999)).toBe(INLINE_MAX_H);
		expect(clampInlineHeight(240.6)).toBe(241);
	});

	it('falls back to the default for a non-finite value', () => {
		expect(clampInlineHeight(Number.NaN)).toBe(INLINE_DEFAULT_H);
	});
});

describe('clampSplitRatio', () => {
	it('keeps a ratio inside 0.1..0.9 and defaults a non-finite one', () => {
		expect(clampSplitRatio(0.01)).toBeCloseTo(0.1);
		expect(clampSplitRatio(0.99)).toBeCloseTo(0.9);
		expect(clampSplitRatio(0.5)).toBeCloseTo(0.5);
		expect(clampSplitRatio(Number.NaN)).toBeCloseTo(SPLIT_DEFAULT_RATIO);
	});
});

describe('splitHeights', () => {
	it('splits the area left after the divider by the ratio', () => {
		expect(splitHeights({ containerH: 406, ratio: 0.5, dividerH: 6, minPanelH: 80 })).toEqual({
			topH: 200,
			bottomH: 200
		});
	});

	it('never lets either panel drop below the minimum', () => {
		const h = splitHeights({ containerH: 406, ratio: 0.99, dividerH: 6, minPanelH: 80 });
		expect(h.bottomH).toBe(80);
		expect(h.topH).toBe(320);
	});

	it('yields the EDITOR first when the container cannot hold two minimums', () => {
		// The console keeps as much of its minimum as fits; the editor collapses.
		expect(splitHeights({ containerH: 106, ratio: 0.6, dividerH: 6, minPanelH: 80 })).toEqual({
			topH: 20,
			bottomH: 80
		});
	});

	it('is degenerate-safe for a zero-height container', () => {
		expect(splitHeights({ containerH: 0, ratio: 0.6, dividerH: 6, minPanelH: 80 })).toEqual({
			topH: 0,
			bottomH: 0
		});
	});
});

describe('ratioFromPointer', () => {
	it('translates a pointer position into a clamped ratio', () => {
		expect(
			ratioFromPointer({ pointerY: 200, containerH: 406, dividerH: 6, minPanelH: 80 })
		).toBeCloseTo(0.5);
		// dragged past the bottom minimum
		expect(
			ratioFromPointer({ pointerY: 999, containerH: 406, dividerH: 6, minPanelH: 80 })
		).toBeCloseTo(0.8);
		// dragged above the top minimum
		expect(
			ratioFromPointer({ pointerY: -50, containerH: 406, dividerH: 6, minPanelH: 80 })
		).toBeCloseTo(0.2);
	});
});

describe('persistence', () => {
	it('round-trips a clamped inline height', () => {
		saveInlineHeight(300);
		expect(loadInlineHeight()).toBe(300);
		saveInlineHeight(5);
		expect(loadInlineHeight()).toBe(INLINE_MIN_H);
	});

	it('round-trips a split ratio', () => {
		saveSplitRatio(0.42);
		expect(loadSplitRatio()).toBeCloseTo(0.42);
	});

	it('returns the defaults for missing, empty and garbage values', () => {
		expect(loadInlineHeight()).toBe(INLINE_DEFAULT_H);
		localStorage.setItem('ui.snippet.inlineEditorH', '');
		expect(loadInlineHeight()).toBe(INLINE_DEFAULT_H);
		localStorage.setItem('ui.snippet.inlineEditorH', 'not-a-number');
		expect(loadInlineHeight()).toBe(INLINE_DEFAULT_H);
		localStorage.setItem('ui.snippet.tabSplitRatio', 'nope');
		expect(loadSplitRatio()).toBeCloseTo(SPLIT_DEFAULT_RATIO);
	});
});
