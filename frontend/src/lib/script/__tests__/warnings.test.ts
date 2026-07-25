import { describe, expect, it } from 'vitest';
import { formatScriptWarning } from '../warnings';
import type { ScriptWarning } from '$lib/api/types';

function w(over: Partial<ScriptWarning>): ScriptWarning {
	return { code: 'nav_unknown_ids', occurrences: 1, total: 0, detail: null, ...over };
}

describe('formatScriptWarning', () => {
	it('reports unknown ids with both numbers', () => {
		expect(formatScriptWarning(w({ code: 'nav_unknown_ids', occurrences: 17, total: 42 }))).toBe(
			'Navigation script returned 42 unknown element ids across 17 calls — dropped.'
		);
	});

	it('uses singular forms at one', () => {
		expect(formatScriptWarning(w({ code: 'nav_unknown_ids', occurrences: 1, total: 1 }))).toBe(
			'Navigation script returned 1 unknown element id across 1 call — dropped.'
		);
	});

	it('reports already-visited drops', () => {
		expect(
			formatScriptWarning(w({ code: 'nav_already_visited', occurrences: 3, total: 8 }))
		).toBe('8 elements already visited in the chain, dropped across 3 steps.');
	});

	it('reports a step failure with its message and firing count', () => {
		expect(
			formatScriptWarning(
				w({ code: 'nav_step_failed', occurrences: 4, detail: 'ZeroDivisionError' })
			)
		).toBe('Navigation script step failed (4×): ZeroDivisionError');
	});

	it('drops the count for a single step failure', () => {
		expect(
			formatScriptWarning(w({ code: 'nav_step_failed', occurrences: 1, detail: 'boom' }))
		).toBe('Navigation script step failed: boom');
	});

	it('reports a dangling snippet ref', () => {
		expect(
			formatScriptWarning(w({ code: 'nav_snippet_not_found', detail: 'snip-7' }))
		).toBe('Navigation script step references a snippet that no longer exists (snip-7).');
	});

	it('reports the sort fallback', () => {
		expect(formatScriptWarning(w({ code: 'sort_needs_script_nav' }))).toBe(
			"Sorting by this column needs script values that aren't computed for every row, so rows stay in build order."
		);
	});

	// A server ahead of the client must degrade to something readable rather
	// than to a blank strip.
	it('falls back to the detail, then the code, for an unknown code', () => {
		expect(formatScriptWarning(w({ code: 'brand_new', detail: 'something happened' }))).toBe(
			'something happened'
		);
		expect(formatScriptWarning(w({ code: 'brand_new', detail: null }))).toBe('brand_new');
	});
});
