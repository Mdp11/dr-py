// The Sorting dialog edits the definition's `sort` (a priority list of
// column keys with a direction each) through `updateTableDefinition`, since
// a new order needs a re-evaluation. Same mount/flushSync/unmount convention
// as the other Table tests.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SortKey, TableDefinition } from '$lib/api/types';
import * as store from '$lib/state/table-editor.svelte';
import ColumnSortDialog from '../ColumnSortDialog.svelte';

function draft(sort: SortKey[], display_order: number[] = []): store.TableDraft {
	return {
		name: 't',
		artifactId: null,
		artifactRev: null,
		dirty: false,
		definition: {
			schema_version: 1,
			default_cell_mode: 'collapse',
			show_row_numbers: false,
			export_order: [],
			display_order,
			sort,
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
					name: 'mass',
					mode: 'collapse',
					keep_empty: true,
					header: 'Mass',
					width_px: null,
					hidden: true
				},
				{
					kind: 'property',
					source: { kind: 'row', chain_index: 0 },
					name: 'volume',
					mode: 'collapse',
					keep_empty: true,
					header: '',
					width_px: null,
					hidden: false
				}
			]
		}
	};
}

function render(tabId: string) {
	const c = mount(ColumnSortDialog, { target: document.body, props: { tabId, open: true } });
	flushSync();
	return c;
}

function rowIds(): (string | null)[] {
	return [...document.querySelectorAll('[data-testid^="sort-row-"]')].map((r) =>
		r.getAttribute('data-testid')
	);
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ColumnSortDialog', () => {
	it('lists the sort keys first in priority order, then the unsorted columns in display order', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			draft([{ column: 2, direction: 'desc' }], [1, 0, 2])
		);
		const c = render('t');
		try {
			expect(rowIds()).toEqual(['sort-row-2', 'sort-row-1', 'sort-row-0']);
			const on = document.querySelector('[data-testid="sort-toggle-2"]') as HTMLInputElement;
			const off = document.querySelector('[data-testid="sort-toggle-0"]') as HTMLInputElement;
			expect(on.checked).toBe(true);
			expect(off.checked).toBe(false);
			// only a sorting column has a direction and priority controls
			expect(document.querySelector('[data-testid="sort-dir-2"]')?.textContent).toContain('▼');
			expect(document.querySelector('[data-testid="sort-dir-0"]')).toBeNull();
			expect(document.querySelector('[data-testid="sort-up-0"]')).toBeNull();
			// an unnamed column falls back to its label
			expect(document.querySelector('[data-testid="sort-row-2"]')?.textContent).toContain('volume');
		} finally {
			unmount(c);
		}
	});

	it('ticking an unsorted column appends it as the last ascending key', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([{ column: 2, direction: 'desc' }]));
		const update = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			(document.querySelector('[data-testid="sort-toggle-0"]') as HTMLInputElement).click();
			flushSync();
			expect(update).toHaveBeenCalledTimes(1);
			const defn = update.mock.calls[0][1] as TableDefinition;
			expect(defn.sort).toEqual([
				{ column: 2, direction: 'desc' },
				{ column: 0, direction: 'asc' }
			]);
			expect(defn.columns.map((col) => col.header)).toEqual(['Block', 'Mass', '']);
		} finally {
			unmount(c);
		}
	});

	it('the direction button flips a key, ↓ lowers its priority', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(
			draft([
				{ column: 0, direction: 'asc' },
				{ column: 1, direction: 'asc' }
			])
		);
		const update = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			(document.querySelector('[data-testid="sort-dir-0"]') as HTMLElement).click();
			flushSync();
			expect((update.mock.calls[0][1] as TableDefinition).sort).toEqual([
				{ column: 0, direction: 'desc' },
				{ column: 1, direction: 'asc' }
			]);
			(document.querySelector('[data-testid="sort-down-0"]') as HTMLElement).click();
			flushSync();
			expect((update.mock.calls[1][1] as TableDefinition).sort).toEqual([
				{ column: 1, direction: 'asc' },
				{ column: 0, direction: 'asc' }
			]);
			expect(
				(document.querySelector('[data-testid="sort-down-1"]') as HTMLButtonElement).disabled
			).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('Reset clears every key and is disabled when nothing sorts', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([{ column: 1, direction: 'asc' }]));
		const update = vi.spyOn(store, 'updateTableDefinition').mockImplementation(() => {});
		const c = render('t');
		try {
			(document.querySelector('[data-testid="sort-reset"]') as HTMLElement).click();
			flushSync();
			expect((update.mock.calls[0][1] as TableDefinition).sort).toEqual([]);
		} finally {
			unmount(c);
		}
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([]));
		const c2 = render('t2');
		try {
			expect(
				(document.querySelector('[data-testid="sort-reset"]') as HTMLButtonElement).disabled
			).toBe(true);
		} finally {
			unmount(c2);
		}
	});
});
