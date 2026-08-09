import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as bundleApi from '$lib/api/artifact-bundle';
import { StalePlanImportError } from '$lib/api/artifact-bundle';
import { ConflictError } from '$lib/api/errors';
import * as artifactsApi from '$lib/api/artifacts';
import { openImportArtifacts, resetArtifacts, setImportArtifactsOpen } from '$lib/state';
import type { ArtifactBundle, ImportPlan } from '$lib/api/artifact-bundle';
import ImportArtifactsDialog from '../ImportArtifactsDialog.svelte';

const BUNDLE: ArtifactBundle = {
	format: 'datarover.artifact-bundle/v1',
	exported_at: '2026-08-09T00:00:00Z',
	source_project: { id: 'src', name: 'City' },
	roots: ['n1'],
	artifacts: [
		{ id: 'n1', kind: 'navigation', name: 'Bus routes', payload: {} },
		{ id: 's1', kind: 'code_snippet', name: 'helpers', payload: {} }
	]
};

const PLAN: ImportPlan = {
	entries: [
		{
			bundle_id: 'n1',
			kind: 'navigation',
			name: 'Bus routes',
			action: 'create',
			existing_id: null,
			copy_name: null
		},
		{
			bundle_id: 's1',
			kind: 'code_snippet',
			name: 'helpers',
			action: 'copy',
			existing_id: 'x9',
			copy_name: 'helpers (2)'
		}
	],
	skipped: [{ bundle_id: 'd1', reason: 'unknown kind' }]
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetArtifacts();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(ImportArtifactsDialog, { target: host });
	openImportArtifacts();
	flushSync();
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setImportArtifactsOpen(false);
	host.remove();
	vi.restoreAllMocks();
});

async function pickBundle(json: string, name = 'fleet.bundle.json'): Promise<void> {
	const input = document.body.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
	const file = new File([json], name, { type: 'application/json' });
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
	// file.text() + importPlan are async — let both microtasks settle. Matches
	// ANY plan row (not just n1's) — the brief's literal `import-row-n1`
	// selector never resolves for the rev:null test, whose mocked plan holds
	// only the s1 entry; see task-5-report.md for the RED evidence.
	await vi.waitFor(() => {
		if (
			!document.body.querySelector(
				'[data-testid^="import-row-"], [data-testid="import-parse-error"]'
			)
		)
			throw new Error('not settled');
	});
	flushSync();
}

describe('ImportArtifactsDialog', () => {
	it('rejects a malformed file inline without calling the server', async () => {
		const plan = vi.spyOn(bundleApi, 'importPlan');
		const input = document.body.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
		const file = new File(['{"format":"nope"}'], 'x.json');
		Object.defineProperty(input, 'files', { value: [file], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-parse-error"]'))
				throw new Error('pending');
		});
		expect(plan).not.toHaveBeenCalled();
	});

	it('renders the plan with per-row legal actions and the copy rename box', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		await pickBundle(JSON.stringify(BUNDLE));
		const createSel = document.body.querySelector<HTMLSelectElement>(
			'[data-testid="import-action-n1"]'
		)!;
		expect([...createSel.options].map((o) => o.value)).toEqual(['create', 'copy']);
		const copySel = document.body.querySelector<HTMLSelectElement>(
			'[data-testid="import-action-s1"]'
		)!;
		expect([...copySel.options].map((o) => o.value)).toEqual(['copy', 'reuse']);
		expect(
			document.body.querySelector<HTMLInputElement>('[data-testid="import-name-s1"]')!.value
		).toBe('helpers (2)');
		expect(document.body.querySelector('[data-testid="import-skipped"]')?.textContent).toContain(
			'unknown kind'
		);
	});

	it('sends only user-edited copy names and shows the result', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		const confirm = vi.spyOn(bundleApi, 'importConfirm').mockResolvedValue({
			rev: 5,
			created: [
				{ bundle_id: 'n1', id: 'a', name: 'Bus routes' },
				{ bundle_id: 's1', id: 'b', name: 'helpers (2)' }
			],
			reused: [],
			skipped: PLAN.skipped
		});
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-result"]')) throw new Error('pending');
		});
		const arg = confirm.mock.calls[0][0];
		expect(arg.copyNames).toEqual({}); // untouched proposal NOT sent
		expect(arg.decisions).toEqual({ n1: 'create', s1: 'copy' });
	});

	it('re-renders from the fresh plan on a stale-plan 409', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		const freshPlan: ImportPlan = {
			entries: [
				{
					bundle_id: 'n1',
					kind: 'navigation',
					name: 'Bus routes',
					action: 'reuse',
					existing_id: 'e1',
					copy_name: 'Bus routes (2)'
				},
				PLAN.entries[1]
			],
			skipped: []
		};
		vi.spyOn(bundleApi, 'importConfirm').mockRejectedValue(
			new StalePlanImportError('import plan is stale: name taken', freshPlan)
		);
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-banner"]')) throw new Error('pending');
		});
		flushSync();
		expect(document.body.querySelector('[data-testid="import-banner"]')?.textContent).toContain(
			'stale'
		);
		// n1's fresh legal set is reuse/copy — the old 'create' default is gone
		const sel = document.body.querySelector<HTMLSelectElement>('[data-testid="import-action-n1"]')!;
		expect([...sel.options].map((o) => o.value)).toEqual(['reuse', 'copy']);
	});

	it('re-plans from the held bundle on a plan-less 409', async () => {
		const plan = vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		vi.spyOn(bundleApi, 'importConfirm').mockRejectedValue(
			new ConflictError(409, { detail: 'conflict', model_rev: 3 }, 'conflict')
		);
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-banner"]')) throw new Error('pending');
		});
		expect(plan).toHaveBeenCalledTimes(2); // pick + re-plan
		expect(document.body.querySelector('[data-testid="import-banner"]')?.textContent).toContain(
			'concurrently'
		);
	});

	it('renders rev:null as a successful no-op', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue({
			entries: [PLAN.entries[1]],
			skipped: []
		});
		vi.spyOn(bundleApi, 'importConfirm').mockResolvedValue({
			rev: null,
			created: [],
			reused: [{ bundle_id: 's1', existing_id: 'x9' }],
			skipped: []
		});
		await pickBundle(JSON.stringify(BUNDLE));
		const sel = document.body.querySelector<HTMLSelectElement>('[data-testid="import-action-s1"]')!;
		sel.value = 'reuse';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-result"]')) throw new Error('pending');
		});
		expect(document.body.querySelector('[data-testid="import-result"]')?.textContent).toContain(
			'Nothing to import'
		);
	});

	// Behavior contract: "Closing the dialog resets ALL local state". None of
	// the tests above exercise this — beforeEach/afterEach unmount the
	// component before ever toggling the store closed on a live instance — so
	// drive open -> populated review -> closed -> reopened on one instance and
	// assert the dialog is back at a blank pick phase, not review/result.
	it('closing the dialog resets local state back to the pick phase', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		await pickBundle(JSON.stringify(BUNDLE));
		expect(document.body.querySelector('[data-testid="import-row-n1"]')).not.toBeNull();

		setImportArtifactsOpen(false);
		flushSync();
		setImportArtifactsOpen(true);
		flushSync();

		expect(document.body.querySelector('[data-testid="import-file"]')).not.toBeNull();
		expect(document.body.querySelector('[data-testid="import-row-n1"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="import-banner"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="import-parse-error"]')).toBeNull();
	});
});
