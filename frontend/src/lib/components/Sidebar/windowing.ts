// frontend/src/lib/components/Sidebar/windowing.ts
//
// Pure geometry for the virtualized tree. No Svelte, no DOM — every function
// is a deterministic transform so the windowing/auto-load/edge-scroll behaviour
// can be unit-tested without a browser.

export interface WindowSlice {
	/** First row index to mount (inclusive). */
	start: number;
	/** One past the last row index to mount (exclusive). */
	end: number;
	/** Spacer height above the mounted window, px. */
	padTop: number;
	/** Spacer height below the mounted window, px. */
	padBottom: number;
}

/**
 * Compute the mounted row window for a fixed-row-height list. `overscan` rows
 * are mounted above and below the viewport so fast scrolls don't flash blanks.
 */
export function computeWindow(args: {
	scrollTop: number;
	viewportH: number;
	rowH: number;
	total: number;
	overscan: number;
}): WindowSlice {
	const { scrollTop, viewportH, rowH, total, overscan } = args;
	if (total <= 0 || rowH <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
	const firstVisible = Math.floor(scrollTop / rowH);
	const start = Math.min(Math.max(0, firstVisible - overscan), total);
	const visibleRows = Math.ceil(viewportH / rowH);
	const end = Math.min(total, firstVisible + visibleRows + overscan);
	return {
		start,
		end,
		padTop: start * rowH,
		padBottom: (total - end) * rowH
	};
}

/**
 * True when the mounted window is within `threshold` rows of the last loaded
 * row and the server still has more (`loadedCount < total`). Drives automatic
 * paging — there is no "Show more" button.
 */
export function shouldLoadMore(args: {
	windowEnd: number;
	loadedCount: number;
	total: number;
	threshold: number;
}): boolean {
	const { windowEnd, loadedCount, total, threshold } = args;
	if (loadedCount >= total) return false;
	return windowEnd >= loadedCount - threshold;
}

/**
 * Auto-load gate for the "Not in view" excluded pool.
 *
 * The pool's loaded rows sit at the TAIL of `visibleRows`, so {@link shouldLoadMore}'s
 * window-vs-loaded-count math only holds while the section is EXPANDED. When it is
 * collapsed those rows leave `visibleRows`, the short list always reads as "at the
 * bottom", and — since the server still has more — an ungated check would bump the
 * page limit on every pass, paging the entire pool into memory while nothing is even
 * on screen. A collapsed section can never have a pool row in the window, so it must
 * never auto-load.
 */
export function shouldLoadMoreExcluded(args: {
	sectionCollapsed: boolean;
	windowEnd: number;
	loadedCount: number;
	total: number;
	threshold: number;
}): boolean {
	if (args.sectionCollapsed) return false;
	const { windowEnd, loadedCount, total, threshold } = args;
	return shouldLoadMore({ windowEnd, loadedCount, total, threshold });
}

/**
 * Per-frame scroll delta (px) for edge auto-scroll while dragging. Returns a
 * negative value near the top edge (scroll up), positive near the bottom,
 * scaled linearly with how deep into the `edge` band the pointer sits. Zero in
 * the middle.
 */
export function edgeScrollDelta(args: {
	pointerY: number;
	top: number;
	bottom: number;
	edge: number;
	maxSpeed: number;
}): number {
	const { pointerY, top, bottom, edge, maxSpeed } = args;
	if (pointerY < top + edge) {
		const frac = Math.min(1, (top + edge - pointerY) / edge);
		return -Math.ceil(maxSpeed * frac);
	}
	if (pointerY > bottom - edge) {
		const frac = Math.min(1, (pointerY - (bottom - edge)) / edge);
		return Math.ceil(maxSpeed * frac);
	}
	return 0;
}
