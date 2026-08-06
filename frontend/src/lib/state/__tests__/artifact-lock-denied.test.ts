import { afterEach, describe, expect, it } from 'vitest';
import { markEditorLockDenied } from '../artifact-lock-denied';
import { getNavLockHolder, resetNavigationEditors } from '../navigation-editor.svelte';
import { getTableLockHolder, resetTableEditors } from '../table-editor.svelte';
import { getSnippetLockHolder, resetSnippetEditors } from '../snippet-editor.svelte';

afterEach(() => {
	resetNavigationEditors();
	resetTableEditors();
	resetSnippetEditors();
});

describe('markEditorLockDenied', () => {
	it('dispatches on the tab prefix to the owning editor store', () => {
		markEditorLockDenied('nav:a1', 'ada@example.com');
		markEditorLockDenied('tbl:a2', 'bob@example.com');
		markEditorLockDenied('snip:a3', 'cal@example.com');

		expect(getNavLockHolder('nav:a1')).toBe('ada@example.com');
		expect(getTableLockHolder('tbl:a2')).toBe('bob@example.com');
		expect(getSnippetLockHolder('snip:a3')).toBe('cal@example.com');
	});

	it('does not cross-wire the stores', () => {
		markEditorLockDenied('nav:a1', 'ada@example.com');

		expect(getTableLockHolder('nav:a1')).toBeNull();
		expect(getSnippetLockHolder('nav:a1')).toBeNull();
	});

	it('ignores a tab id from a non-artifact tab', () => {
		expect(() => markEditorLockDenied('model', 'ada@example.com')).not.toThrow();
		expect(getNavLockHolder('model')).toBeNull();
	});
});
