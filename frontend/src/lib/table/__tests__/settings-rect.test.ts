// Geometry for the table settings floating panel: where it opens the first
// time, how a stored/dragged rect is kept on screen, and the localStorage
// round-trip. Pure functions — no DOM, no Svelte.
import { afterEach, describe, expect, it } from 'vitest';

import {
	SETTINGS_MIN_H,
	SETTINGS_MIN_W,
	clampSettingsRect,
	defaultSettingsRect,
	loadSettingsRect,
	saveSettingsRect
} from '../settings-rect';

const VIEWPORT = { w: 1920, h: 1080 };

describe('defaultSettingsRect', () => {
	it('centers over the anchor at 92% × 85% of its size', () => {
		// A workspace column sitting between a 300px sidebar and a 320px inspector.
		const anchor = { x: 300, y: 48, w: 1300, h: 1000 };
		const r = defaultSettingsRect(anchor, VIEWPORT);
		expect(r.w).toBe(Math.round(1300 * 0.92));
		expect(r.h).toBe(Math.round(1000 * 0.85));
		expect(r.x).toBe(Math.round(300 + (1300 - r.w) / 2));
		expect(r.y).toBe(Math.round(48 + (1000 - r.h) / 2));
	});

	it('caps the width at 1280', () => {
		const r = defaultSettingsRect({ x: 0, y: 0, w: 3000, h: 1000 }, { w: 3000, h: 1080 });
		expect(r.w).toBe(1280);
	});

	it('never opens smaller than the minimum size', () => {
		const r = defaultSettingsRect({ x: 0, y: 0, w: 500, h: 300 }, VIEWPORT);
		expect(r.w).toBe(SETTINGS_MIN_W);
		expect(r.h).toBe(SETTINGS_MIN_H);
	});
});

describe('clampSettingsRect', () => {
	it('leaves an on-screen rect untouched', () => {
		const r = { x: 100, y: 100, w: 800, h: 600 };
		expect(clampSettingsRect(r, VIEWPORT)).toEqual(r);
	});

	it('pulls a rect that overflows the right/bottom edges back into view', () => {
		const r = clampSettingsRect({ x: 1500, y: 900, w: 800, h: 600 }, VIEWPORT);
		expect(r).toEqual({ x: 1920 - 800, y: 1080 - 600, w: 800, h: 600 });
	});

	it('pulls a rect dragged past the top/left edges back into view', () => {
		const r = clampSettingsRect({ x: -50, y: -20, w: 800, h: 600 }, VIEWPORT);
		expect(r).toEqual({ x: 0, y: 0, w: 800, h: 600 });
	});

	it('enforces the minimum size and caps the size at the viewport', () => {
		expect(clampSettingsRect({ x: 0, y: 0, w: 10, h: 10 }, VIEWPORT)).toEqual({
			x: 0,
			y: 0,
			w: SETTINGS_MIN_W,
			h: SETTINGS_MIN_H
		});
		expect(clampSettingsRect({ x: 0, y: 0, w: 5000, h: 5000 }, VIEWPORT)).toEqual({
			x: 0,
			y: 0,
			w: 1920,
			h: 1080
		});
	});

	it('on a viewport smaller than the minimum, fills the viewport instead', () => {
		const r = clampSettingsRect({ x: 10, y: 10, w: 800, h: 600 }, { w: 400, h: 300 });
		expect(r).toEqual({ x: 0, y: 0, w: 400, h: 300 });
	});

	it('rounds to whole pixels', () => {
		const r = clampSettingsRect({ x: 10.4, y: 10.6, w: 800.5, h: 600.2 }, VIEWPORT);
		expect(r).toEqual({ x: 10, y: 11, w: 801, h: 600 });
	});
});

describe('settings rect persistence', () => {
	afterEach(() => localStorage.clear());

	it('returns null when nothing is stored', () => {
		expect(loadSettingsRect()).toBeNull();
	});

	it('round-trips a saved rect', () => {
		saveSettingsRect({ x: 12, y: 34, w: 900, h: 700 });
		expect(loadSettingsRect()).toEqual({ x: 12, y: 34, w: 900, h: 700 });
	});

	it('treats a corrupt or partial value as nothing stored', () => {
		localStorage.setItem('ui.table.settingsRect', 'not json');
		expect(loadSettingsRect()).toBeNull();
		localStorage.setItem('ui.table.settingsRect', JSON.stringify({ x: 1, y: 2 }));
		expect(loadSettingsRect()).toBeNull();
		localStorage.setItem('ui.table.settingsRect', JSON.stringify({ x: 1, y: 2, w: 'a', h: 3 }));
		expect(loadSettingsRect()).toBeNull();
	});
});
