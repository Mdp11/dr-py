// Render tests for the exporter tab. Mirrors the mount scaffolding the
// artifact-editor tab tests use (artifact/checkout mocks, `setProjectInfo`)
// and `SnippetTab.lock-denied.test.ts` (the conflict-shape lease stub).
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as checkoutApi from '$lib/api/checkout';
import * as exportsApi from '$lib/api/exports';
import { ConflictError } from '$lib/api/errors';
import { TableDefinitionSchema } from '$lib/api/types';
import { EXPORT_RETRY_MS } from '$lib/util/export-download';
import {
	addExporterEntry,
	getExporterDraft,
	getStagedArtifactOps,
	isTempId,
	loadArtifacts,
	resetArtifactEdits,
	resetArtifacts,
	resetCheckout,
	resetExporterEditors,
	resetWorkspaceTabs,
	setProjectInfo,
	stageArtifactCreate
} from '$lib/state';
import ExporterTab from '../ExporterTab.svelte';

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
	kind: 'exporter',
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

/** A committed code_snippet artifact whose server-derived entry_points cover
 *  `transform` — the transform picker's option pool. */
const TRANSFORM_SNIPPET_HEADER = {
	id: 'snip-1',
	kind: 'code_snippet',
	name: 'Redact PII',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: ['script', 'transform']
};

/** Two headers with names chosen so "par" matches one and not the other —
 *  the add-table picker's typeahead test fixture. */
const PARTS_HEADER = {
	id: 'tbl-parts',
	kind: 'table',
	name: 'parts',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: null
};

const BUILDINGS_HEADER = {
	id: 'tbl-buildings',
	kind: 'table',
	name: 'buildings',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: null
};

