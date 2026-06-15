import { describe, expect, it } from 'vitest';
import { panelHeights, clampRatio } from './split';

const BASE = { headerH: 28, dividerH: 4, minPanelH: 60 };

describe('panelHeights', () => {
	it('collapsed: pool shows only its header, tree gets the rest', () => {
		const h = panelHeights({ containerH: 400, ratio: 0.5, collapsed: true, ...BASE });
		expect(h).toEqual({ topH: 372, bottomH: 0 });
	});

	it('expanded 0.5: splits the expandable area evenly', () => {
		// expandable = 428 - 28 - 4 = 396; topH = round(396*0.5) = 198
		const h = panelHeights({ containerH: 428, ratio: 0.5, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 198, bottomH: 198 });
	});

	it('clamps the top panel to the min so the pool keeps minPanelH', () => {
		const h = panelHeights({ containerH: 428, ratio: 0.99, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 336, bottomH: 60 }); // 396 - 60
	});

	it('clamps the top panel up to the min', () => {
		const h = panelHeights({ containerH: 428, ratio: 0.01, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 60, bottomH: 336 });
	});

	it('container too short for two mins: the top panel yields first', () => {
		// expandable = 80 - 28 - 4 = 48 <= minPanelH(60) -> bottomH = 48, topH = 0
		const h = panelHeights({ containerH: 80, ratio: 0.5, collapsed: false, ...BASE });
		expect(h).toEqual({ topH: 0, bottomH: 48 });
	});
});

describe('clampRatio', () => {
	it('maps a mid-container pointer to ~0.5', () => {
		const r = clampRatio({ pointerY: 198, containerH: 428, ...BASE });
		expect(r).toBeCloseTo(0.5, 5);
	});

	it('clamps a near-top pointer to the min-panel ratio', () => {
		const r = clampRatio({ pointerY: 5, containerH: 428, ...BASE });
		expect(r).toBeCloseTo(60 / 396, 5);
	});

	it('clamps a past-bottom pointer to the max-panel ratio', () => {
		const r = clampRatio({ pointerY: 9999, containerH: 428, ...BASE });
		expect(r).toBeCloseTo(336 / 396, 5);
	});
});
