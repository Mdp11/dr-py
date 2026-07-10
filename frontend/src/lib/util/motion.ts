/**
 * Central motion constants for svelte/transition calls.
 *
 * CSS animations are neutralized under prefers-reduced-motion by a global
 * media query in app.css; JS-driven transitions must opt in through dur().
 */
export const MICRO = 120;
export const PANEL = 200;

export function dur(ms: number): number {
	if (typeof window === 'undefined') return 0;
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}
