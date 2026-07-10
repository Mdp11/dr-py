/**
 * Decides what the containment tree's body renders, extracted pure (like
 * `windowing.ts`) so the warm-open loading sequence is unit-testable.
 *
 * On a warm open the global progress overlay never shows (GET /model/status is
 * 'ready' immediately) while boot() still loads metamodel → view → summary
 * sequentially; without the 'skeleton' state the tree walks through
 * "Load a metamodel…" → "Model is empty." → blank rows before content lands
 * (spec §5's "shows loading state" clause).
 */

export type TreeBodyState = 'onboarding' | 'skeleton' | 'empty' | 'rows';

export function treeBodyState(args: {
	/** A project boot/reload sequence is in flight (see project-open.svelte.ts). */
	opening: boolean;
	hasMetamodel: boolean;
	/** The summary's element_count, or null while the summary hasn't loaded. */
	summaryCount: number | null;
	/** The first containment-roots page for the current model has landed. */
	rootsLoaded: boolean;
	/** Top-level unified-tree nodes (root elements AND view folders). */
	rootCount: number;
}): TreeBodyState {
	const { opening, hasMetamodel, summaryCount, rootsLoaded, rootCount } = args;
	// Real content beats every placeholder — view folders may legitimately
	// paint before the summary or roots arrive.
	if (rootCount > 0) return 'rows';
	if (!hasMetamodel) return opening ? 'skeleton' : 'onboarding';
	if (summaryCount === 0) return 'empty';
	if (opening || (summaryCount !== null && !rootsLoaded)) return 'skeleton';
	// Idle with no summary: a metamodel-only project (boot's refreshSummary
	// 404s and leaves it null forever) — report empty, not an endless skeleton.
	if (summaryCount === null) return 'empty';
	// Roots are loaded but nothing is visible: the type filter (or the view)
	// hides everything — render the ordinary, genuinely empty rows area.
	return 'rows';
}
