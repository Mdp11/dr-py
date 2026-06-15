// frontend/src/lib/components/Sidebar/split.ts
//
// Pure geometry for the tree / excluded-pool vertical split. No Svelte, no DOM,
// so the divider sizing/clamping can be unit-tested without a browser (mirrors
// windowing.ts).
//
// `ratio` is the fraction of the EXPANDABLE area (container minus the pool
// header bar and the divider strip) given to the TOP (in-view tree) panel.

export interface SplitHeights {
	/** In-view tree viewport height, px. */
	topH: number;
	/** Excluded-pool body height (below its header), px; 0 when collapsed. */
	bottomH: number;
}

/**
 * Resolve the two panel heights. Collapsed: the pool shows only its fixed header
 * bar and the tree takes the rest. Expanded: the area left after the header and
 * divider is split by `ratio`, clamped so neither panel drops below `minPanelH`.
 * If the container is too short to hold two mins, the top panel yields first so
 * the pool keeps as much of `minPanelH` as fits.
 */
export function panelHeights(args: {
	containerH: number;
	ratio: number;
	collapsed: boolean;
	headerH: number;
	dividerH: number;
	minPanelH: number;
}): SplitHeights {
	const { containerH, ratio, collapsed, headerH, dividerH, minPanelH } = args;
	if (collapsed) {
		return { topH: Math.max(0, containerH - headerH), bottomH: 0 };
	}
	const expandable = containerH - headerH - dividerH;
	if (expandable <= minPanelH) {
		const bottomH = Math.max(0, Math.min(minPanelH, expandable));
		return { topH: Math.max(0, expandable - bottomH), bottomH };
	}
	const rawTop = Math.round(expandable * ratio);
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, rawTop));
	return { topH, bottomH: expandable - topH };
}

/**
 * Translate a divider drag (pointer Y measured from the container top) into a
 * new top-panel ratio, clamped to keep both panels >= minPanelH.
 */
export function clampRatio(args: {
	pointerY: number;
	containerH: number;
	headerH: number;
	dividerH: number;
	minPanelH: number;
}): number {
	const { pointerY, containerH, headerH, dividerH, minPanelH } = args;
	const expandable = containerH - headerH - dividerH;
	if (expandable <= 0) return 0.5;
	const topH = Math.max(minPanelH, Math.min(expandable - minPanelH, pointerY));
	return Math.max(0, Math.min(1, topH / expandable));
}
