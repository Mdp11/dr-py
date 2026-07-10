/**
 * Central motion constants for svelte/transition calls.
 *
 * CSS animations are neutralized under prefers-reduced-motion by a global
 * media query in app.css; JS-driven transitions must opt in through dur().
 */
// Keep in sync with the --motion-* tokens in app.css and the dialog primitives' duration-200.
export const MICRO = 120;
export const PANEL = 200;

export function dur(ms: number): number {
	if (typeof window === 'undefined') return 0;
	// Feature-detect the Web Animations API that svelte/transition relies on.
	// Real browsers have shipped it for years; some DOM test harnesses
	// (happy-dom, jsdom) don't implement Element.animate, so a JS-driven
	// transition would throw there — fail safe to an instant (0ms) swap.
	if (typeof Element === 'undefined' || typeof Element.prototype.animate !== 'function') return 0;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}
