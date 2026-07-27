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
		expect(formatScriptWarning(w({ code: 'nav_snippet_not_found', detail: 'snip-7' }))).toBe(
			'Navigation script step references a snippet that no longer exists (snip-7).'
		);
	});

	// `detail` is typed `string | null`, so a null is a valid input by the
	// function's own contract even though neither current backend call site
	// sends one. These three pin that a null drops the detail clause instead
	// of interpolating the literal word "null" into the sentence.
	it('drops the detail clause for a single step failure with no detail', () => {
		expect(formatScriptWarning(w({ code: 'nav_step_failed', occurrences: 1, detail: null }))).toBe(
			'Navigation script step failed.'
		);
	});

	it('drops the detail clause but keeps the count for a repeated step failure with no detail', () => {
		const result = formatScriptWarning(
			w({ code: 'nav_step_failed', occurrences: 4, detail: null })
		);
		expect(result).toBe('Navigation script step failed (4×).');
		expect(result).not.toContain('null');
	});

	it('drops the detail clause for a dangling snippet ref with no detail', () => {
		expect(formatScriptWarning(w({ code: 'nav_snippet_not_found', detail: null }))).toBe(
			'Navigation script step references a snippet that no longer exists.'
		);
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

	it('falls back for a code this client does not know', () => {
		// `nav_already_visited` was removed server-side; an older server that
		// still sends it must degrade to something readable, never a blank.
		expect(
			formatScriptWarning(w({ code: 'nav_already_visited', occurrences: 3, total: 8 }))
		).toBe('nav_already_visited');
	});
});
