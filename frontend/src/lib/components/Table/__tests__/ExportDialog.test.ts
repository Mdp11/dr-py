// Render tests for the export settings dialog (Task 7). Follows the repo's
// established Svelte-5 render convention (mount/unmount/flushSync) used by
// `Table/__tests__/ColumnManager.test.ts` and `TableGrid.test.ts` rather than
// `@testing-library/svelte` — that package is not a project dependency.
//
// Drives the REAL table-editor store (ensureTableDraft + updateTableDefinition
// from `$lib/state`) instead of spying on `$lib/state/table-editor.svelte.ts`
// directly: the component imports `getTableDraft`/`updateTableDefinition` from
// the `$lib/state` BARREL, and driving the real store end to end is the only
// way to be certain the assertions below observe what the component actually
// wrote — spying on the wrong module path (table-editor.svelte.ts, not the
// barrel) would silently no-op instead of failing loudly.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import * as tablesApi from '$lib/api/tables';
import type { TableDefinition } from '$lib/api/types';
import * as state from '$lib/state';
import {
	closeTableDraft,
	ensureTableDraft,
	getTableDraft,
	getTableLoading,
	updateTableDefinition
} from '$lib/state';
import ExportDialog from '../ExportDialog.svelte';

const TAB_ID = 'tbl:draft:export-dialog-test';

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
		show_row_numbers: false,
		export_order: []
	} as TableDefinition;
}

// updateTableDefinition fire-and-forgets a page reload (loadTablePage) and the
// dialog's JSON mode fires a debounced preview — both are stubbed here so the
// run is free of real, unmocked network calls against the (absent) dev backend.
let previewSpy: MockInstance<typeof tablesApi.previewTableJson>;
beforeEach(() => {
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
	previewSpy = vi
		.spyOn(tablesApi, 'previewTableJson')
		.mockResolvedValue({ sample: '[]', truncated: false });
});

/** Wait up to ms for predicate to be truthy, polling every 10 ms — the idiom
 *  `TableView.test.ts` uses; here it waits out the component's 300 ms debounced
 *  preview fetch (a real setTimeout, not a mock). */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
		flushSync();
	}
}

let mounted: ReturnType<typeof mount>[] = [];

/** Mount the dialog over whatever the draft currently holds. Kept apart from
 *  `open()` so a test can drive a PRISTINE draft (one no `updateTableDefinition`
 *  has dirtied) — which is the only state in which "cancelling changes nothing"
 *  is observable. */
function mountDialog(format: 'xlsx' | 'json'): {
	target: HTMLElement;
	component: ReturnType<typeof mount>;
} {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(ExportDialog, {
		target,
		props: { tabId: TAB_ID, open: true, format, onClose: () => {} }
	});
	flushSync();
	mounted.push(component);
	return { target, component };
}

/** Close every dialog this test opened. Two live dialogs over one tabId means
 *  two snapshot effects on the same draft — never what a test means to set up. */
function closeAll(): void {
	for (const c of mounted) unmount(c);
	mounted = [];
	document.body.innerHTML = '';
}

async function open(
	format: 'xlsx' | 'json' = 'xlsx',
	over: Partial<TableDefinition> = {}
): Promise<{ target: HTMLElement; component: ReturnType<typeof mount> }> {
	await ensureTableDraft(TAB_ID);
	updateTableDefinition(TAB_ID, { ...defn(), ...over });
	return mountDialog(format);
}

const current = (): TableDefinition => getTableDraft(TAB_ID)!.definition;
const byTestId = (t: HTMLElement | Document, id: string): HTMLElement =>
	(t as HTMLElement).querySelector(`[data-testid="${id}"]`) as HTMLElement;

afterEach(() => {
	closeAll();
	// Drop the whole tab, not just the DOM: `ensureTableDraft` returns the
	// EXISTING draft, so a draft one test dirtied (and the sort it left in
	// `_sorts`) would otherwise be what the next test opens over — and the
	// clean-draft assertions below could never fail. Done BEFORE
	// restoreAllMocks, since it orphans any in-flight load that would
	// otherwise land on the real, absent dev backend.
	closeTableDraft(TAB_ID);
	vi.restoreAllMocks();
});

