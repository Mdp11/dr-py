// Render smoke test for TableGrid (Task 5): a header per column, a row per
// page row, and cells dispatched by kind. `@testing-library/svelte` is not a
// project dependency, so this follows the repo's established Svelte-5 render
// convention (mount/unmount/flushSync) used by
// `Navigation/__tests__/results-dock.test.ts` rather than the brief's literal
// `@testing-library/svelte` snippet.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TablePage } from '$lib/api/types';
import * as store from '$lib/state/table-editor.svelte';
import TableGrid from '../TableGrid.svelte';

const PAGE: TablePage = {
	columns: [
		{ kind: 'element', header: 'Block', width_px: null },
		{ kind: 'property', header: 'Mass', width_px: null }
	],
	rows: [
		{
			key: ['e1'],
			cells: [
				{
					kind: 'element',
					item: { id: 'e1', type_name: 'Block', display_name: 'B', child_count: 0 }
				},
				{ kind: 'value', present: true, value: 10, element_id: 'e1', editable: true }
			]
		}
	],
	total: 1,
	truncated: false,
	offset: 0,
	model_rev: 1
};

function render(tabId: string) {
	const component = mount(TableGrid, { target: document.body, props: { tabId } });
	flushSync();
	return component;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('TableGrid', () => {
	it('renders a header per column and a row per page row', () => {
		vi.spyOn(store, 'getTablePage').mockReturnValue(PAGE);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		const c = render('tbl:draft:1');
		try {
			const header = document.querySelector('[data-testid="table-header"]');
			expect(header?.textContent).toContain('Block');
			expect(header?.textContent).toContain('Mass');
			const rows = [...document.querySelectorAll('[data-testid="table-row"]')];
			expect(rows).toHaveLength(1);
			expect(rows[0].textContent).toContain('B');
			expect(rows[0].textContent).toContain('10');
		} finally {
			unmount(c);
		}
	});

	it('shows a loading indicator while the page is (re)loading', () => {
		vi.spyOn(store, 'getTablePage').mockReturnValue(undefined);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(true);
		const c = render('tbl:draft:2');
		try {
			expect(document.body.textContent).toContain('Loading');
		} finally {
			unmount(c);
		}
	});
});
