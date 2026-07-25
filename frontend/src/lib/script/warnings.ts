/**
 * User-facing copy for the backend's structured script-warning codes.
 *
 * The copy lives HERE and not in Python on purpose: the backend aggregates
 * counts (`occurrences` = how many times a kind fired, `total` = the summed
 * subject quantity) and ships numbers, so the sentence can pluralize against
 * the real figures. The previous design baked counts into backend strings and
 * deduped on the rendered text, which reported "1" for ten occurrences.
 *
 * Pure and dependency-free so both the table strip and the navigation dock
 * render identical wording.
 */
import type { ScriptWarning } from '$lib/api/types';

function plural(n: number, one: string, many: string): string {
	return n === 1 ? one : many;
}

/** One readable sentence for a warning.
 *
 * An unrecognized `code` falls back to `detail`, then to the raw code: a
 * server ahead of this client must degrade to something readable rather than
 * to a blank strip. */
export function formatScriptWarning(w: ScriptWarning): string {
	switch (w.code) {
		case 'nav_unknown_ids':
			return (
				`Navigation script returned ${w.total} unknown ` +
				`${plural(w.total, 'element id', 'element ids')} across ` +
				`${w.occurrences} ${plural(w.occurrences, 'call', 'calls')} — dropped.`
			);
		case 'nav_already_visited':
			return (
				`${w.total} ${plural(w.total, 'element', 'elements')} already visited in ` +
				`the chain, dropped across ${w.occurrences} ` +
				`${plural(w.occurrences, 'step', 'steps')}.`
			);
		case 'nav_step_failed':
			return w.occurrences === 1
				? `Navigation script step failed: ${w.detail}`
				: `Navigation script step failed (${w.occurrences}×): ${w.detail}`;
		case 'nav_snippet_not_found':
			return `Navigation script step references a snippet that no longer exists (${w.detail}).`;
		// Says "SORTING BY this column needs", not "this column's navigation":
		// the sort column is often a property/element column merely SOURCED
		// from the navigation column, and has no navigation of its own.
		case 'sort_needs_script_nav':
			return (
				"Sorting by this column needs script values that aren't computed for " +
				'every row, so rows stay in build order.'
			);
		default:
			return w.detail ?? w.code;
	}
}
