/**
 * Size geometry for the snippet code editor: the inline editors' pixel height
 * and the standalone tab's editor/console split ratio.
 *
 * Pure functions plus `localStorage` read/write, no Svelte and no component
 * DOM, so the clamping can be unit-tested without a browser — mirrors
 * `components/Sidebar/split.ts`, which does the same job for the sidebar's
 * tree/pool divider.
 *
 * Storage access is wrapped in try/catch rather than gated on
 * `$app/environment`'s `browser`: the vitest alias stubs `browser` to `false`,
 * so a guard would make every persistence test read the default instead of
 * what it just wrote. `state/workspace.svelte.ts` sets the same precedent.
 */

/** Inline editor (table script column, navigation script step) bounds, px.
 * The default is 192 — exactly the `h-48` these editors shipped with, so the
 * first render after this change is pixel-identical to the last one before. */
export const INLINE_MIN_H = 96;
export const INLINE_MAX_H = 800;
export const INLINE_DEFAULT_H = 192;

/** Standalone snippet tab: minimum height for EITHER of the editor/console
 * panes, the divider strip's thickness, and the initial share given to the
 * editor (0.6 ≈ the `flex-[3]`/`flex-[2]` pair it replaces). */
export const SPLIT_MIN_PANEL_H = 80;
export const SPLIT_DIVIDER_H = 6;
export const SPLIT_DEFAULT_RATIO = 0.6;

const LS_INLINE_H = 'ui.snippet.inlineEditorH';
const LS_SPLIT_RATIO = 'ui.snippet.tabSplitRatio';

/** Ratio bounds. The real min-panel enforcement happens in `splitHeights`
 * against a measured container; this is the guard on the *stored* value so a
 * hand-edited or corrupt key cannot persist an unusable extreme. */
const RATIO_MIN = 0.1;
const RATIO_MAX = 0.9;

export function clampInlineHeight(px: number): number {
	if (!Number.isFinite(px)) return INLINE_DEFAULT_H;
	return Math.round(Math.max(INLINE_MIN_H, Math.min(INLINE_MAX_H, px)));
}

export function clampSplitRatio(r: number): number {
	if (!Number.isFinite(r)) return SPLIT_DEFAULT_RATIO;
	return Math.max(RATIO_MIN, Math.min(RATIO_MAX, r));
}

export interface SplitHeights {
	/** Editor pane height, px. */
	topH: number;
	/** Console pane height, px. */
	bottomH: number;
}

/**
 * Resolve the editor/console pane heights for a measured container.
 *
 * When the container is too short to hold two minimums the EDITOR yields
 * first: a console squeezed to nothing hides the run output and the traceback
 * links that are the only way back to the offending line, whereas a squeezed
 * editor is still scrollable.
 */
export function splitHeights(args: {
	containerH: number;
	ratio: number;
	dividerH: number;
	minPanelH: number;
}): SplitHeights {
	const { containerH, ratio, dividerH, minPanelH } = args;
	const expandable = containerH - dividerH;
	if (expandable <= 0) return { topH: 0, bottomH: 0 };
	if (expandable <= minPanelH * 2) {
		const bottomH = Math.max(0, Math.min(minPanelH, expandable));
		return { topH: Math.max(0, expandable - bottomH), bottomH };
	}
	const rawTop = Math.round(expandable * ratio);
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, rawTop));
	return { topH, bottomH: expandable - topH };
}

/** Translate a divider drag (pointer Y measured from the container's top) into
 * a new editor-share ratio, clamped so neither pane drops below `minPanelH`. */
export function ratioFromPointer(args: {
	pointerY: number;
	containerH: number;
	dividerH: number;
	minPanelH: number;
}): number {
	const { pointerY, containerH, dividerH, minPanelH } = args;
	const expandable = containerH - dividerH;
	if (expandable <= 0) return SPLIT_DEFAULT_RATIO;
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, pointerY));
	return Math.max(0, Math.min(1, topH / expandable));
}

function readNumber(key: string, fallback: number): number {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null || raw.trim() === '') return fallback;
		const n = Number(raw);
		return Number.isFinite(n) ? n : fallback;
	} catch {
		// No storage (SSR/prerender, or denied): callers get the default.
		return fallback;
	}
}

function writeNumber(key: string, value: number): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		/* storage full/denied: the size simply doesn't persist */
	}
}

export function loadInlineHeight(): number {
	return clampInlineHeight(readNumber(LS_INLINE_H, INLINE_DEFAULT_H));
}

export function saveInlineHeight(px: number): void {
	writeNumber(LS_INLINE_H, clampInlineHeight(px));
}

export function loadSplitRatio(): number {
	return clampSplitRatio(readNumber(LS_SPLIT_RATIO, SPLIT_DEFAULT_RATIO));
}

export function saveSplitRatio(r: number): void {
	writeNumber(LS_SPLIT_RATIO, clampSplitRatio(r));
}
