// Render tests for the editable value cell (Task 6). `@testing-library/svelte`
// is not a project dependency, so this follows the repo's established
// Svelte-5 render convention (mount/unmount/flushSync + dispatchEvent) used by
// `Table/__tests__/TableGrid.test.ts` and
// `components/__tests__/property-form-lock.test.ts`, rather than the task
// brief's literal `@testing-library/svelte` snippet.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Element, TableCell } from '$lib/api/types';
import { resetCheckout, setProjectInfo } from '$lib/state';
import * as gate from '$lib/state/edit-gate';
import * as modelStore from '$lib/state/model.svelte';
import ValueCell from '../ValueCell.svelte';

function fakeElement(overrides: Partial<Element> = {}): Element {
	return { id: 'e1', type_name: 'Block', properties: { mass: 1 }, rev: 0, ...overrides };
}

function valueCell(overrides: Partial<Extract<TableCell, { kind: 'value' }>> = {}) {
	return {
		kind: 'value' as const,
		present: true,
		value: 1,
		element_id: 'e1',
		editable: true,
		...overrides
	};
}

function render(props: { cell: ReturnType<typeof valueCell>; tabId: string; columnName?: string }) {
	const component = mount(ValueCell, { target: document.body, props });
	flushSync();
	return component;
}

beforeEach(() => {
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});
afterEach(() => {
	resetCheckout();
	modelStore.resetModelStore();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ValueCell editing', () => {
	it('acquires a lock then stages a typed set_property on edit', async () => {
		const ensureElement = vi
			.spyOn(modelStore, 'ensureElement')
			.mockResolvedValue(fakeElement());
		vi.spyOn(gate, 'editLock').mockResolvedValue(true);
		const emit = vi.spyOn(modelStore, 'emit').mockImplementation(() => {});

		const c = render({ tabId: 't', columnName: 'mass', cell: valueCell({ value: 1 }) });
		try {
			const input = document.body.querySelector('input[type="number"]');
			if (!input) throw new Error('numeric input not rendered');
			(input as HTMLInputElement).value = '5';
			input.dispatchEvent(new Event('change', { bubbles: true }));
			input.dispatchEvent(new Event('blur', { bubbles: true }));
			flushSync();
			await new Promise((resolve) => setTimeout(resolve, 0));
			flushSync();

			expect(ensureElement).toHaveBeenCalledWith('e1');
			expect(gate.editLock).toHaveBeenCalledWith('e1');
			expect(emit).toHaveBeenCalledWith({
				kind: 'update_element',
				id: 'e1',
				properties_patch: { mass: 5 }
			});
		} finally {
			unmount(c);
		}
	});

	it('loads an uncached element before staging, so the edit is not silently dropped (A2)', async () => {
		// Regression for the reported data-loss gap: the table grid never
		// pre-seeds `_elements` for cells it renders (unlike the Inspector/tree),
		// so committing an edit on a cell whose element isn't cached must first
		// `ensureElement` it — otherwise `applyOptimistic`'s `update_element`
		// branch is a silent no-op (empty revert journal, no `_elements` write)
		// and the edit is unreachable from the staged diff/Commit button.
		const ensureElement = vi
			.spyOn(modelStore, 'ensureElement')
			.mockResolvedValue(fakeElement());
		vi.spyOn(gate, 'editLock').mockResolvedValue(true);
		const emit = vi.spyOn(modelStore, 'emit').mockImplementation(() => {});

		const c = render({ tabId: 't', columnName: 'mass', cell: valueCell({ value: 1 }) });
		try {
			const input = document.body.querySelector('input[type="number"]');
			if (!input) throw new Error('numeric input not rendered');
			(input as HTMLInputElement).value = '5';
			input.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			await new Promise((resolve) => setTimeout(resolve, 0));
			flushSync();

			expect(ensureElement).toHaveBeenCalledWith('e1');
			// ensureElement must resolve (and thus be called) before editLock/emit
			// — otherwise the fix wouldn't guarantee the element is cached by the
			// time applyOptimistic runs.
			const ensureOrder = ensureElement.mock.invocationCallOrder[0];
			const emitOrder = emit.mock.invocationCallOrder[0];
			expect(ensureOrder).toBeLessThan(emitOrder);
			expect(emit).toHaveBeenCalledWith({
				kind: 'update_element',
				id: 'e1',
				properties_patch: { mass: 5 }
			});
		} finally {
			unmount(c);
		}
	});

	it('does not stage an edit when the element resolves unknown/deleted (A2)', async () => {
		const ensureElement = vi.spyOn(modelStore, 'ensureElement').mockResolvedValue(null);
		const editLock = vi.spyOn(gate, 'editLock').mockResolvedValue(true);
		const emit = vi.spyOn(modelStore, 'emit').mockImplementation(() => {});

		const c = render({ tabId: 't', columnName: 'mass', cell: valueCell({ value: 1 }) });
		try {
			const input = document.body.querySelector('input[type="number"]');
			if (!input) throw new Error('numeric input not rendered');
			(input as HTMLInputElement).value = '5';
			input.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			await new Promise((resolve) => setTimeout(resolve, 0));
			flushSync();

			expect(ensureElement).toHaveBeenCalledWith('e1');
			expect(editLock).not.toHaveBeenCalled();
			expect(emit).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('renders read-only with no editor when the cell is not editable', () => {
		const c = render({
			tabId: 't',
			columnName: 'mass',
			cell: valueCell({ editable: false })
		});
		try {
			expect(document.body.querySelector('input[type="number"]')).toBeNull();
			expect(document.body.querySelector('input[type="text"]')).toBeNull();
			expect(document.body.textContent).toContain('1');
		} finally {
			unmount(c);
		}
	});

	it('renders empty text for a not-present cell even if a staged patch exists', () => {
		// Guards the `cell.present` read-only gate: a leftover staged edit for
		// this column must NOT leak a value into a cell the evaluate response
		// marked not-present (which is styled greyed/muted).
		vi.spyOn(modelStore, 'getStagedOpsFor').mockReturnValue([
			{ kind: 'update_element', id: 'e1', properties_patch: { mass: 42 } }
		]);
		const c = render({
			tabId: 't',
			columnName: 'mass',
			cell: valueCell({ present: false, value: null, editable: false })
		});
		try {
			const span = document.body.querySelector('span');
			if (!span) throw new Error('read-only span not rendered');
			expect(span.textContent).toBe('');
			expect(document.body.textContent).not.toContain('42');
		} finally {
			unmount(c);
		}
	});
});
