// Render tests for the custom-export tab (P-14 task 12b step 3/5). Mirrors the
// mount scaffolding the artifact-editor tab tests use (artifact/checkout
// mocks, `setProjectInfo`) and `SnippetTab.lock-denied.test.ts` (the
// conflict-shape lease stub).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import * as exportsApi from '$lib/api/exports';
import { ConflictError } from '$lib/api/errors';
import { EXPORT_RETRY_MS } from '$lib/util/export-download';
import {
	getCustomExportDraft,
	getStagedArtifactOps,
	isTempId,
	loadArtifacts,
	resetArtifactEdits,
	resetArtifacts,
	resetCheckout,
	resetCustomExportEditors,
	resetWorkspaceTabs,
	setProjectInfo
} from '$lib/state';
import CustomExportTab from '../CustomExportTab.svelte';

/** A promise plus its own resolver, for driving two concurrent fetches to
 *  resolve in a chosen order (the Important-fix regression test below). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const EXPORT_ARTIFACT = {
	id: 'art-1',
	kind: 'custom_export',
	name: 'Drop',
	artifact_rev: 3,
	updated_at: new Date().toISOString(),
	updated_by: null,
	entry_points: null,
	payload: {
		schema_version: 1,
		entries: [{ source: { ref: 'tbl-1' }, name: 'Alpha', format: 'json' }]
	}
};

const TABLE_HEADER = {
	id: 'tbl-2',
	kind: 'table',
	name: 'Beta',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: null
};

const TABLE_ARTIFACT = {
	...TABLE_HEADER,
	payload: {
		schema_version: 1,
		row_source: { kind: 'scope', types: [], criteria: [] },
		columns: [{ kind: 'element', export: { include: false } }]
	}
};

/** Two-entry artifact for the overlapping-"Edit layout"-clicks regression
 *  test: entry 0 points at a 1-column table, entry 1 at a 2-column table, so
 *  the dialog's rendered column count is a direct, DOM-visible tell for
 *  "which table's definition is the panel actually showing" — no reliance on
 *  `overridesFromDefinition`'s null-unless-overridden export fields, which
 *  would make the two tables indistinguishable in the SAVED patch alone. */
const RACE_ARTIFACT = {
	id: 'art-1',
	kind: 'custom_export',
	name: 'Drop',
	artifact_rev: 3,
	updated_at: new Date().toISOString(),
	updated_by: null,
	entry_points: null,
	payload: {
		schema_version: 1,
		entries: [
			{ source: { ref: 'tbl-1' }, name: 'Alpha', format: 'xlsx', columns: [] },
			{ source: { ref: 'tbl-2' }, name: 'Beta', format: 'xlsx', columns: [] }
		]
	}
};

const TABLE_A_ARTIFACT = {
	id: 'tbl-1',
	kind: 'table',
	name: 'A',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: null,
	payload: {
		schema_version: 1,
		row_source: { kind: 'scope', types: [], criteria: [] },
		columns: [{ kind: 'element' }]
	}
};

const TABLE_B_ARTIFACT = {
	id: 'tbl-2',
	kind: 'table',
	name: 'B',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: null,
	payload: {
		schema_version: 1,
		row_source: { kind: 'scope', types: [], criteria: [] },
		columns: [{ kind: 'element' }, { kind: 'element' }]
	}
};

function lockConflict(email: string): ConflictError {
	return new ConflictError(
		409,
		{
			conflicts: [
				{ resource_id: 'art:art-1', held_by: 'u2', held_by_email: email, held_mode: 'exclusive' }
			]
		},
		'lock conflict'
	);
}

let mounted: ReturnType<typeof mount>[] = [];
let acquireSpy: MockInstance<typeof checkoutApi.acquireLocks>;
let getArtifactSpy: MockInstance<typeof artifactsApi.getArtifact>;

