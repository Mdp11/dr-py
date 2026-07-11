// Render tests for the editable value cell (Task 6). `@testing-library/svelte`
// is not a project dependency, so this follows the repo's established
// Svelte-5 render convention (mount/unmount/flushSync + dispatchEvent) used by
// `Table/__tests__/TableGrid.test.ts` and
// `components/__tests__/property-form-lock.test.ts`, rather than the task
// brief's literal `@testing-library/svelte` snippet.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TableCell } from '$lib/api/types';
import { resetCheckout, setProjectInfo } from '$lib/state';
import * as gate from '$lib/state/edit-gate';
import * as modelStore from '$lib/state/model.svelte';
import ValueCell from '../ValueCell.svelte';

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
			await Promise.resolve();
			await Promise.resolve();

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
});
