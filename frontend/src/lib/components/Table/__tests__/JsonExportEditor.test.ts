// Render tests for the JSON-export settings tab (Task 11). Follows the
// repo's established Svelte-5 render convention (mount/unmount/flushSync)
// used by `Table/__tests__/ColumnManager.test.ts` and `TableGrid.test.ts`
// rather than the brief's literal `@testing-library/svelte` snippet — that
// package is not a project dependency.
//
// Drives the REAL table-editor store (ensureTableDraft + updateTableDefinition
// from `$lib/state`, seeded like ColumnManager.test.ts's `seedForClone`)
// instead of spying on `$lib/state/table-editor.svelte` directly: the
// component imports `getTableDraft`/`updateTableDefinition` from the `$lib/state`
// BARREL, and driving the real store end to end is the only way to be certain
// the assertions below are observing what the component actually wrote —
// spying on the wrong module path (table-editor.svelte, not the barrel) would
// silently no-op instead of failing loudly.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import type { TableDefinition } from '$lib/api/types';
import { ensureTableDraft, getTableDraft, updateTableDefinition } from '$lib/state';
import JsonExportEditor from '../JsonExportEditor.svelte';

const TAB_ID = 'tbl:draft:json-export-test';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1,
	warnings: []
};

function defn(): TableDefinition {
	return {
		schema_version: 1,
		row_source: { kind: 'scope', types: ['Block'], criteria: [] },
		columns: [
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'name',
				mode: 'collapse',
				keep_empty: true,
				header: 'Name',
				hidden: false
			},
			{
				kind: 'navigation',
				source: { kind: 'row', chain_index: 0 },
				navigation: {},
				mode: 'expand',
				keep_empty: true,
				sort_mode: 'value',
				cell_cap: 20,
				header: 'Component',
				hidden: false
			},
			{
				kind: 'property',
				source: { kind: 'row', chain_index: 0 },
				name: 'mass',
				mode: 'collapse',
				keep_empty: true,
				header: 'Hidden',
				hidden: true
			}
		],
		default_cell_mode: 'collapse',
		show_row_numbers: false
	} as TableDefinition;
}

// updateTableDefinition fire-and-forgets a page reload (loadTablePage), so
// evaluateTable is stubbed here — same as ColumnManager.test.ts's
// seedForClone — to keep the run free of a real, unmocked network call
// against the (absent) dev backend.
async function seed(): Promise<void> {
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
	await ensureTableDraft(TAB_ID);
	updateTableDefinition(TAB_ID, defn());
	flushSync();
}

function render(): ReturnType<typeof mount> {
	const c = mount(JsonExportEditor, { target: document.body, props: { tabId: TAB_ID } });
	flushSync();
	return c;
}

/** Wait up to ms for predicate to be truthy, polling every 10 ms — the same
 *  idiom `TableView.test.ts` uses to wait out the settings dialog's deferred
 *  close animation; here it waits out the component's 300 ms debounced
 *  preview fetch (a real setTimeout, not a mock). */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
		flushSync();
	}
}

function testid(id: string): HTMLElement | null {
	return document.querySelector(`[data-testid="${id}"]`);
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('JsonExportEditor', () => {
	it('shows the derived key as a placeholder and skips hidden columns entirely', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			const key0 = testid('json-key-0') as HTMLInputElement;
			expect(key0).not.toBeNull();
			expect(key0.placeholder).toBe('Name');
			// Column 2 is hidden — no row is rendered for it at all.
			expect(testid('json-key-2')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('writes an edited key into the definition', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			const key0 = testid('json-key-0') as HTMLInputElement;
			key0.value = 'name';
			key0.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			expect(getTableDraft(TAB_ID)!.definition.columns[0].json_export?.key).toBe('name');
		} finally {
			unmount(c);
		}
	});

	it('offers the group checkbox only on an expand column', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			// Column 1 (navigation, mode: expand) gets the checkbox...
			expect(testid('json-group-1')).not.toBeNull();
			// ...column 0 (property, mode: collapse) does not.
			expect(testid('json-group-0')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('toggles grouping, writing group: true into the definition', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			const box = testid('json-group-1') as HTMLInputElement;
			expect(box.checked).toBe(false);
			box.checked = true;
			box.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(getTableDraft(TAB_ID)!.definition.columns[1].json_export?.group).toBe(true);
		} finally {
			unmount(c);
		}
	});

	it('offers the value select only on element-producing columns', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			// Column 1 is a navigation column — element-producing.
			expect(testid('json-value-1')).not.toBeNull();
			// Column 0 is a plain property column — never element-producing.
			expect(testid('json-value-0')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('snake_cases every visible column at once and leaves hidden columns untouched', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			const btn = testid('json-snake-all') as HTMLButtonElement;
			btn.click();
			flushSync();
			const cols = getTableDraft(TAB_ID)!.definition.columns;
			expect(cols[0].json_export?.key).toBe('name');
			expect(cols[1].json_export?.key).toBe('component');
			// Column 2 is hidden: it has no key to rewrite, and none was written.
			expect(cols[2].json_export).toBeUndefined();
		} finally {
			unmount(c);
		}
	});

	it('renders the server-side preview and shows the truncated badge when truncated', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({
			sample: '[\n  {"Name": "Root"}\n]',
			truncated: true
		});
		const c = render();
		try {
			await waitFor(() => (testid('json-preview')?.textContent ?? '').includes('"Name": "Root"'));
			expect(testid('json-preview')!.textContent).toContain('"Name": "Root"');
			expect(testid('json-preview-truncated')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});
});
