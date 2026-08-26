// An element-valued property resolves its value to a name — and that name
// must be a way to get there, not just a label. These tests pin the
// navigation affordance and that it never doubles as an edit.
import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { server } from '../../api/__tests__/server';
import { resetModelStore, seedElements, setModelApiConfig } from '../../state/model.svelte';
import { clearSelection, getSelection } from '../../state/selection.svelte';
import ElementRefPicker from '../Inspector/ElementRefPicker.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
	clearSelection();
	document.body.innerHTML = '';
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
	clearSelection();
});

function button(testid: string): HTMLButtonElement {
	const node = document.body.querySelector(`[data-testid="${testid}"]`);
	if (node === null) throw new Error(`${testid} not rendered`);
	return node as HTMLButtonElement;
}

it('navigates to the referenced element when its name is clicked, without changing the value', () => {
	seedElements([{ id: 'e2', type_name: 'Tank', properties: { name: 'T-9' }, rev: 1 }]);
	const onChange = vi.fn();
	const c = mount(ElementRefPicker, {
		target: document.body,
		props: { valueId: 'e2', targetTypeName: 'Tank', onChange }
	});
	flushSync();
	try {
		const link = button('element-ref-goto');
		expect(link.textContent?.trim()).toBe('T-9');
		// the raw id stays reachable as the title, since names are not unique
		expect(link.title).toBe('e2');

		link.click();
		flushSync();

		expect(getSelection()).toEqual({ kind: 'element', id: 'e2' });
		expect(onChange).not.toHaveBeenCalled();
	} finally {
		unmount(c);
	}
});
