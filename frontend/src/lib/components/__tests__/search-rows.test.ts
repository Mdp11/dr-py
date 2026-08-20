import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { server } from '../../api/__tests__/server';
import { resetModelStore } from '../../state/model.svelte';
import { setSearchText } from '../../state/filters.svelte';
import { clearSelection, getSelection } from '../../state/selection.svelte';
import Search from '../Sidebar/Search.svelte';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
	server.resetHandlers();
	setSearchText('');
});
afterAll(() => server.close());
beforeEach(() => resetModelStore());

/** Wait past the 250ms search debounce + the mocked fetch. */
const settle = () => new Promise((r) => setTimeout(r, 350));

function searchInput(): HTMLInputElement {
	return document.querySelector('input') as HTMLInputElement;
}

function typeQuery(q: string): void {
	const input = searchInput();
	input.value = q;
	input.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(key: string): void {
	searchInput().dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
	);
	flushSync();
}

function options(): HTMLElement[] {
	return [
		...document.querySelectorAll('#sidebar-search-dropdown [role="option"]')
	] as HTMLElement[];
}

/** Two results, so an arrow step has somewhere to go. */
function serveTwo(): void {
	server.use(
		http.get(`*/model/elements`, () =>
			HttpResponse.json({
				items: [
					{ id: 'e_001', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 },
					{ id: 'e_002', type_name: 'Pump', properties: { name: 'P-102' }, rev: 1 }
				],
				total: 2
			})
		)
	);
}

/** Mount, type, and wait past the debounce + mocked fetch. */
async function mountWithResults(): Promise<ReturnType<typeof mount>> {
	serveTwo();
	const component = mount(Search, { target: document.body });
	typeQuery('P-1');
	flushSync();
	await settle();
	flushSync();
	return component;
}

it('renders "<name> <stereotype>" rows, id only in the tooltip', async () => {
	server.use(
		http.get(`*/model/elements`, () =>
			HttpResponse.json({
				items: [{ id: 'e_001', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 }],
				total: 1
			})
		)
	);
	const component = mount(Search, { target: document.body });
	try {
		typeQuery('P-1');
		flushSync();
		await settle();
		flushSync();
		const row = document.querySelector('#sidebar-search-dropdown li[role="option"]') as HTMLElement;
		expect(row).not.toBeNull();
		expect(row.textContent).toContain('P-101');
		expect(row.textContent).toContain('Pump');
		expect(row.textContent).not.toContain('e_001'); // id lives in the tooltip only
		expect(row.title).toBe('e_001');
	} finally {
		unmount(component);
	}
});

it('resolves a capital-N `Name` property as the display name', async () => {
	server.use(
		http.get(`*/model/elements`, () =>
			HttpResponse.json({
				items: [{ id: 'e_003', type_name: 'Tank', properties: { Name: 'T-201' }, rev: 1 }],
				total: 1
			})
		)
	);
	const component = mount(Search, { target: document.body });
	try {
		typeQuery('T-2');
		flushSync();
		await settle();
		flushSync();
		const row = document.querySelector('#sidebar-search-dropdown li[role="option"]') as HTMLElement;
		expect(row.textContent).toContain('T-201');
		expect(row.textContent).not.toContain('e_003');
	} finally {
		unmount(component);
	}
});

it('falls back to "<id> <stereotype>" when the element has no name (id shown once)', async () => {
	server.use(
		http.get(`*/model/elements`, () =>
			HttpResponse.json({
				items: [{ id: 'e_002', type_name: 'Valve', properties: {}, rev: 1 }],
				total: 1
			})
		)
	);
	const component = mount(Search, { target: document.body });
	try {
		typeQuery('e_0');
		flushSync();
		await settle();
		flushSync();
		const row = document.querySelector('#sidebar-search-dropdown li[role="option"]') as HTMLElement;
		expect(row).not.toBeNull();
		expect(row.textContent).toContain('Valve');
		// the id appears exactly once (as the display-name fallback)
		const matches = row.textContent?.match(/e_002/g) ?? [];
		expect(matches).toHaveLength(1);
	} finally {
		unmount(component);
	}
});

/**
 * The ARIA combobox pattern, shared with `Metamodel/MetamodelSearch.svelte`:
 * focus stays on the input and the active row is announced through
 * `aria-activedescendant`. Before this the sidebar typeahead had no keyboard
 * navigation at all — the dropdown was mouse-only.
 */
it('wires the combobox pattern and moves the active row with the arrows', async () => {
	const component = await mountWithResults();
	try {
		const input = searchInput();
		expect(input.getAttribute('role')).toBe('combobox');
		expect(input.getAttribute('aria-autocomplete')).toBe('list');
		expect(input.getAttribute('aria-expanded')).toBe('true');

		const listbox = document.querySelector('#sidebar-search-dropdown [role="listbox"]');
		expect(input.getAttribute('aria-controls')).toBe(listbox?.id);

		const rows = options();
		expect(rows).toHaveLength(2);
		expect(input.getAttribute('aria-activedescendant')).toBe(rows[0].id);
		expect(rows[0].getAttribute('aria-selected')).toBe('true');

		press('ArrowDown');
		expect(input.getAttribute('aria-activedescendant')).toBe(options()[1].id);
		expect(options()[1].getAttribute('aria-selected')).toBe('true');

		// Wraps, like the metamodel search.
		press('ArrowDown');
		expect(input.getAttribute('aria-activedescendant')).toBe(options()[0].id);
	} finally {
		unmount(component);
	}
});

it('Enter selects the active row', async () => {
	clearSelection();
	const component = await mountWithResults();
	try {
		press('ArrowDown');
		press('Enter');
		expect(getSelection()).toEqual({ kind: 'element', id: 'e_002' });
		expect(options()).toHaveLength(0); // picking closes the dropdown
	} finally {
		unmount(component);
		clearSelection();
	}
});

it('Tab closes the dropdown on the way out', async () => {
	const component = await mountWithResults();
	try {
		expect(options()).toHaveLength(2);
		press('Tab');
		expect(options()).toHaveLength(0);
	} finally {
		unmount(component);
	}
});
