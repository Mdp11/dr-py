import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import {
	addSnippetElement,
	getSnippetRun,
	resetSnippetEditors,
	setSnippetEntry
} from '../../state/snippet-editor.svelte';
import ElementContextRow from '../Snippet/ElementContextRow.svelte';

afterEach(() => {
	resetSnippetEditors();
	document.body.innerHTML = '';
});

it('renders chips for bound elements and removes one via its × button', () => {
	const tabId = 'snip:draft:test';
	setSnippetEntry(tabId, 'value');
	addSnippetElement(tabId, 'e1', 'Building One');
	addSnippetElement(tabId, 'e2', 'Building Two');
	const c = mount(ElementContextRow, { target: document.body, props: { tabId } });
	flushSync();
	expect(document.body.textContent).toContain('Building One');
	expect(document.body.textContent).toContain('Building Two');
	const remove = document.querySelector<HTMLButtonElement>('[aria-label="Remove Building One"]');
	expect(remove).not.toBeNull();
	remove!.click();
	flushSync();
	expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e2']);
	unmount(c);
});

it('shows clear-all only with 2+ chips and empties the binding', () => {
	const tabId = 'snip:draft:test2';
	setSnippetEntry(tabId, 'value');
	addSnippetElement(tabId, 'e1', 'One');
	const c = mount(ElementContextRow, { target: document.body, props: { tabId } });
	flushSync();
	const clearAll = () =>
		[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'clear all');
	expect(clearAll()).toBeUndefined();
	addSnippetElement(tabId, 'e2', 'Two');
	flushSync();
	expect(clearAll()).toBeDefined();
	clearAll()!.click();
	flushSync();
	expect(getSnippetRun(tabId).elements).toEqual([]);
	unmount(c);
});
