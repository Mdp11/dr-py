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
//
// The JSON half of this file is the surviving coverage of the deleted
// `JsonExportEditor.test.ts`: the key/item-key/value/group controls, the
// snake_case rule, the truncated badge and the preview's sort+debounce
// contract all moved into `ExportDialog.svelte` verbatim, so their tests moved
// with them (`json-key-N` became `export-name-{pos}`, everything else kept its
// test id).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import * as artifactsApi from '$lib/api/artifacts';
import * as tablesApi from '$lib/api/tables';
import type { TableDefinition } from '$lib/api/types';
import {
	closeTableDraft,
	ensureTableDraft,
	getTableDraft,
	getTableLoading,
	setTableSort,
	updateTableDefinition
} from '$lib/state';
import { setColumnJsonOptions } from '$lib/table/columns';
import ExportDialog from '../ExportDialog.svelte';

const TAB_ID = 'tbl:draft:export-dialog-test';
/** A SAVED table's tab (`tbl:<artifact id>`), the only shape in which the
 *  draft can be clean AND carry real columns — and the shape the dirty-flag
 *  regression actually hurts (see the Cancel tests). */
const SAVED_TAB_ID = 'tbl:art-export-dialog';

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

interface MountOpts {
	tabId?: string;
	onClose?: () => void;
	onExport?: (format: 'xlsx' | 'json') => Promise<void>;
}

/** Mount the dialog over whatever the draft currently holds. Kept apart from
 *  `open()` so a test can drive a PRISTINE draft (one no `updateTableDefinition`
 *  has dirtied) — which is the only state in which "cancelling changes nothing"
 *  is observable. `onExport` has no default in the component (the tab owns the
 *  waiting and the progress reporting), so every mount supplies one. */
function mountDialog(
	format: 'xlsx' | 'json',
	opts: MountOpts = {}
): { target: HTMLElement; component: ReturnType<typeof mount> } {
	const target = document.createElement('div');
	document.body.appendChild(target);
	const component = mount(ExportDialog, {
		target,
		props: {
			tabId: opts.tabId ?? TAB_ID,
			open: true,
			format,
			onClose: opts.onClose ?? (() => {}),
			onExport: opts.onExport ?? (async () => {})
		}
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
	over: Partial<TableDefinition> = {},
	opts: MountOpts = {}
): Promise<{ target: HTMLElement; component: ReturnType<typeof mount> }> {
	await ensureTableDraft(TAB_ID);
	updateTableDefinition(TAB_ID, { ...defn(), ...over });
	return mountDialog(format, opts);
}

/** A CLEAN draft bound to a saved artifact, carrying the same fixture columns.
 *  `ensureTableDraft` on a `tbl:<id>` tab is the only path that produces
 *  `dirty: false` with real columns, and `artifactId` non-null is what makes
 *  the dirty flag load-bearing (`_evaluateSource` switches away from the
 *  backend's per-artifact order cache the moment it flips). */
async function openSaved(format: 'xlsx' | 'json' = 'xlsx'): Promise<void> {
	vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
		id: 'art-export-dialog',
		kind: 'table',
		name: 'Saved table',
		artifact_rev: 3,
		updated_at: '2026-07-28T00:00:00Z',
		updated_by: null,
		entry_points: null,
		payload: defn() as unknown as Record<string, unknown>
	});
	await ensureTableDraft(SAVED_TAB_ID);
	mountDialog(format, { tabId: SAVED_TAB_ID });
}

const current = (): TableDefinition => getTableDraft(TAB_ID)!.definition;
const byTestId = (t: HTMLElement | Document, id: string): HTMLElement =>
	(t as HTMLElement).querySelector(`[data-testid="${id}"]`) as HTMLElement;
const input = (id: string): HTMLInputElement => byTestId(document, id) as HTMLInputElement;

