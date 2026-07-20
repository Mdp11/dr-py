// "Use current selection" binds elements from the shared multi-selection.
// Follows the repo's raw mount/flushSync Svelte-5 convention (see
// Table/__tests__/ColumnManager.test.ts).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it } from 'vitest';

import type { Element } from '$lib/api/types';
import {
	clearSelection,
	clearSnippetElements,
	getMultiSelectedIds,
	getSnippetRun,
	seedElements,
	select,
	setSnippetEntry
} from '$lib/state';
import ElementContextRow from '../ElementContextRow.svelte';

function el(id: string, name: string): Element {
	return { id, type_name: 'Block', properties: { name }, rev: 1 };
}

function render(tabId: string) {
	const c = mount(ElementContextRow, { target: document.body, props: { tabId } });
	flushSync();
	return c;
}

function clickUseSelection(): void {
	const btn = [...document.querySelectorAll('button')].find((b) =>
		b.textContent?.includes('Use current selection')
	);
	if (!btn) throw new Error('Use current selection button not found');
	btn.click();
	flushSync();
}

afterEach(() => {
	getMultiSelectedIds().clear();
	clearSelection();
});

it('binds every multi-selected element for a value entry', () => {
	const tabId = 'snip:sel:value';
	setSnippetEntry(tabId, 'value');
	clearSnippetElements(tabId);
	seedElements([el('a', 'Alpha'), el('b', 'Beta')]);
	const ms = getMultiSelectedIds();
	ms.add('a');
	ms.add('b');
	select({ kind: 'element', id: 'b' }); // primary; the whole set should win

	const c = render(tabId);
	try {
		clickUseSelection();
		const ids = getSnippetRun(tabId)
			.elements.map((e) => e.id)
			.sort();
		expect(ids).toEqual(['a', 'b']);
	} finally {
		unmount(c);
	}
});

it('binds only the primary selection for a step entry even with multiple selected', () => {
	const tabId = 'snip:sel:step';
	setSnippetEntry(tabId, 'step');
	clearSnippetElements(tabId);
	seedElements([el('a', 'Alpha'), el('b', 'Beta')]);
	const ms = getMultiSelectedIds();
	ms.add('a');
	ms.add('b');
	select({ kind: 'element', id: 'b' });

	const c = render(tabId);
	try {
		clickUseSelection();
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['b']);
	} finally {
		unmount(c);
	}
});

it('falls back to the single primary selection when nothing is multi-selected', () => {
	const tabId = 'snip:sel:single';
	setSnippetEntry(tabId, 'value');
	clearSnippetElements(tabId);
	seedElements([el('a', 'Alpha')]);
	select({ kind: 'element', id: 'a' });

	const c = render(tabId);
	try {
		clickUseSelection();
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['a']);
	} finally {
		unmount(c);
	}
});
