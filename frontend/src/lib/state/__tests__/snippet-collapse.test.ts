// `seedSnippetExpanded` is how the "+ Script step / + Script column" buttons
// open their new editor already expanded without flipping the store's
// default (collapsed), which exists so a settings dialog full of script
// columns is readable.
import { beforeEach, describe, expect, it } from 'vitest';
import {
	isSnippetExpanded,
	resetSnippetCollapse,
	seedSnippetExpanded,
	setSnippetExpanded
} from '../snippet-collapse.svelte';

beforeEach(() => resetSnippetCollapse());

describe('seedSnippetExpanded', () => {
	it('expands a key that has never been seen', () => {
		expect(isSnippetExpanded('t::col:0')).toBe(false);
		seedSnippetExpanded('t::col:0');
		expect(isSnippetExpanded('t::col:0')).toBe(true);
	});

	it('never stomps a value the user already set', () => {
		setSnippetExpanded('t::col:0', false);
		seedSnippetExpanded('t::col:0');
		expect(isSnippetExpanded('t::col:0')).toBe(false);
	});

	it('leaves neighbouring keys alone', () => {
		seedSnippetExpanded('t::col:1');
		expect(isSnippetExpanded('t::col:0')).toBe(false);
		expect(isSnippetExpanded('t::col:2')).toBe(false);
	});
});