/** Type into an input the way the component's `oninput` handler expects. */
function type(id: string, value: string): void {
	const el = input(id);
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

afterEach(() => {
	closeAll();
	// Drop the whole tab, not just the DOM: `ensureTableDraft` returns the
	// EXISTING draft, so a draft one test dirtied (and the sort it left in
	// `_sorts`) would otherwise be what the next test opens over — and the
	// clean-draft assertions below could never fail. Done BEFORE
	// restoreAllMocks, since it orphans any in-flight load that would
	// otherwise land on the real, absent dev backend.
	closeTableDraft(TAB_ID);
	closeTableDraft(SAVED_TAB_ID);
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
		type('export-name-0', 'Assembly');
		expect(current().columns[0].export?.header).toBe('Assembly');
		expect(current().columns[0].header).toBe('Name');
	});

	it('renaming in json mode writes json_export.key, not export.header', async () => {
		await open('json');
		type('export-name-0', 'assembly');
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
		type('export-name-0', 'Assembly');
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

	// Restoring the definition without restoring `dirty` is a silent
	// regression, not a cosmetic one: the tab keeps its unsaved `*` marker and
	// arms the beforeNavigate guard over a discarded edit, Save would write an
	// identical artifact revision, and `_evaluateSource` abandons the
	// artifact-id path (and with it the backend's per-artifact order cache) for
	// the rest of the session. A VIEWER, who may open this dialog but has no
	// Save button, could never clean it again.
	it('Cancel restores the dirty flag along with the definition', async () => {
		await openSaved('xlsx');
		const before = getTableDraft(SAVED_TAB_ID)!;
		expect(before.dirty).toBe(false);
		expect(before.artifactId).toBe('art-export-dialog');

		byTestId(document, 'export-include-1').click();
		flushSync();
		expect(getTableDraft(SAVED_TAB_ID)!.dirty).toBe(true);

		byTestId(document, 'export-cancel').click();
		flushSync();
		const after = getTableDraft(SAVED_TAB_ID)!;
		expect(after.dirty).toBe(false);
		expect(after.artifactId).toBe('art-export-dialog');
		expect(JSON.stringify(after.definition)).toBe(JSON.stringify(before.definition));
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

	it('Export hands the selected format to the tab that owns the download', async () => {
		const formats: ('xlsx' | 'json')[] = [];
		await open('json', {}, { onExport: async (f) => void formats.push(f) });
		byTestId(document, 'export-confirm').click();
		flushSync();
		expect(formats).toEqual(['json']);
	});

	// `onExport` runs `downloadTable`'s 202/Retry-After loop, which can wait
	// minutes on a script sweep. Awaiting it here would pin the modal open for
	// that whole time, its overlay covering the chrome button that reports the
	// real `Preparing… n/m` progress — and would swallow the close on a failed
	// export too. The download that never settles below is exactly that case:
	// everything asserted after the click is unreachable if the handler awaits.
	it('Export closes the dialog immediately instead of awaiting the download', async () => {
		let closed = false;
		let started = false;
		await open(
			'json',
			{},
			{
				onClose: () => (closed = true),
				onExport: () => {
					started = true;
					return new Promise<void>(() => {}); // never settles
				}
			}
		);
		// An edit that the export must KEEP: closing via Export is not a discard.
		byTestId(document, 'export-include-1').click();
		flushSync();

		byTestId(document, 'export-confirm').click();
		flushSync();
		expect(started).toBe(true);
		expect(closed).toBe(true);
		expect(current().columns[1].export?.include).toBe(false);
	});

	// --- recovered from JsonExportEditor.test.ts -------------------------------

	it('placeholds a json name with the derived key, and nothing for an excluded column', async () => {
		await open('json');
		expect(input('export-name-0').placeholder).toBe('Name');
		// Column 2 is grid-hidden, so the export excludes it by default: it
		// consumes no key at all, which is a blank placeholder rather than a
		// misleading one.
		expect(input('export-name-2').placeholder).toBe('');
	});

	it('offers the group checkbox only on an expand column', async () => {
		await open('json');
		// Column 1 (navigation, mode: expand) gets the checkbox...
		expect(byTestId(document, 'json-group-1')).toBeTruthy();
		// ...column 0 (property, mode: collapse) does not.
		expect(byTestId(document, 'json-group-0')).toBeNull();
	});

	it('toggles grouping, writing group: true into the definition', async () => {
		await open('json');
		const box = input('json-group-1');
		expect(box.checked).toBe(false);
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(current().columns[1].json_export?.group).toBe(true);
	});

	it('offers the value select only on element-producing columns', async () => {
		await open('json');
		// Column 1 is a navigation column — element-producing.
		expect(byTestId(document, 'json-value-1')).toBeTruthy();
		// Column 0 is a plain property column — never element-producing.
		expect(byTestId(document, 'json-value-0')).toBeNull();
	});

	it('writes the picked value mode into the definition', async () => {
		await open('json');
		const select = byTestId(document, 'json-value-1') as HTMLSelectElement;
		select.value = 'id';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(current().columns[1].json_export?.value).toBe('id');
	});

	it('snake_cases every exported column at once and leaves excluded ones untouched', async () => {
		await open('json');
		(byTestId(document, 'json-snake-all') as HTMLButtonElement).click();
		flushSync();
		const cols = current().columns;
		expect(cols[0].json_export?.key).toBe('name');
		expect(cols[1].json_export?.key).toBe('component');
		// Column 2 is excluded from the export: it has no key to rewrite, and
		// none was written.
		expect(cols[2].json_export).toBeUndefined();
	});

	it('snake_cases an explicitly set item key and leaves a blank one blank', async () => {
		await open('json', setColumnJsonOptions(defn(), 1, { group: true, item_key: 'One Component' }));
		(byTestId(document, 'json-snake-all') as HTMLButtonElement).click();
		flushSync();
		const cols = current().columns;
		expect(cols[1].json_export?.item_key).toBe('one_component');
		// Column 0 never had one: it stays blank and keeps following its key.
		expect(cols[0].json_export?.item_key).toBe('');
	});

	// The item key names a grouped column's own value INSIDE its array
	// entries; ungrouped rows have one role and keep the single bare input.
	it('shows the item-key input only once a column is grouped', async () => {
		await open('json');
		expect(byTestId(document, 'json-item-key-1')).toBeNull();
		const box = input('json-group-1');
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(byTestId(document, 'json-item-key-1')).toBeTruthy();
		// A collapse column can never group, so it never gets one.
		expect(byTestId(document, 'json-item-key-0')).toBeNull();
	});

	it('writes an edited item key into the definition', async () => {
		await open('json', setColumnJsonOptions(defn(), 1, { group: true, key: 'Components' }));
		type('json-item-key-1', 'One Component');
		const opts = current().columns[1].json_export;
		expect(opts?.item_key).toBe('One Component');
		expect(opts?.key).toBe('Components'); // the group key is untouched
	});

	it('placeholds the item key with the resolved group key it falls back to', async () => {
		await open('json', setColumnJsonOptions(defn(), 1, { group: true, key: 'Components' }));
		expect(input('json-item-key-1').placeholder).toBe('Components');
	});

	it('renders the server-side preview and shows the truncated badge when truncated', async () => {
		previewSpy.mockResolvedValue({ sample: '[\n  {"Name": "Root"}\n]', truncated: true });
		await open('json');
		await waitFor(() =>
			(byTestId(document, 'json-preview')?.textContent ?? '').includes('"Name": "Root"')
		);
		expect(byTestId(document, 'json-preview').textContent).toContain('"Name": "Root"');
		expect(byTestId(document, 'json-preview-truncated')).toBeTruthy();
	});

	// The happy-path preview test above only ever asserts the badge's PRESENCE
	// — a component that rendered json-preview-truncated unconditionally would
	// still pass it. Wait for the same round trip to land (proving the response
	// was actually consulted, not just the `truncated` state's zero-value
	// default) and then assert absence.
	it('hides the truncated badge when the preview response says truncated: false', async () => {
		await open('json');
		await waitFor(() => byTestId(document, 'json-preview')?.textContent === '[]');
		expect(byTestId(document, 'json-preview-truncated')).toBeNull();
	});

	// `downloadTable` always sends the active grid sort (`_sortFor` in
	// table-editor.svelte.ts), and grouping rolls same-key rows into arrays — a
	// different row ORDER can therefore produce a different grouped SHAPE, not
	// just reordered output. The preview must send the same sort or it can
	// honestly disagree with the download, which is the one thing
	// `POST /tables/json-preview` exists to prevent.
	it('includes the active grid sort in the preview request', async () => {
		await ensureTableDraft(TAB_ID);
		updateTableDefinition(TAB_ID, defn());
		setTableSort(TAB_ID, { column: 1, direction: 'asc' });
		flushSync();
		mountDialog('json');
		await waitFor(() => previewSpy.mock.calls.length > 0);
		expect(previewSpy).toHaveBeenCalledWith(
			expect.objectContaining({ sort: { column: 1, direction: 'asc' } })
		);
	});

	// The regression half: changing the sort AFTER the dialog is open must
	// refresh the preview too — the effect reads `getTableSort` on every run,
	// not just once at mount.
	it('re-fetches the preview when the sort changes while the dialog is open', async () => {
		await open('json');
		await waitFor(() => previewSpy.mock.calls.length > 0);
		expect(previewSpy).toHaveBeenLastCalledWith(expect.objectContaining({ sort: undefined }));

		setTableSort(TAB_ID, { column: 0, direction: 'desc' });
		flushSync();
		await waitFor(
			() =>
				previewSpy.mock.calls.at(-1)?.[0]?.sort !== undefined && previewSpy.mock.calls.length > 1
		);
		expect(previewSpy).toHaveBeenLastCalledWith(
			expect.objectContaining({ sort: { column: 0, direction: 'desc' } })
		);
	});

	// The debounce and token guard are correct by inspection, but deleting the
	// `setTimeout` entirely would leave every other test in this file green
	// (they all eventually wait for the single settled call). Pin the call
	// COUNT under rapid edits instead of just the final content.
	it('debounces rapid edits into a single preview call', async () => {
		vi.useFakeTimers();
		try {
			await ensureTableDraft(TAB_ID);
			updateTableDefinition(TAB_ID, defn());
			mountDialog('json');
			for (const v of ['n', 'na', 'nam', 'name']) {
				type('export-name-0', v);
				// Each edit re-arms the debounce well inside the 300ms window, so
				// none of these advances alone should let a call through.
				await vi.advanceTimersByTimeAsync(100);
			}
			expect(previewSpy).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(300);
			expect(previewSpy).toHaveBeenCalledTimes(1);
			expect(previewSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					definition: expect.objectContaining({
						columns: expect.arrayContaining([
							expect.objectContaining({ json_export: expect.objectContaining({ key: 'name' }) })
						])
					})
				})
			);
		} finally {
			vi.useRealTimers();
		}
	});

	// --- json_split (P-13): one file per element, zipped ----------------------

	it('json mode shows the split section and persists json_split', async () => {
		await open('json');
		const box = input('json-split-enabled');
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		type('json-split-template', 'DataFor${name}');
		expect(current().json_split).toEqual({
			enabled: true,
			filename_template: 'DataFor${name}'
		});
	});

	it('a tokenless template disables confirm and shows the hint', async () => {
		await open('json');
		const box = input('json-split-enabled');
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		type('json-split-template', 'static');
		expect((byTestId(document, 'export-confirm') as HTMLButtonElement).disabled).toBe(true);
		expect(byTestId(document, 'json-split-error').textContent).toContain('${name}');
	});

	it('xlsx mode hides the split section entirely', async () => {
		await open('xlsx');
		expect(byTestId(document, 'json-split-enabled')).toBeNull();
	});
});
