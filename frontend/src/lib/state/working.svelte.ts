import { apply } from './apply';
import { computeDiff, type Diff } from './diff';
import { getBaseline } from './baseline.svelte';
import { getPendingOps } from './pending.svelte';
import type { Snapshot } from './ops';

/**
 * Compute the current working snapshot by applying pending ops onto the
 * baseline. This is called eagerly on each invocation; consumers inside
 * Svelte components can wrap it in `$derived` to memoize per-frame.
 */
export function getWorkingModel(): Snapshot {
	const baseline = getBaseline();
	if (!baseline) return { elements: [], relationships: [] };
	return apply(baseline, getPendingOps());
}

/**
 * Compute the current diff between baseline and working snapshot.
 */
export function getDiff(): Diff {
	return computeDiff(getBaseline(), getWorkingModel());
}