const PARTS_ARTIFACT = {
	...PARTS_HEADER,
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
	kind: 'exporter',
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
	resetExporterEditors();
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
	resetExporterEditors();
	resetArtifactEdits();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function render(tabId: string): HTMLElement {
	const host = mount(ExporterTab, { target: document.body, props: { tabId } });
	mounted.push(host);
	flushSync();
	return document.body;
}

describe('ExporterTab', () => {
	it('renders entries from a saved artifact and stages edits on save', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		const host = mount(ExporterTab, {
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
		document.querySelector<HTMLButtonElement>('[data-testid="exporter-save"]')!.click();
		flushSync();
		// `{kind: 'update_artifact'}` alone would pass even if the name input
		// were never wired to `updateExporterEntry` (saveExporterDraft stages
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

		const input = document.querySelector<HTMLInputElement>('[data-testid="add-table-input"]')!;
		expect(input).not.toBeNull();
		input.value = 'Beta';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();

		await vi.waitFor(() => expect(getExporterDraft('exp:art-1')!.entries.length).toBe(2));
		expect(getExporterDraft('exp:art-1')!.entries[1].columns).toEqual([
			{ index: 0, export: { include: false, header: '' }, json_export: null }
		]);
	});

	it('runs the 202-retry download loop for a clean committed draft (Export stays enabled while dirty)', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const name = document.querySelector<HTMLInputElement>('[data-testid="export-entry-0"] input')!;
		const runBtn = document.querySelector<HTMLButtonElement>('[data-testid="exporter-run"]')!;

		name.value = 'Renamed';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		// Export is deliberately ungated on dirty/uncommitted state — only
		// emptiness disables it, and this draft still has its one entry.
		expect(runBtn.disabled).toBe(false);

		document.querySelector<HTMLButtonElement>('[data-testid="exporter-save"]')!.click();
		flushSync();
		expect(runBtn.disabled).toBe(false);

		vi.useFakeTimers();
		const blob = new Blob(['x'], { type: 'application/zip' });
		const runSpy = vi
			.spyOn(exportsApi, 'runExporter')
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

	it('keeps the export button disabled for a saved-but-uncommitted (temp-id) draft with no entries', async () => {
		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="exporter-save"]')).toBeTruthy()
		);
		const runBtn = document.querySelector<HTMLButtonElement>('[data-testid="exporter-run"]')!;
		expect(runBtn.disabled).toBe(true); // no entries yet — the one remaining gate

		document.querySelector<HTMLButtonElement>('[data-testid="exporter-save"]')!.click();
		flushSync();

		const draft = getExporterDraft('exp:draft:1')!;
		expect(draft.dirty).toBe(false);
		expect(draft.artifactId).not.toBeNull();
		// A staged create's id names nothing server-side until the batch
		// commits, but temp-id state does not gate Export at all (ungated on
		// dirty/uncommitted) — the button stays disabled here only because the
		// draft still has zero entries.
		expect(isTempId(draft.artifactId!)).toBe(true);
		expect(runBtn.disabled).toBe(true);
	});

	// Two "Edit layout" clicks on DIFFERENT rows before either fetch resolves
	// must not race. Whichever fetch resolves LAST must win
	// `editDefinition`/`editEntryIndex` — if `editLayoutOpen` had already
	// flipped true from the FIRST resolution, the already-mounted
	// `EntryLayoutDialog` would only get new PROPS, never a remount, so its
	// `effective` `$state` (captured once, by design) would stay frozen on
	// the FIRST entry's table while the dialog claimed to be editing the
	// SECOND. Save would then write the first table's layout into the second
	// entry's slot: a persisted cross-wire.
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

		// Entry 0's fetch (table A, 1 column) resolves FIRST — a naive
		// implementation would open the dialog prematurely on this stale entry.
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

		const draft = getExporterDraft('exp:art-1')!;
		expect(draft.entries[1].columns).toEqual([
			{ index: 1, export: { include: false, header: '' }, json_export: null }
		]);
		// And entry 0 — the STALE entry the buggy code would have targeted —
		// must be untouched.
		expect(draft.entries[0].columns).toEqual([]);
	});

	it('renders output controls and stages edits through them', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const filename = document.querySelector<HTMLInputElement>('[data-testid="exporter-filename"]')!;
		expect(filename.placeholder).toBe('Drop'); // the artifact's name
		filename.value = 'release-${rev}';
		filename.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		document.querySelector<HTMLButtonElement>('[data-testid="exporter-mode-bare"]')!.click();
		flushSync();

		const manifest = document.querySelector<HTMLInputElement>('[data-testid="exporter-manifest"]')!;
		expect(manifest.checked).toBe(true); // schema default
		manifest.checked = false;
		manifest.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		expect(getExporterDraft('exp:art-1')!.output).toEqual({
			mode: 'bare',
			filename: 'release-${rev}',
			manifest: false
		});
	});

	it('renders a folder input per entry', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const folder = document.querySelector<HTMLInputElement>(
			'[data-testid="export-entry-0-folder"]'
		)!;
		expect(folder.placeholder).toBe('folder/in/zip');
		folder.value = 'nested/path';
		folder.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		expect(getExporterDraft('exp:art-1')!.entries[0].folder).toBe('nested/path');
	});

	// A disabled input swallows clicks with no event and no console output —
	// exactly the "Add table… does not work" report against a project with no
	// committed tables. The empty picker must SAY why it is dead, and
	// distinguish "no tables at all" from "your table is staged but not
	// committed yet" (temp ids are filtered by design — see
	// referenceableArtifactHeaders).
	it('explains the disabled add-table picker when the project has no tables', async () => {
		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="add-table-input"]')).toBeTruthy()
		);
		const input = document.querySelector<HTMLInputElement>('[data-testid="add-table-input"]')!;
		expect(input.disabled).toBe(true);
		const hint = document.querySelector('[data-testid="add-table-empty-hint"]')!;
		expect(hint).not.toBeNull();
		expect(hint.textContent).toMatch(/no tables/i);
	});

	it('explains the disabled add-table picker when the only tables are staged, uncommitted creates', async () => {
		stageArtifactCreate(
			'table',
			'Staged table',
			{ schema_version: 1, row_source: { kind: 'scope' }, columns: [{ kind: 'element' }] },
			null
		);
		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="add-table-input"]')).toBeTruthy()
		);
		const input = document.querySelector<HTMLInputElement>('[data-testid="add-table-input"]')!;
		expect(input.disabled).toBe(true);
		const hint = document.querySelector('[data-testid="add-table-empty-hint"]')!;
		expect(hint).not.toBeNull();
		expect(hint.textContent).toMatch(/commit/i);
	});

	it('allows adding the same table twice', async () => {
		getArtifactSpy.mockImplementation((id: string) =>
			id === 'art-1' ? Promise.resolve(EXPORT_ARTIFACT) : Promise.resolve(TABLE_ARTIFACT)
		);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [TABLE_HEADER] });
		await loadArtifacts();

		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const input = document.querySelector<HTMLInputElement>('[data-testid="add-table-input"]')!;
		input.value = 'Beta';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		await vi.waitFor(() => expect(getExporterDraft('exp:art-1')!.entries.length).toBe(2));

		// The just-used table must still be offered by the picker: there is no
		// usedRefs filter; duplicate entries are legal.
		input.value = 'Beta';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.querySelector('[data-testid="add-table-option-tbl-2"]')).not.toBeNull();

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();
		await vi.waitFor(() => expect(getExporterDraft('exp:art-1')!.entries.length).toBe(3));

		expect(
			getExporterDraft('exp:art-1')!.entries.filter((e) => e.source.ref === 'tbl-2')
		).toHaveLength(2);
	});

	it('renders csv/jsonl format toggles per entry and stages the picked format', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		expect(document.querySelector('[data-testid="export-entry-0-format-csv"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="export-entry-0-format-jsonl"]')).not.toBeNull();

		document.querySelector<HTMLButtonElement>('[data-testid="export-entry-0-format-csv"]')!.click();
		flushSync();

		expect(getExporterDraft('exp:art-1')!.entries[0].format).toBe('csv');
	});

	// Export is deliberately ungated on dirty/temp-id state — a dirty or
	// never-committed draft exports by sending `definition` inline instead.
	it('exports a dirty draft by sending the definition inline', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const name = document.querySelector<HTMLInputElement>('[data-testid="export-entry-0"] input')!;
		name.value = 'Renamed';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(getExporterDraft('exp:art-1')!.dirty).toBe(true);

		const runBtn = document.querySelector<HTMLButtonElement>('[data-testid="exporter-run"]')!;
		expect(runBtn.disabled).toBe(false);

		const blob = new Blob(['x'], { type: 'application/zip' });
		const draftSpy = vi
			.spyOn(exportsApi, 'runExporterDraft')
			.mockResolvedValue({ kind: 'ready', blob, filename: 'Drop.zip' });
		const runSpy = vi.spyOn(exportsApi, 'runExporter');
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		runBtn.click();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		expect(runSpy).not.toHaveBeenCalled();
		expect(draftSpy).toHaveBeenCalledTimes(1);
		const [definitionArg, nameArg] = draftSpy.mock.calls[0];
		expect(definitionArg.entries.length).toBe(1);
		// The whole point of the draft path: the uncommitted rename actually
		// travels in the sent definition, not just the entry count.
		expect(definitionArg.entries[0].name).toBe('Renamed');
		expect(nameArg).toBe(getExporterDraft('exp:art-1')!.name);
	});

	// A clean, committed draft still runs by artifact id — identical content,
	// but the manifest then carries the real artifact id.
	it('exports a clean committed draft by artifact id', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);
		expect(getExporterDraft('exp:art-1')!.dirty).toBe(false);
		expect(isTempId(getExporterDraft('exp:art-1')!.artifactId!)).toBe(false);

		const runBtn = document.querySelector<HTMLButtonElement>('[data-testid="exporter-run"]')!;
		expect(runBtn.disabled).toBe(false);

		const blob = new Blob(['x'], { type: 'application/zip' });
		const runSpy = vi
			.spyOn(exportsApi, 'runExporter')
			.mockResolvedValue({ kind: 'ready', blob, filename: 'Drop.zip' });
		const draftSpy = vi.spyOn(exportsApi, 'runExporterDraft');
		vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

		runBtn.click();
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		expect(draftSpy).not.toHaveBeenCalled();
		expect(runSpy).toHaveBeenCalledTimes(1);
		expect(runSpy).toHaveBeenCalledWith('art-1');
	});

	it('disables Export only while the draft has no entries', async () => {
		getArtifactSpy.mockImplementation((id: string) =>
			id === 'art-1' ? Promise.resolve(EXPORT_ARTIFACT) : Promise.resolve(TABLE_ARTIFACT)
		);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [TABLE_HEADER] });
		await loadArtifacts();

		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="exporter-save"]')).toBeTruthy()
		);
		const runBtn = document.querySelector<HTMLButtonElement>('[data-testid="exporter-run"]')!;
		expect(runBtn.disabled).toBe(true);
		expect(runBtn.title).toBe('Add at least one table first');

		addExporterEntry(
			'exp:draft:1',
			'tbl-2',
			'Beta',
			TableDefinitionSchema.parse(TABLE_ARTIFACT.payload)
		);
		flushSync();

		const draft = getExporterDraft('exp:draft:1')!;
		expect(draft.entries.length).toBe(1);
		expect(draft.dirty).toBe(true); // still dirty/uncommitted…
		expect(runBtn.disabled).toBe(false); // …which does not gate Export
		expect(runBtn.title).toBe('');
	});

	// The add-table control is a searchable typeahead (AddTablePicker.svelte)
	// that filters client-side over the in-memory committed-table headers.
	it('filters the add-table picker as the user types', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [PARTS_HEADER, BUILDINGS_HEADER]
		});
		await loadArtifacts();

		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="add-table-input"]')).toBeTruthy()
		);

		const input = document.querySelector<HTMLInputElement>('[data-testid="add-table-input"]')!;
		input.value = 'par';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();

		expect(document.querySelector('[data-testid="add-table-option-tbl-parts"]')).not.toBeNull();
		expect(document.querySelector('[data-testid="add-table-option-tbl-buildings"]')).toBeNull();
	});

	it('adds the active option on Enter and allows a duplicate add', async () => {
		getArtifactSpy.mockImplementation((id: string) =>
			id === 'tbl-parts'
				? Promise.resolve(PARTS_ARTIFACT)
				: Promise.reject(new Error(`unexpected id ${id}`))
		);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [PARTS_HEADER, BUILDINGS_HEADER]
		});
		await loadArtifacts();

		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="add-table-input"]')).toBeTruthy()
		);
		const input = document.querySelector<HTMLInputElement>('[data-testid="add-table-input"]')!;

		input.value = 'par';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();

		await vi.waitFor(() => expect(getExporterDraft('exp:draft:1')!.entries.length).toBe(1));
		expect(document.querySelector('[data-testid="export-entry-0"]')).not.toBeNull();

		// Duplicates are legal and useful — the same table added twice.
		input.value = 'par';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		flushSync();

		await vi.waitFor(() => expect(getExporterDraft('exp:draft:1')!.entries.length).toBe(2));
		expect(document.querySelector('[data-testid="export-entry-1"]')).not.toBeNull();
		expect(
			getExporterDraft('exp:draft:1')!.entries.filter((e) => e.source.ref === 'tbl-parts')
		).toHaveLength(2);
	});

	it('closes the picker on Escape without adding', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [PARTS_HEADER, BUILDINGS_HEADER]
		});
		await loadArtifacts();

		render('exp:draft:1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="add-table-input"]')).toBeTruthy()
		);
		const input = document.querySelector<HTMLInputElement>('[data-testid="add-table-input"]')!;

		input.value = 'par';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.querySelector('[data-testid="add-table-option-tbl-parts"]')).not.toBeNull();

		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		flushSync();

		expect(document.querySelector('[data-testid="add-table-option-tbl-parts"]')).toBeNull();
		expect(getExporterDraft('exp:draft:1')!.entries.length).toBe(0);
	});

	// The transform picker rides in each entry row, gated on the entry's own
	// format — never a whole-artifact setting.
	it('a json-family entry row renders the transform picker and picking a snippet patches the entry', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [TRANSFORM_SNIPPET_HEADER]
		});
		await loadArtifacts();

		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		// EXPORT_ARTIFACT's one entry is already format: 'json'.
		const picker = document.querySelector<HTMLSelectElement>('[data-testid="transform-picker"]')!;
		expect(picker).not.toBeNull();

		picker.value = 'snip-1';
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		const draft = getExporterDraft('exp:art-1')!;
		expect(draft.entries[0].transform).toEqual({ ref: 'snip-1' });
		expect(draft.dirty).toBe(true);
	});

	it('an xlsx/csv entry row hides the transform picker', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		document
			.querySelector<HTMLButtonElement>('[data-testid="export-entry-0-format-xlsx"]')!
			.click();
		flushSync();

		expect(document.querySelector('[data-testid="transform-picker"]')).toBeNull();
	});

	it('an xlsx entry that still carries a transform (format flipped after picking) shows the warning instead of hiding the state', async () => {
		getArtifactSpy.mockResolvedValue(EXPORT_ARTIFACT);
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [TRANSFORM_SNIPPET_HEADER]
		});
		await loadArtifacts();

		render('exp:art-1');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="export-entry-0"]')).toBeTruthy()
		);

		const picker = document.querySelector<HTMLSelectElement>('[data-testid="transform-picker"]')!;
		picker.value = 'snip-1';
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(getExporterDraft('exp:art-1')!.entries[0].transform).toEqual({ ref: 'snip-1' });

		document
			.querySelector<HTMLButtonElement>('[data-testid="export-entry-0-format-xlsx"]')!
			.click();
		flushSync();

		expect(document.querySelector('[data-testid="transform-picker"]')).toBeNull();
		const warning = document.querySelector('[data-testid="export-entry-0-transform-warning"]');
		expect(warning).not.toBeNull();
		expect(warning!.textContent).toMatch(/transform/i);
		// The state survives the format flip — never silently cleared.
		expect(getExporterDraft('exp:art-1')!.entries[0].transform).toEqual({ ref: 'snip-1' });
	});
});
