// The snippet tab's editor/console divider. The tab itself needs a snippet
// draft from the store to render anything, so this test drives the split
// through the same pure helpers the component uses and asserts the composition
// with the persisted store — the geometry itself is covered exhaustively in
// editor/__tests__/editor-size.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	SPLIT_DIVIDER_H,
	SPLIT_MIN_PANEL_H,
	ratioFromPointer,
	splitHeights
} from '$lib/editor/editor-size';
import { getSnippetSplitRatio, resetEditorSize, setSnippetSplitRatio } from '$lib/state';

beforeEach(() => {
	localStorage.clear();
	resetEditorSize();
});
afterEach(() => localStorage.clear());

describe('snippet tab split', () => {
	it('a divider drag to 40% of the body gives the editor 40%', () => {
		const containerH = 500;
		const ratio = ratioFromPointer({
			pointerY: 200,
			containerH,
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		});
		setSnippetSplitRatio(ratio);
		const h = splitHeights({
			containerH,
			ratio: getSnippetSplitRatio(),
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		});
		expect(h.topH).toBe(200);
		expect(h.bottomH).toBe(294);
	});

	it('the console keeps its minimum when the divider is dragged to the bottom', () => {
		const containerH = 500;
		setSnippetSplitRatio(
			ratioFromPointer({
				pointerY: 9999,
				containerH,
				dividerH: SPLIT_DIVIDER_H,
				minPanelH: SPLIT_MIN_PANEL_H
			})
		);
		const h = splitHeights({
			containerH,
			ratio: getSnippetSplitRatio(),
			dividerH: SPLIT_DIVIDER_H,
			minPanelH: SPLIT_MIN_PANEL_H
		});
		expect(h.bottomH).toBe(SPLIT_MIN_PANEL_H);
	});

	it('persists the ratio across a store reload', () => {
		setSnippetSplitRatio(0.35);
		resetEditorSize();
		expect(getSnippetSplitRatio()).toBeCloseTo(0.35);
	});
});
