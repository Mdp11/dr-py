/**
 * Where the LOD cursor tooltip goes (spec 2026-08-20 §4), as a pure function of
 * the cursor and the viewport so the placement rule is testable without a
 * layout engine.
 *
 * The tooltip follows the pointer, which means near an edge of the window it
 * would run off it — and the right edge is exactly where the form panel and the
 * collapsed rail live, so "off-screen right" is the common case, not the corner
 * case. So each axis flips to the far side of the cursor when the side it
 * prefers cannot hold it.
 *
 * The flip anchors the OPPOSITE edge (`right`/`bottom` instead of
 * `left`/`top`) rather than subtracting an assumed width: a tooltip's real
 * width depends on the name it carries, and anchoring its trailing edge keeps
 * the gap to the cursor exactly {@link LOD_TOOLTIP_GAP} whatever that width
 * turns out to be. The MAX constants below are therefore only the DECISION
 * threshold — the worst case a tooltip could occupy, which the caller pins with
 * a matching `max-w`/line count — never a position. A tooltip narrower than the
 * cap simply flips a little earlier than it strictly had to, which is invisible
 * and always safe; the alternative (measuring the rendered box) would need a
 * post-render read on every pointer move.
 */

/** Distance from the cursor on whichever side the tooltip lands. */
export const LOD_TOOLTIP_GAP = 12;
/** Worst-case width — pinned by the tooltip's own `max-w` in the canvas. */
export const LOD_TOOLTIP_MAX_W = 320;
/** Worst-case height: one wrapped line of 11px text plus its padding. */
export const LOD_TOOLTIP_MAX_H = 44;

/** A CSS anchor pair: exactly one of `left`/`right` and one of `top`/`bottom`
 * is a number, the other of each is null. */
export interface TooltipAnchor {
	left: number | null;
	right: number | null;
	top: number | null;
	bottom: number | null;
}

export interface ViewportSize {
	width: number;
	height: number;
}

export function lodTooltipAnchor(
	cursor: { x: number; y: number },
	viewport: ViewportSize
): TooltipAnchor {
	const flipX = cursor.x + LOD_TOOLTIP_GAP + LOD_TOOLTIP_MAX_W > viewport.width;
	const flipY = cursor.y + LOD_TOOLTIP_GAP + LOD_TOOLTIP_MAX_H > viewport.height;
	return {
		left: flipX ? null : cursor.x + LOD_TOOLTIP_GAP,
		// `right` is measured from the viewport's right edge inwards, so the
		// tooltip's trailing edge lands GAP px to the LEFT of the cursor.
		right: flipX ? Math.max(0, viewport.width - cursor.x + LOD_TOOLTIP_GAP) : null,
		top: flipY ? null : cursor.y + LOD_TOOLTIP_GAP,
		bottom: flipY ? Math.max(0, viewport.height - cursor.y + LOD_TOOLTIP_GAP) : null
	};
}

/** The anchor as an inline `style` string — the one place the null-means-unset
 * convention above is turned into CSS, so the canvas markup stays declarative. */
export function tooltipStyle(a: TooltipAnchor): string {
	const parts: string[] = [];
	if (a.left !== null) parts.push(`left: ${a.left}px`);
	if (a.right !== null) parts.push(`right: ${a.right}px`);
	if (a.top !== null) parts.push(`top: ${a.top}px`);
	if (a.bottom !== null) parts.push(`bottom: ${a.bottom}px`);
	return `${parts.join('; ')};`;
}