describe('ExportDialog', () => {
	it('lists every column, grid-hidden ones included', async () => {
		const d = defn();
		d.columns[1].hidden = true;
		await open('xlsx', d);
		expect(byTestId(document, 'export-name-0')).toBeTruthy();
		expect(byTestId(document, 'export-name-1')).toBeTruthy();
		expect(byTestId(document, 'export-name-2')).toBeTruthy();
	});

	it('the eye toggle writes export.include and leaves hidden alone', async () => {
		await open('xlsx');
		byTestId(document, 'export-include-1').click();
		flushSync();
		expect(current().columns[1].export?.include).toBe(false);
		expect(current().columns[1].hidden).toBe(false);
	});

	it('renaming in xlsx mode writes export.header, not header', async () => {
		await open('xlsx');
		const input = byTestId(document, 'export-name-0') as HTMLInputElement;
		input.value = 'Assembly';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(current().columns[0].export?.header).toBe('Assembly');
		expect(current().columns[0].header).toBe('Name');
	});

	it('renaming in json mode writes json_export.key, not export.header', async () => {
		await open('json');
		const input = byTestId(document, 'export-name-0') as HTMLInputElement;
		input.value = 'assembly';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(current().columns[0].json_export?.key).toBe('assembly');
		expect(current().columns[0].export?.header ?? '').toBe('');
	});

	it('shows the row-number entry only when show_row_numbers is on', async () => {
		await open('xlsx');
		expect(document.body.textContent).not.toContain('Row number');
		updateTableDefinition(TAB_ID, { ...current(), show_row_numbers: true });
		flushSync();
		expect(document.body.textContent).toContain('Row number');
	});

	it('shows the json extras only in json mode', async () => {
		// Column 1 of the fixture is an expand navigation column, so `group` is
		// honored there — that is the row the extras must appear on.
		await open('xlsx');
		expect(byTestId(document, 'json-group-1')).toBeNull();
		expect(byTestId(document, 'json-value-1')).toBeNull();
		// Unmount before re-opening: two live dialogs on one tabId would each
		// hold their own snapshot of the same draft.
		closeAll();
		await open('json');
		expect(byTestId(document, 'json-group-1')).toBeTruthy();
		expect(byTestId(document, 'json-value-1')).toBeTruthy();
	});

	// Export settings change the FILE, never the grid, so no edit here may kick
	// a whole-table evaluate. `evaluateTable` is the store's own dependency
	// (`table-editor.svelte.ts` imports it), and the real store is what these
	// tests drive — so the spy sees exactly the requests the component caused.
	it('an export-settings edit reloads no table page', async () => {
		await open('xlsx');
		const evaluate = vi.mocked(tablesApi.evaluateTable);
		evaluate.mockClear(); // the seeding updateTableDefinition above fired one
		byTestId(document, 'export-include-1').click();
		flushSync();
		const input = byTestId(document, 'export-name-0') as HTMLInputElement;
		input.value = 'Assembly';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		// The edits landed...
		expect(current().columns[1].export?.include).toBe(false);
		expect(current().columns[0].export?.header).toBe('Assembly');
		// ...and cost nothing: no request, and no "busy" pulse on the tab.
		await new Promise((r) => setTimeout(r, 0));
		expect(evaluate).not.toHaveBeenCalled();
		expect(getTableLoading(TAB_ID)).toBe(false);
	});

	// The bug this pins: `cancel()` used to write the snapshot back
	// unconditionally, and every definition write sets `dirty`. Opening the
	// dialog on a saved, clean table and dismissing it therefore left the table
	// unsaved — with an enabled Save button and one wasted evaluate — over an
	// edit the user never made. A pristine draft is the only state that shows
	// it, hence `ensureTableDraft` alone here (no seeding write).
	it('Cancel with no edits writes nothing and leaves the draft clean', async () => {
		await ensureTableDraft(TAB_ID);
		const before = getTableDraft(TAB_ID)!;
		expect(before.dirty).toBe(false);
		mountDialog('xlsx');
		byTestId(document, 'export-cancel').click();
		flushSync();
		await new Promise((r) => setTimeout(r, 0));
		// Same draft OBJECT: not merely "clean again", but never written at all.
		expect(getTableDraft(TAB_ID)).toBe(before);
		expect(getTableDraft(TAB_ID)!.dirty).toBe(false);
		expect(vi.mocked(tablesApi.evaluateTable)).not.toHaveBeenCalled();
	});

	it('Cancel restores the definition captured when the dialog opened', async () => {
		await open('xlsx');
		const before = JSON.stringify(current());
		byTestId(document, 'export-include-1').click();
		flushSync();
		expect(JSON.stringify(current())).not.toBe(before);
		byTestId(document, 'export-cancel').click();
		flushSync();
		expect(JSON.stringify(current())).toBe(before);
	});

	// The preview is a WHOLE-TABLE build on the server; an xlsx export must
	// never pay for one. Switching to JSON in the same test proves the wait
	// above was long enough to have caught a call, so the absence is real.
	it('builds no JSON preview in xlsx mode, and one as soon as JSON is picked', async () => {
		await open('xlsx');
		await new Promise((r) => setTimeout(r, 400)); // past the 300 ms debounce
		flushSync();
		expect(previewSpy).not.toHaveBeenCalled();
		byTestId(document, 'export-format-json').click();
		flushSync();
		await waitFor(() => previewSpy.mock.calls.length > 0);
	});

	it('Export downloads in the selected format', async () => {
		const spy = vi.spyOn(state, 'downloadTable').mockResolvedValue(undefined);
		await open('json');
		byTestId(document, 'export-confirm').click();
		flushSync();
		expect(spy).toHaveBeenCalledWith(TAB_ID, expect.objectContaining({ format: 'json' }));
	});
});
