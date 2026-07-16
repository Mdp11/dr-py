// Render smoke test for TableGrid (Task 5): a header per column, a row per
// page row, and cells dispatched by kind. `@testing-library/svelte` is not a
// project dependency, so this follows the repo's established Svelte-5 render
// convention (mount/unmount/flushSync) used by
// `Navigation/__tests__/results-dock.test.ts` rather than the brief's literal
// `@testing-library/svelte` snippet.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TableDefinition, TablePage } from '$lib/api/types';
import { setCurrentUserId } from '$lib/api/identity';
import * as store from '$lib/state/table-editor.svelte';
import { handleFeedEvent, resetRealtime } from '$lib/state/realtime.svelte';
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

const DRAFT: store.TableDraft = {
	name: 't',
	artifactId: null,
	artifactRev: null,
	dirty: false,
	definition: {
		schema_version: 1,
		default_cell_mode: 'collapse',
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'element',
				source: { kind: 'row', chain_index: 0 },
				header: 'Block',
				width_px: null,
				hidden: false
			},
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'Mass',
				mode: 'collapse',
				keep_empty: true,
				header: 'Mass',
				width_px: null,
				hidden: false
			}
		]
	}
};

function render(tabId: string) {
	const component = mount(TableGrid, { target: document.body, props: { tabId } });
	flushSync();
	return component;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
	resetRealtime();
	setCurrentUserId('');
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

	it('renders placeholder rows for un-fetched sparse slots and asks the store to fill them', () => {
		const sparseRows = [PAGE.rows[0], undefined, undefined];
		vi.spyOn(store, 'getTablePage').mockReturnValue({ ...PAGE, rows: sparseRows, total: 3 });
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		const ensure = vi.spyOn(store, 'ensureTableRange').mockImplementation(() => {});
		const c = render('tbl:draft:3');
		try {
			expect(document.querySelectorAll('[data-testid="table-row"]')).toHaveLength(1);
			const placeholders = document.querySelectorAll('[data-testid="table-row-placeholder"]');
			expect(placeholders).toHaveLength(2);
			// One placeholder cell per column, same as a real row.
			expect(placeholders[0].children).toHaveLength(PAGE.columns.length);
			// The range effect requested the window (start clamped to 0).
			expect(ensure).toHaveBeenCalled();
			expect(ensure.mock.calls.at(-1)![1]).toBe(0);
		} finally {
			unmount(c);
		}
	});

	it('double-clicking a resize handle auto-fits the column to an integer width', () => {
		vi.spyOn(store, 'getTablePage').mockReturnValue(PAGE);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		vi.spyOn(store, 'getTableDraft').mockReturnValue(DRAFT);
		const update = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('tbl:draft:fit');
		try {
			const seps = document.querySelectorAll('[data-testid="table-header"] [role="separator"]');
			expect(seps.length).toBe(2);
			seps[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
			flushSync();
			expect(update).toHaveBeenCalledTimes(1);
			const defn = update.mock.calls[0][1] as TableDefinition;
			const w = defn.columns[1].width_px;
			expect(Number.isInteger(w)).toBe(true);
			expect(w).toBeGreaterThanOrEqual(80);
		} finally {
			unmount(c);
		}
	});

	it('gives a row one line per value in its tallest cell', () => {
		const page: TablePage = {
			...PAGE,
			rows: [
				{
					key: ['e1'],
					cells: [
						{
							kind: 'element',
							item: { id: 'e1', type_name: 'Block', display_name: 'B', child_count: 0 }
						},
						{
							kind: 'values',
							present: true,
							values: ['a', 'b', 'c'],
							total: 3,
							truncated: false
						}
					]
				}
			]
		};
		vi.spyOn(store, 'getTablePage').mockReturnValue(page);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		const c = render('tbl:draft:multiline');
		try {
			const row = document.querySelector('[data-testid="table-row"]') as HTMLElement;
			expect(row.style.height).toBe('84px'); // 3 lines * 28
			const lines = row.querySelectorAll('[data-testid="cell-line"]');
			expect(lines.length).toBe(3);
		} finally {
			unmount(c);
		}
	});

	it('gives a truncated single-value cell a value line plus a separate truncation-marker line', () => {
		const page: TablePage = {
			...PAGE,
			rows: [
				{
					key: ['e1'],
					cells: [
						{
							kind: 'element',
							item: { id: 'e1', type_name: 'Block', display_name: 'B', child_count: 0 }
						},
						{
							kind: 'values',
							present: true,
							values: ['a'],
							total: 5,
							truncated: true
						}
					]
				}
			]
		};
		vi.spyOn(store, 'getTablePage').mockReturnValue(page);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		const c = render('tbl:draft:singletruncated');
		try {
			const row = document.querySelector('[data-testid="table-row"]') as HTMLElement;
			expect(row.style.height).toBe('56px'); // 2 lines * 28
			const lines = row.querySelectorAll('[data-testid="cell-line"]');
			expect(lines.length).toBe(2);
			expect(lines[0].textContent).toContain('a');
			expect(lines[1].textContent).toContain('…');
		} finally {
			unmount(c);
		}
	});

	it('tints cells of a locked element: orange for my lock, red for a peer lock', () => {
		vi.spyOn(store, 'getTablePage').mockReturnValue(PAGE);
		vi.spyOn(store, 'getTableLoading').mockReturnValue(false);
		setCurrentUserId('me');
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'me' }]
		});
		const c = render('tbl:draft:lockmine');
		try {
			// both the element (scope) cell and the value cell target e1
			expect(document.querySelectorAll('[data-lock="mine"]').length).toBe(2);
			expect(document.querySelectorAll('[data-lock="theirs"]').length).toBe(0);
		} finally {
			unmount(c);
		}
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'bob', holder_email: 'b@x.io' }]
		});
		const c2 = render('tbl:draft:locktheirs');
		try {
			const theirs = document.querySelectorAll('[data-lock="theirs"]');
			expect(theirs.length).toBe(2);
			expect((theirs[0] as HTMLElement).title).toContain('b@x.io');
		} finally {
			unmount(c2);
		}
	});
});
