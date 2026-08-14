// Render tests for the custom-export tab (P-14 task 12b step 3/5). Mirrors the
// mount scaffolding of `Workspace.export-button.test.ts` (artifact/checkout
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
	loadArtifacts,
	resetArtifactEdits,
	resetArtifacts,
	resetCheckout,
	resetCustomExportEditors,
	resetWorkspaceTabs,
	setProjectInfo
} from '$lib/state';
import CustomExportTab from '../CustomExportTab.svelte';

const EXPORT_ARTIFACT = {
	id: 'art-1',
	kind: 'custom_export',
	name: 'Drop',
	artifact_rev: 3,
	updated_at: new Date().toISOString(),
	updated_by: null,
	entry_points: null,
	payload: { schema_version: 1, entries: [{ source: { ref: 'tbl-1' }, name: 'Alpha', format: 'json' }] }
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
		const name = document.querySelector<HTMLInputElement>(
			'[data-testid="export-entry-0"] input'
		)!;
		name.value = 'Renamed';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		document
			.querySelector<HTMLButtonElement>('[data-testid="custom-export-save"]')!
			.click();
		flushSync();
		expect(getStagedArtifactOps()[0]).toMatchObject({ kind: 'update_artifact' });
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

		const name = document.querySelector<HTMLInputElement>(
			'[data-testid="export-entry-0"] input'
		)!;
		const runBtn = document.querySelector<HTMLButtonElement>(
			'[data-testid="custom-export-run"]'
		)!;

		name.value = 'Renamed';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(runBtn.disabled).toBe(true);

		document
			.querySelector<HTMLButtonElement>('[data-testid="custom-export-save"]')!
			.click();
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
		const name = document.querySelector<HTMLInputElement>(
			'[data-testid="export-entry-0"] input'
		)!;
		expect(name.disabled).toBe(true);
	});
});