beforeEach(() => {
	resetArtifacts();
	resetWorkspaceTabs();
	resetCheckout();
	resetCustomExportEditors();
	resetArtifactEdits();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	getArtifactSpy = vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(EXPORT_ARTIFACT);
	acquireSpy = vi.spyOn(checkoutApi, 'acquireLocks').mockImplementation(async (req) => {
		const token = `t_${req.targets[0].resource_id}`;
		return {
			token,
			leases: req.targets.map((t) => ({
				resource_id: t.type === 'artifact' ? `art:${t.resource_id}` : t.resource_id,
				mode: t.mode,
				holder: 'me',
				token,
				intent: req.intent,
				expires_at: 1
			}))
		};
	});
});

afterEach(() => {
	for (const m of mounted) unmount(m);
	mounted = [];
	document.body.innerHTML = '';
	resetCustomExportEditors();
	resetArtifactEdits();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function render(tabId: string): HTMLElement {
	const host = mount(CustomExportTab, { target: document.body, props: { tabId } });
	mounted.push(host);
	flushSync();
	return document.body;
}

describe('CustomExportTab', () => {
	it('renders entries from a saved artifact and stages edits on save', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		const host = mount(CustomExportTab, {
			target: document.body,
			props: { tabId: 'exp:art-1' }
		});
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);
		const name = document.querySelector<HTMLInputElement>('[data-testid="export-entry-0"] input')!;
		name.value = 'Renamed';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		document.querySelector<HTMLButtonElement>('[data-testid="custom-export-save"]')!.click();
		flushSync();
		// `{kind: 'update_artifact'}` alone would pass even if the name input
		// were never wired to `updateExportEntry` (saveCustomExportDraft stages
		// unconditionally) — assert the payload actually carries the edit.
		expect(getStagedArtifactOps()[0]).toMatchObject({
			kind: 'update_artifact',
			payload: { entries: [{ name: 'Renamed' }] }
		});
		unmount(host);
	});

	it('add-table picker copies the picked table export options at add time, independent of the table', async () => {
		getArtifactSpy.mockImplementation((id: string) =>
			id === 'art-1' ? Promise.resolve(EXPORT_ARTIFACT) : Promise.resolve(TABLE_ARTIFACT)
		);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [TABLE_HEADER] });
		await loadArtifacts();

		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const select = document.querySelector<HTMLSelectElement>('[data-testid="add-table-select"]')!;
		expect(select).not.toBeNull();
		select.value = 'tbl-2';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		await vi.waitFor(() => expect(getCustomExportDraft('exp:art-1')!.entries.length).toBe(2));
		expect(getCustomExportDraft('exp:art-1')!.entries[1].columns).toEqual([
			{ index: 0, export: { include: false, header: '' }, json_export: null }
		]);
	});

	it('gates the export button on a dirty/unsaved draft and runs the 202-retry download loop once clean', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const name = document.querySelector<HTMLInputElement>('[data-testid="export-entry-0"] input')!;
		const runBtn = document.querySelector<HTMLButtonElement>('[data-testid="custom-export-run"]')!;

		name.value = 'Renamed';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(runBtn.disabled).toBe(true);

		document.querySelector<HTMLButtonElement>('[data-testid="custom-export-save"]')!.click();
		flushSync();
		expect(runBtn.disabled).toBe(false);

		vi.useFakeTimers();
		const blob = new Blob(['x'], { type: 'application/zip' });
		const runSpy = vi
			.spyOn(exportsApi, 'runCustomExport')
			.mockResolvedValueOnce({ kind: 'preparing', done: 1, total: 2 })
			.mockResolvedValueOnce({ kind: 'ready', blob, filename: 'Drop.zip' });
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		runBtn.click();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		await vi.advanceTimersByTimeAsync(EXPORT_RETRY_MS);
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		expect(runSpy).toHaveBeenCalledTimes(2);
	});

	it('a peer lease conflict shows the read-only banner and disables entry inputs', async () => {
		acquireSpy.mockImplementation(() => Promise.reject(lockConflict('peer@x')));
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		expect(document.body.textContent).toContain('Checked out by peer@x');
		const name = document.querySelector<HTMLInputElement>('[data-testid="export-entry-0"] input')!;
		expect(name.disabled).toBe(true);
	});

	it('keeps the export button disabled for a saved-but-uncommitted (temp-id) draft', async () => {
		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="custom-export-save"]')).toBeTruthy()
		);
		const runBtn = document.querySelector<HTMLButtonElement>('[data-testid="custom-export-run"]')!;
		expect(runBtn.disabled).toBe(true); // never saved at all: artifactId null

		document.querySelector<HTMLButtonElement>('[data-testid="custom-export-save"]')!.click();
		flushSync();

		const draft = getCustomExportDraft('exp:draft:1')!;
		expect(draft.dirty).toBe(false);
		expect(draft.artifactId).not.toBeNull();
		// A staged create's id names nothing server-side until the batch
		// commits — clean AND non-null is not enough; it must be a REAL id.
		expect(isTempId(draft.artifactId!)).toBe(true);
		expect(runBtn.disabled).toBe(true);
	});

	// Regression (Important, task 12b fix round 1): two "Edit layout" clicks
	// on DIFFERENT rows before either fetch resolves used to race. Whichever
	// fetch resolved LAST won `editDefinition`/`editEntryIndex`, but if
	// `editLayoutOpen` had already flipped true from the FIRST resolution,
	// the already-mounted `EntryLayoutDialog` only got new PROPS, never a
	// remount — so its `effective` `$state` (captured once, by design) stayed
	// frozen on the FIRST entry's table while the dialog claimed to be
	// editing the SECOND. Save then wrote the first table's layout into the
	// second entry's slot: a persisted cross-wire.
	it('a second Edit-layout click before the first fetch resolves does not cross-wire the saved patch', async () => {
		const defA = deferred<typeof TABLE_A_ARTIFACT>();
		const defB = deferred<typeof TABLE_B_ARTIFACT>();
		getArtifactSpy.mockImplementation((id: string) => {
			if (id === 'art-1') return Promise.resolve(RACE_ARTIFACT);
			if (id === 'tbl-1') return defA.promise;
			if (id === 'tbl-2') return defB.promise;
			return Promise.reject(new Error(`unexpected id ${id}`));
		});
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-1"]')).toBeTruthy()
		);

		// Both clicks land before EITHER fetch resolves — nothing is open yet
		// to block the second click.
		document.querySelector<HTMLButtonElement>('[data-testid="export-entry-0-layout"]')!.click();
		document.querySelector<HTMLButtonElement>('[data-testid="export-entry-1-layout"]')!.click();

		// Entry 0's fetch (table A, 1 column) resolves FIRST — this is what
		// used to open the dialog prematurely on the stale entry.
		defA.resolve(TABLE_A_ARTIFACT);
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		// Entry 1's fetch (table B, 2 columns) resolves SECOND.
		defB.resolve(TABLE_B_ARTIFACT);
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="entry-layout-dialog"]')).toBeTruthy()
		);
		// The panel must reflect table B's TWO columns, not table A's stale
		// ONE — the direct, DOM-visible symptom of the frozen `effective`.
		expect(document.querySelector('[data-testid="export-include-0"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="export-include-1"]')).not.toBeNull();

		document.querySelector<HTMLButtonElement>('[data-testid="export-include-1"]')!.click();
		flushSync();
		document.querySelector<HTMLButtonElement>('[data-testid="entry-layout-save"]')!.click();
		flushSync();

		const draft = getCustomExportDraft('exp:art-1')!;
		expect(draft.entries[1].columns).toEqual([
			{ index: 1, export: { include: false, header: '' }, json_export: null }
		]);
		// And entry 0 — the STALE entry the buggy code would have targeted —
		// must be untouched.
		expect(draft.entries[0].columns).toEqual([]);
	});
});
