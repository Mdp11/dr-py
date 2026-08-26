/**
 * Geometry for the table settings floating panel (`TableView`'s non-modal
 * settings dialog): its first-open placement, on-screen clamping for a rect
 * that was dragged, resized or restored, and the `localStorage` round-trip.
 *
 * Pure functions plus storage, no Svelte and no component DOM, so the
 * clamping is unit-testable — the same split as `editor/editor-size.ts`.
 * Storage access is try/catch-wrapped rather than gated on `$app/environment`
 * (the vitest alias stubs `browser` to `false`; see that module's header).
 *
 * The rect is ONE global preference, not per table: the panel is the same
 * working surface wherever it opens, and a user who parked it beside the
 * inspector wants it there for the next table too.
 */

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Size {
	w: number;
	h: number;
}

/** A settings panel narrower than this cannot show a column card and the
 * row-source editor side by side without wrapping every control. */
export const SETTINGS_MIN_W = 640;
export const SETTINGS_MIN_H = 400;
/** First-open width cap: past this the editor's own content stops growing. */
const DEFAULT_MAX_W = 1280;

const LS_RECT = 'ui.table.settingsRect';

/** Keep `rect` fully on screen: size between the minimum and the viewport
 * (the viewport wins when it is smaller than the minimum — a panel that
 * cannot be dragged back into reach is worse than a cramped one), position
 * such that no edge overflows. Rounded to whole pixels. */
export function clampSettingsRect(rect: Rect, viewport: Size): Rect {
	const w = Math.round(Math.min(viewport.w, Math.max(SETTINGS_MIN_W, rect.w)));
	const h = Math.round(Math.min(viewport.h, Math.max(SETTINGS_MIN_H, rect.h)));
	const x = Math.round(Math.min(Math.max(0, rect.x), viewport.w - w));
	const y = Math.round(Math.min(Math.max(0, rect.y), viewport.h - h));
	return { x, y, w, h };
}

/** First-open placement: centered over `anchor` (the table tab's own area,
 * so the sidebar and inspector beside it stay uncovered) at most of its size,
 * then clamped like any other rect. */
export function defaultSettingsRect(anchor: Rect, viewport: Size): Rect {
	const w = Math.min(DEFAULT_MAX_W, Math.round(anchor.w * 0.92));
	const h = Math.round(anchor.h * 0.85);
	return clampSettingsRect(
		{ x: anchor.x + (anchor.w - w) / 2, y: anchor.y + (anchor.h - h) / 2, w, h },
		viewport
	);
}

function isRect(v: unknown): v is Rect {
	if (typeof v !== 'object' || v === null) return false;
	const r = v as Record<string, unknown>;
	return (['x', 'y', 'w', 'h'] as const).every(
		(k) => typeof r[k] === 'number' && Number.isFinite(r[k])
	);
}

/** The stored rect, UNCLAMPED (the caller clamps against the live viewport);
 * null when nothing usable is stored. */
export function loadSettingsRect(): Rect | null {
	try {
		const raw = localStorage.getItem(LS_RECT);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		return isRect(parsed) ? { x: parsed.x, y: parsed.y, w: parsed.w, h: parsed.h } : null;
	} catch {
		return null;
	}
}

export function saveSettingsRect(rect: Rect): void {
	try {
		localStorage.setItem(LS_RECT, JSON.stringify(rect));
	} catch {
		/* storage full/denied: the placement simply doesn't persist */
	}
}
