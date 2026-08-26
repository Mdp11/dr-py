// Unit tests for the SnippetSource shape predicates (mirrors
// entry-stubs.test.ts — pure, no component mount).
import { describe, expect, it } from 'vitest';

import { isEmptySnippetSource } from '$lib/snippet/source';

const inline = {
	definition: { schema_version: 1, language: 'python' as const, code: 'x = 1', entry_points: [] }
};

describe('isEmptySnippetSource', () => {
	it('is true for the tolerant unconfigured source', () => {
		expect(isEmptySnippetSource({})).toBe(true);
		expect(isEmptySnippetSource({ ref: null, definition: null })).toBe(true);
		expect(isEmptySnippetSource({ ref: undefined })).toBe(true);
	});

	it('treats nullish as empty, so a `transform: null` field tests the same way', () => {
		expect(isEmptySnippetSource(null)).toBe(true);
		expect(isEmptySnippetSource(undefined)).toBe(true);
	});

	it('is false once either half is set', () => {
		expect(isEmptySnippetSource({ ref: 'snip-1' })).toBe(false);
		expect(isEmptySnippetSource(inline)).toBe(false);
	});

	it('does not mistake an empty ref string for unset', () => {
		// '' is not a ref the server would accept, but it is SET — the caller
		// configured something, and the predicate reports shape, not validity.
		expect(isEmptySnippetSource({ ref: '' })).toBe(false);
	});
});
