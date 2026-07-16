import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { server } from '../../api/__tests__/server';
import { resetModelStore } from '../../state/model.svelte';
import { setSearchText } from '../../state/filters.svelte';
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

function typeQuery(q: string): void {
	const input = document.querySelector('input') as HTMLInputElement;
	input.value = q;
	input.dispatchEvent(new Event('input', { bubbles: true }));
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
		const row = document.querySelector('#sidebar-search-dropdown li button') as HTMLElement;
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
		const row = document.querySelector('#sidebar-search-dropdown li button') as HTMLElement;
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
		const row = document.querySelector('#sidebar-search-dropdown li button') as HTMLElement;
		expect(row).not.toBeNull();
		expect(row.textContent).toContain('Valve');
		// the id appears exactly once (as the display-name fallback)
		const matches = row.textContent?.match(/e_002/g) ?? [];
		expect(matches).toHaveLength(1);
	} finally {
		unmount(component);
	}
});
