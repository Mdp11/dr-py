// The Reorder dialog edits DISPLAY order only, through the reload-free
// `updateTableDisplayOrder`; the definition's columns never move. Same
// mount/flushSync/unmount convention as the other Table tests.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TableDefinition } from '$lib/api/types';
import * as store from '$lib/state/table-editor.svelte';
import ColumnReorderDialog from '../ColumnReorderDialog.svelte';

function draft(display_order: number[]): store.TableDraft {
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
	const c = mount(ColumnReorderDialog, { target: document.body, props: { tabId, open: true } });
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ColumnReorderDialog', () => {
	it('lists every column (hidden ones included) in display order, by name', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([2, 0]));
		const c = render('t');
		try {
			const rows = [...document.querySelectorAll('[data-testid^="reorder-row-"]')];
			expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
				'reorder-row-2',
				'reorder-row-0',
				'reorder-row-1'
			]);
			// an unnamed column falls back to its label; a hidden one is marked
			expect(rows[0].textContent).toContain('volume');
			expect(rows[2].querySelector('[aria-label="Hidden column"]')).not.toBeNull();
			// no permanent transform on the rows (stacking-context trap)
			expect((rows[0] as HTMLElement).style.transform).toBe('');
		} finally {
			unmount(c);
		}
	});

	it('↓ moves a column one display slot down through updateTableDisplayOrder, leaving the columns alone', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([]));
		const update = vi.spyOn(store, 'updateTableDisplayOrder').mockImplementation(() => {});
		const c = render('t');
		try {
			(document.querySelector('[data-testid="reorder-down-0"]') as HTMLElement).click();
			flushSync();
			expect(update).toHaveBeenCalledTimes(1);
			const defn = update.mock.calls[0][1] as TableDefinition;
			expect(defn.display_order).toEqual([1, 0, 2]);
			expect(defn.columns.map((col) => col.header)).toEqual(['Block', 'Mass', '']);
		} finally {
			unmount(c);
		}
	});

	it('↑ on the first row and ↓ on the last are disabled', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([2, 0, 1]));
		const c = render('t');
		try {
			expect(
				(document.querySelector('[data-testid="reorder-up-2"]') as HTMLButtonElement).disabled
			).toBe(true);
			expect(
				(document.querySelector('[data-testid="reorder-down-1"]') as HTMLButtonElement).disabled
			).toBe(true);
			expect(
				(document.querySelector('[data-testid="reorder-up-0"]') as HTMLButtonElement).disabled
			).toBe(false);
		} finally {
			unmount(c);
		}
	});

	it('Reset empties the display order, and is disabled while it already is', () => {
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([2, 0, 1]));
		const update = vi.spyOn(store, 'updateTableDisplayOrder').mockImplementation(() => {});
		const c = render('t');
		try {
			const reset = document.querySelector('[data-testid="reorder-reset"]') as HTMLButtonElement;
			expect(reset.disabled).toBe(false);
			reset.click();
			flushSync();
			expect((update.mock.calls[0][1] as TableDefinition).display_order).toEqual([]);
		} finally {
			unmount(c);
		}
		vi.spyOn(store, 'getTableDraft').mockReturnValue(draft([]));
		const c2 = render('t2');
		try {
			expect(
				(document.querySelector('[data-testid="reorder-reset"]') as HTMLButtonElement).disabled
			).toBe(true);
		} finally {
			unmount(c2);
		}
	});
});
