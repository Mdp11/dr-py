// "Use current selection" binds elements from the shared multi-selection.
// The row is CONTROLLED (Task 1): it owns no list state, so these tests
// assert the emitted callbacks rather than reading a store. Follows the
// repo's raw mount/flushSync Svelte-5 convention (see
// Table/__tests__/ColumnManager.test.ts).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';

import type { Element } from '$lib/api/types';
import {
	clearSelection,
	getMultiSelectedIds,
	seedElements,
	select,
	type SnippetBoundElement
} from '$lib/state';
import ElementContextRow from '../ElementContextRow.svelte';

function el(id: string, name: string): Element {
	return { id, type_name: 'Block', properties: { name }, rev: 1 };
}

function render(
	entry: 'value' | 'step',
	elements: SnippetBoundElement[],
	onAdd: (id: string, label: string) => void
) {
	const c = mount(ElementContextRow, {
		target: document.body,
		props: { entry, elements, onAdd, onRemove: () => {}, onClear: () => {} }
	});
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
	document.body.innerHTML = '';
});

it('emits onAdd for every multi-selected element for a value entry', () => {
	seedElements([el('a', 'Alpha'), el('b', 'Beta')]);
	const ms = getMultiSelectedIds();
	ms.add('a');
	ms.add('b');
	select({ kind: 'element', id: 'b' }); // primary; the whole set should win

	const onAdd = vi.fn();
	const c = render('value', [], onAdd);
	try {
		clickUseSelection();
		const ids = onAdd.mock.calls.map((call) => call[0] as string).sort();
		expect(ids).toEqual(['a', 'b']);
	} finally {
		unmount(c);
	}
});

it('emits onAdd only for the primary selection for a step entry', () => {
	seedElements([el('a', 'Alpha'), el('b', 'Beta')]);
	const ms = getMultiSelectedIds();
	ms.add('a');
	ms.add('b');
	select({ kind: 'element', id: 'b' });

	const onAdd = vi.fn();
	const c = render('step', [], onAdd);
	try {
		clickUseSelection();
		expect(onAdd.mock.calls.map((call) => call[0])).toEqual(['b']);
	} finally {
		unmount(c);
	}
});

it('falls back to the single primary selection when nothing is multi-selected', () => {
	seedElements([el('a', 'Alpha')]);
	select({ kind: 'element', id: 'a' });

	const onAdd = vi.fn();
	const c = render('value', [], onAdd);
	try {
		clickUseSelection();
		expect(onAdd.mock.calls.map((call) => call[0])).toEqual(['a']);
	} finally {
		unmount(c);
	}
});

it('renders a chip per bound element and emits onRemove for the clicked one', () => {
	const onRemove = vi.fn();
	const c = mount(ElementContextRow, {
		target: document.body,
		props: {
			entry: 'value' as const,
			elements: [
				{ id: 'a', label: 'Alpha' },
				{ id: 'b', label: 'Beta' }
			],
			onAdd: () => {},
			onRemove,
			onClear: () => {}
		}
	});
	flushSync();
	try {
		const removeBeta = document.querySelector('[aria-label="Remove Beta"]') as HTMLButtonElement;
		expect(removeBeta).toBeTruthy();
		removeBeta.click();
		flushSync();
		expect(onRemove).toHaveBeenCalledWith('b');
	} finally {
		unmount(c);
	}
});
