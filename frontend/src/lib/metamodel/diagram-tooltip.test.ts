import { describe, expect, it } from 'vitest';

import {
	LOD_TOOLTIP_GAP,
	LOD_TOOLTIP_MAX_H,
	LOD_TOOLTIP_MAX_W,
	lodTooltipAnchor,
	tooltipStyle
} from './diagram-tooltip';

const VIEWPORT = { width: 1000, height: 800 };

describe('lodTooltipAnchor', () => {
	it('trails the cursor down-right when there is room', () => {
		expect(lodTooltipAnchor({ x: 100, y: 200 }, VIEWPORT)).toEqual({
			left: 100 + LOD_TOOLTIP_GAP,
			right: null,
			top: 200 + LOD_TOOLTIP_GAP,
			bottom: null
		});
	});

	it('flips to the left of the cursor near the right edge', () => {
		// The form panel and the collapsed rail live here, so this is the case
		// the flip exists for.
		const x = VIEWPORT.width - LOD_TOOLTIP_MAX_W;
		const a = lodTooltipAnchor({ x, y: 200 }, VIEWPORT);
		expect(a.left).toBeNull();
		// Anchored by its trailing edge: GAP px to the LEFT of the cursor,
		// whatever the tooltip's own width turns out to be.
		expect(a.right).toBe(VIEWPORT.width - x + LOD_TOOLTIP_GAP);
		expect(a.top).toBe(212);
	});

	it('flips above the cursor near the bottom edge, independently of x', () => {
		const y = VIEWPORT.height - LOD_TOOLTIP_MAX_H;
		const a = lodTooltipAnchor({ x: 100, y }, VIEWPORT);
		expect(a.top).toBeNull();
		expect(a.bottom).toBe(VIEWPORT.height - y + LOD_TOOLTIP_GAP);
		expect(a.left).toBe(112);
	});

	it('flips both axes in the bottom-right corner', () => {
		const a = lodTooltipAnchor({ x: 995, y: 795 }, VIEWPORT);
		expect(a.left).toBeNull();
		expect(a.top).toBeNull();
		expect(a.right).toBe(17);
		expect(a.bottom).toBe(17);
	});

	it('never anchors outside the viewport when the cursor is past its edge', () => {
		// A pointer event can report a coordinate beyond the window (a drag that
		// left it); a negative offset would push the tooltip off the far side.
		const a = lodTooltipAnchor({ x: 2000, y: 2000 }, VIEWPORT);
		expect(a.right).toBe(0);
		expect(a.bottom).toBe(0);
	});

	it('does not flip while the whole worst-case box still fits', () => {
		const a = lodTooltipAnchor(
			{ x: VIEWPORT.width - LOD_TOOLTIP_MAX_W - LOD_TOOLTIP_GAP, y: 10 },
			VIEWPORT
		);
		expect(a.left).not.toBeNull();
		expect(a.right).toBeNull();
	});
});

describe('tooltipStyle', () => {
	it('emits only the anchored sides', () => {
		expect(tooltipStyle({ left: 12, right: null, top: 24, bottom: null })).toBe(
			'left: 12px; top: 24px;'
		);
		expect(tooltipStyle({ left: null, right: 5, top: null, bottom: 7 })).toBe(
			'right: 5px; bottom: 7px;'
		);
	});
});
