import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as bundleApi from '$lib/api/artifact-bundle';
import { StalePlanImportError } from '$lib/api/artifact-bundle';
import { ConflictError } from '$lib/api/errors';
import * as artifactsApi from '$lib/api/artifacts';
import { openImportArtifacts, resetArtifacts, setImportArtifactsOpen } from '$lib/state';
import type { ArtifactBundle, ImportConfirmResponse, ImportPlan } from '$lib/api/artifact-bundle';
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

/** A promise plus its resolve/reject, for controlling exactly when an async
 * continuation settles relative to a close/reopen in the tests below. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (v: T) => void;
	reject: (e: unknown) => void;
} {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

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
	// ANY plan row (not just n1's), since the rev:null test's mocked plan holds
	// only the s1 entry.
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

	// The file input's `value` must be cleared after a parse error, or
	// re-picking the SAME filename never fires `change` again (browsers don't
	// dispatch `change` for an unchanged `value`). Simulate that literally:
	// dispatch `change` a second time with the identical File object and
	// require the dialog to react.
	it('clears the file input after a parse error so re-picking the same filename re-fires change', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		const input = document.body.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
		const bad = new File(['{"format":"nope"}'], 'x.json');
		Object.defineProperty(input, 'files', { value: [bad], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-parse-error"]'))
				throw new Error('pending');
		});
		expect(input.value).toBe(''); // the fix under test

		// The user "fixed" the file on disk and re-picks the identical filename.
		const fixed = new File([JSON.stringify(BUNDLE)], 'x.json', { type: 'application/json' });
		Object.defineProperty(input, 'files', { value: [fixed], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await vi.waitFor(() => {
			if (!document.body.querySelector('[data-testid="import-row-n1"]')) throw new Error('pending');
		});
		expect(document.body.querySelector('[data-testid="import-parse-error"]')).toBeNull();
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

	// The "differs from existing" hint must be gated on the PLAN's own action,
	// not the user's current selection — a `create` row (n1) flipped to Copy
	// has no existing row to differ from, while s1's plan action really is
	// 'copy' and should keep the hint.
	it('does not show "differs from existing" for a create row flipped to copy', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		await pickBundle(JSON.stringify(BUNDLE));
		const n1Row = document.body.querySelector('[data-testid="import-row-n1"]')!;
		const sel = n1Row.querySelector<HTMLSelectElement>('[data-testid="import-action-n1"]')!;
		sel.value = 'copy';
		sel.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		// n1 (plan action 'create', flipped to 'copy'): rename box shows, hint doesn't.
		expect(n1Row.querySelector('[data-testid="import-name-n1"]')).not.toBeNull();
		expect(n1Row.textContent).not.toContain('differs from existing');

		// s1 (plan action really is 'copy'): the hint is still shown.
		const s1Row = document.body.querySelector('[data-testid="import-row-s1"]')!;
		expect(s1Row.textContent).toContain('differs from existing');
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

		// The normal (non-null-rev) success render: created NAME LIST, reused
		// COUNT, and the skipped list repeat — the three things the contract
		// names for phase `result`. A regression that silently dropped the
		// "Created" heading, the name list, or the "N reused" text must fail
		// here rather than only being caught by the separate rev:null test.
		const resultText = document.body.querySelector('[data-testid="import-result"]')?.textContent;
		expect(resultText).toContain('Bus routes'); // created[0].name
		expect(resultText).toContain('helpers (2)'); // created[1].name
		expect(resultText).toContain('0 reused'); // reused.length
		expect(resultText).toContain('d1 — unknown kind'); // skipped list repeat
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

	// Close the dialog WHILE importConfirm is pending, let it resolve only
	// AFTER the close, then reopen — the reopened dialog must land on a blank
	// pick phase, not the stale import's result screen.
	it('a confirm that settles after close does not leak its result into the reopened dialog', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		const confirmDeferred = deferred<ImportConfirmResponse>();
		vi.spyOn(bundleApi, 'importConfirm').mockReturnValue(confirmDeferred.promise);
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		flushSync();

		// Close while the confirm request is still in flight.
		setImportArtifactsOpen(false);
		flushSync();

		// Only now does the stale request settle, well after the close.
		confirmDeferred.resolve({
			rev: 5,
			created: [{ bundle_id: 'n1', id: 'a', name: 'Bus routes' }],
			reused: [],
			skipped: []
		});
		await confirmDeferred.promise;
		await Promise.resolve(); // flush the .then continuation
		flushSync();

		setImportArtifactsOpen(true);
		flushSync();

		expect(document.body.querySelector('[data-testid="import-file"]')).not.toBeNull();
		expect(document.body.querySelector('[data-testid="import-result"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="import-row-n1"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="import-banner"]')).toBeNull();
	});

	// A reset-on-open alone cannot prevent this — only a generation guard can.
	// Reopen BEFORE the stale 409 settles, then let it reject: a leaked
	// `banner` write is INVISIBLE while `phase` stays 'pick' (the banner
	// paragraph only renders in the review phase), so the only way to observe
	// the corruption is to pick a FRESH bundle afterward and assert that
	// fresh review has no banner from the abandoned import.
	it('a stale-plan 409 that settles after a close-then-reopen does not leak a banner onto the next picked bundle', async () => {
		vi.spyOn(bundleApi, 'importPlan').mockResolvedValue(PLAN);
		const confirmDeferred = deferred<ImportConfirmResponse>();
		vi.spyOn(bundleApi, 'importConfirm').mockReturnValue(confirmDeferred.promise);
		await pickBundle(JSON.stringify(BUNDLE));
		document.body.querySelector<HTMLButtonElement>('[data-testid="import-submit"]')!.click();
		flushSync();

		setImportArtifactsOpen(false);
		flushSync();
		setImportArtifactsOpen(true);
		flushSync();

		// The reopened dialog is already fresh, BEFORE the stale request settles.
		expect(document.body.querySelector('[data-testid="import-file"]')).not.toBeNull();
		expect(document.body.querySelector('[data-testid="import-banner"]')).toBeNull();

		// Now the stale request rejects with a stale-plan 409 — without the
		// generation guard this silently repopulates plan/decisions/banner
		// underneath the already-reopened, already-fresh dialog (invisibly,
		// since phase is still 'pick').
		confirmDeferred.reject(
			new StalePlanImportError('import plan is stale: name taken', {
				entries: [PLAN.entries[1]],
				skipped: []
			})
		);
		await confirmDeferred.promise.catch(() => {});
		await Promise.resolve();
		flushSync();

		// Pick a brand new bundle in the same (still-open) dialog instance —
		// this is what would surface the leaked banner, once phase flips to
		// 'review' for an entirely unrelated import.
		await pickBundle(JSON.stringify(BUNDLE));
		expect(document.body.querySelector('[data-testid="import-row-n1"]')).not.toBeNull();
		expect(document.body.querySelector('[data-testid="import-banner"]')).toBeNull();
	});

	// Same shape as above, for onFilePicked's importPlan await: close while the
	// PLAN request (not the confirm) is in flight, let it settle after the
	// close, then reopen — the reopened dialog must not land in the review
	// phase with the old bundle's plan.
	it('an importPlan that settles after close does not leak a stale plan into the reopened dialog', async () => {
		const planDeferred = deferred<ImportPlan>();
		vi.spyOn(bundleApi, 'importPlan').mockReturnValue(planDeferred.promise);
		const input = document.body.querySelector<HTMLInputElement>('[data-testid="import-file"]')!;
		const file = new File([JSON.stringify(BUNDLE)], 'fleet.bundle.json', {
			type: 'application/json'
		});
		Object.defineProperty(input, 'files', { value: [file], configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		// Let File#text() + parseBundleText settle so onFilePicked reaches the
		// (still-pending) importPlan await.
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		setImportArtifactsOpen(false);
		flushSync();

		planDeferred.resolve(PLAN);
		await planDeferred.promise;
		await Promise.resolve();
		flushSync();

		setImportArtifactsOpen(true);
		flushSync();

		expect(document.body.querySelector('[data-testid="import-file"]')).not.toBeNull();
		expect(document.body.querySelector('[data-testid="import-row-n1"]')).toBeNull();
	});
});
