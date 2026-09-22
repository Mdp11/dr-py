// "Use current selection" binds elements from the shared multi-selection.
// The row is CONTROLLED: it owns no list state, so these tests assert the
// emitted callbacks rather than reading a store. Follows the repo's raw
// mount/flushSync Svelte-5 convention (see
// Table/__tests__/ColumnManager.test.ts).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as modelRead from '$lib/api/model-read';
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

function findClearAll(): HTMLButtonElement | undefined {
	return [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'clear all'
	) as HTMLButtonElement | undefined;
}

it('shows "clear all" only once >=2 elements are bound, and wires the click to onClear', () => {
	const onClear = vi.fn();
	const single = mount(ElementContextRow, {
		target: document.body,
		props: {
			entry: 'value' as const,
			elements: [{ id: 'a', label: 'Alpha' }],
			onAdd: () => {},
			onRemove: () => {},
			onClear
		}
	});
	flushSync();
	try {
		expect(findClearAll()).toBeUndefined();
	} finally {
		unmount(single);
	}

	document.body.innerHTML = '';

	const pair = mount(ElementContextRow, {
		target: document.body,
		props: {
			entry: 'value' as const,
			elements: [
				{ id: 'a', label: 'Alpha' },
				{ id: 'b', label: 'Beta' }
			],
			onAdd: () => {},
			onRemove: () => {},
			onClear
		}
	});
	flushSync();
	try {
		const clearAll = findClearAll();
		expect(clearAll).toBeTruthy();
		clearAll?.click();
		flushSync();
		expect(onClear).toHaveBeenCalledOnce();
	} finally {
		unmount(pair);
	}
});

describe('a superseded search', () => {
	afterEach(() => vi.restoreAllMocks());

	const debounce = () => new Promise((resolve) => setTimeout(resolve, 350));
	const page = (id: string) => ({ items: [el(id, id)], total: 1 });

	function typeInto(q: string): void {
		const input = document.querySelector(
			'[data-testid="snippet-element-search"]'
		) as HTMLInputElement;
		input.value = q;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}

	const rows = () =>
		[...document.querySelectorAll('li button')].map((b) => b.textContent?.trim().split(/\s+/)[0]);

	it('is aborted when the next query starts', async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const spy = vi.spyOn(modelRead, 'listElementsPage').mockImplementation((query) => {
			signals.push(query?.signal);
			return signals.length === 1 ? new Promise(() => {}) : Promise.resolve(page('b-2'));
		});
		const c = render('value', [], () => {});
		try {
			typeInto('b-1');
			await debounce();
			expect(spy).toHaveBeenCalledOnce();
			expect(signals[0]?.aborted).toBe(false);

			typeInto('b-2');
			expect(signals[0]?.aborted).toBe(true);
			await debounce();
			flushSync();

			expect(spy).toHaveBeenCalledTimes(2);
			expect(signals[1]?.aborted).toBe(false);
			expect(rows()).toEqual(['b-2']);
		} finally {
			unmount(c);
		}
	});

	it('an AbortError leaves the results as they were', async () => {
		vi.spyOn(modelRead, 'listElementsPage')
			.mockResolvedValueOnce(page('b-1'))
			.mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'));
		const c = render('value', [], () => {});
		try {
			typeInto('b-1');
			await debounce();
			flushSync();
			expect(rows()).toEqual(['b-1']);

			typeInto('b-10');
			await debounce();
			flushSync();

			expect(rows()).toEqual(['b-1']);
		} finally {
			unmount(c);
		}
	});
});
