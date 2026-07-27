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
import { ensureTableDraft, getTableDraft, setTableSort, updateTableDefinition } from '$lib/state';
import { setColumnJsonOptions } from '$lib/table/columns';
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
	// `_sorts` (unlike the draft's definition) is not reset by re-seeding —
	// clear it so a sort set by one test can't leak into the next test's
	// previewTableJson call args. Done BEFORE restoreAllMocks: setTableSort
	// fire-and-forgets a loadTablePage/evaluateTable call, and this test's
	// evaluateTable mock (from `seed()`) is still installed at this point —
	// after restoreAllMocks that call would hit the real, absent dev backend.
	setTableSort(TAB_ID, undefined);
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

	// Fix round 1, Finding 3: the happy-path preview test above only ever
	// asserts the badge's PRESENCE — a component that rendered
	// json-preview-truncated unconditionally would still pass it. Wait for the
	// same round trip to land (proving the response was actually consulted,
	// not just the `truncated` state's zero-value default) and then assert
	// absence.
	it('hides the truncated badge when the preview response says truncated: false', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			await waitFor(() => testid('json-preview')?.textContent === '[]');
			expect(testid('json-preview-truncated')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	// Fix round 1, Finding 1: `downloadTable` always sends the active grid
	// sort (`_sortFor` in table-editor.svelte.ts), and grouping rolls same-key
	// rows into arrays — a different row ORDER can therefore produce a
	// different grouped SHAPE, not just reordered output. The preview must
	// send the same sort or it can honestly disagree with the download, which
	// is the one thing `POST /tables/json-preview` exists to prevent.
	it('includes the active grid sort in the preview request', async () => {
		await seed();
		setTableSort(TAB_ID, { column: 1, direction: 'asc' });
		flushSync();
		const preview = vi
			.spyOn(tablesApi, 'previewTableJson')
			.mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			await waitFor(() => preview.mock.calls.length > 0);
			expect(preview).toHaveBeenCalledWith(
				expect.objectContaining({ sort: { column: 1, direction: 'asc' } })
			);
		} finally {
			unmount(c);
		}
	});

	// Fix round 1, Finding 1 (regression half): changing the sort AFTER the
	// panel is already open must refresh the preview too — the effect reads
	// `getTableSort` on every run, not just once at mount.
	it('re-fetches the preview when the sort changes while the panel is open', async () => {
		await seed();
		const preview = vi
			.spyOn(tablesApi, 'previewTableJson')
			.mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			await waitFor(() => preview.mock.calls.length > 0);
			expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ sort: undefined }));

			setTableSort(TAB_ID, { column: 0, direction: 'desc' });
			flushSync();
			await waitFor(
				() => preview.mock.calls.at(-1)?.[0]?.sort !== undefined && preview.mock.calls.length > 1
			);
			expect(preview).toHaveBeenLastCalledWith(
				expect.objectContaining({ sort: { column: 0, direction: 'desc' } })
			);
		} finally {
			unmount(c);
		}
	});

	// Fix round 1, Finding 4: the debounce and token guard are correct by
	// inspection, but deleting the `setTimeout` entirely would leave every
	// other test in this file green (they all eventually wait for the single
	// settled call). Pin the call COUNT under rapid edits instead of just the
	// final content.
	it('debounces rapid edits into a single preview call', async () => {
		vi.useFakeTimers();
		try {
			await seed();
			const preview = vi
				.spyOn(tablesApi, 'previewTableJson')
				.mockResolvedValue({ sample: '[]', truncated: false });
			const c = render();
			try {
				const key0 = testid('json-key-0') as HTMLInputElement;
				for (const v of ['n', 'na', 'nam', 'name']) {
					key0.value = v;
					key0.dispatchEvent(new Event('input', { bubbles: true }));
					flushSync();
					// Each edit re-arms the debounce well inside the 300ms window, so
					// none of these advances alone should let a call through.
					await vi.advanceTimersByTimeAsync(100);
				}
				expect(preview).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(300);
				expect(preview).toHaveBeenCalledTimes(1);
				expect(preview).toHaveBeenCalledWith(
					expect.objectContaining({
						definition: expect.objectContaining({
							columns: expect.arrayContaining([
								expect.objectContaining({ json_export: expect.objectContaining({ key: 'name' }) })
							])
						})
					})
				);
			} finally {
				unmount(c);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	// The item key names a grouped column's own value INSIDE its array
	// entries; ungrouped rows have one role and keep the single bare input.
	it('shows the item-key input only once a column is grouped', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		const c = render();
		try {
			expect(testid('json-item-key-1')).toBeNull();
			const box = testid('json-group-1') as HTMLInputElement;
			box.checked = true;
			box.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(testid('json-item-key-1')).not.toBeNull();
			// A collapse column can never group, so it never gets one.
			expect(testid('json-item-key-0')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('writes an edited item key into the definition', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		updateTableDefinition(
			TAB_ID,
			setColumnJsonOptions(defn(), 1, { group: true, key: 'Components' })
		);
		flushSync();
		const c = render();
		try {
			const item = testid('json-item-key-1') as HTMLInputElement;
			item.value = 'One Component';
			item.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			const opts = getTableDraft(TAB_ID)!.definition.columns[1].json_export;
			expect(opts?.item_key).toBe('One Component');
			expect(opts?.key).toBe('Components'); // the group key is untouched
		} finally {
			unmount(c);
		}
	});

	it('placeholds the item key with the resolved group key it falls back to', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		updateTableDefinition(
			TAB_ID,
			setColumnJsonOptions(defn(), 1, { group: true, key: 'Components' })
		);
		flushSync();
		const c = render();
		try {
			expect((testid('json-item-key-1') as HTMLInputElement).placeholder).toBe('Components');
		} finally {
			unmount(c);
		}
	});

	it('snake_cases an explicitly set item key and leaves a blank one blank', async () => {
		await seed();
		vi.spyOn(tablesApi, 'previewTableJson').mockResolvedValue({ sample: '[]', truncated: false });
		updateTableDefinition(
			TAB_ID,
			setColumnJsonOptions(defn(), 1, { group: true, item_key: 'One Component' })
		);
		flushSync();
		const c = render();
		try {
			(testid('json-snake-all') as HTMLButtonElement).click();
			flushSync();
			const cols = getTableDraft(TAB_ID)!.definition.columns;
			expect(cols[1].json_export?.item_key).toBe('one_component');
			// Column 0 never had one: it stays blank and keeps following its key.
			expect(cols[0].json_export?.item_key).toBe('');
		} finally {
			unmount(c);
		}
	});
});
