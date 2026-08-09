import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import * as bundleApi from '$lib/api/artifact-bundle';
import * as fileSave from '$lib/util/fileSave';
import {
	getExportArtifactsOpen,
	loadArtifacts,
	openExportArtifacts,
	resetArtifacts,
	setExportArtifactsOpen,
	stageArtifactUpdate
} from '$lib/state';
import ExportArtifactsDialog from '../ExportArtifactsDialog.svelte';

const HEADERS = [
	{
		id: 'n1',
		kind: 'navigation',
		name: 'Bus routes',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null
	},
	{
		id: 't1',
		kind: 'table',
		name: 'Fleet table',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null
	},
	{
		id: 's1',
		kind: 'code_snippet',
		name: 'helpers',
		artifact_rev: 1,
		updated_at: '',
		updated_by: null,
		entry_points: null
	}
];

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
	vi.useFakeTimers();
	resetArtifacts();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: HEADERS });
	await loadArtifacts();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setExportArtifactsOpen(false);
	host.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function open(seed: string[] = []) {
	app = mount(ExportArtifactsDialog, { target: host });
	openExportArtifacts(seed);
	flushSync();
}

function rowCheckbox(id: string): HTMLInputElement {
	const el = document.body.querySelector<HTMLInputElement>(
		`[data-testid="export-row-${id}"] input`
	);
	if (!el) throw new Error(`row ${id} not rendered`);
	return el;
}

describe('ExportArtifactsDialog', () => {
	it('debounces one preview per selection settle and badges dependencies', async () => {
		const preview = vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({
			artifacts: [
				{ id: 'n1', kind: 'navigation', name: 'Bus routes' },
				{ id: 's1', kind: 'code_snippet', name: 'helpers' }
			],
			dangling_refs: ['ghost']
		});
		open();
		rowCheckbox('n1').click();
		flushSync();
		expect(preview).not.toHaveBeenCalled(); // debounced
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(preview).toHaveBeenCalledTimes(1);
		expect(preview).toHaveBeenCalledWith(['n1']);
		// s1 is in the closure but unchecked -> dependency badge
		expect(document.body.querySelector('[data-testid="export-row-s1"]')?.textContent).toContain(
			'dependency'
		);
		expect(document.body.textContent).toContain('1 dangling');
	});

	it('seeded open pre-checks and previews immediately', async () => {
		const preview = vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({
			artifacts: [{ id: 't1', kind: 'table', name: 'Fleet table' }],
			dangling_refs: []
		});
		open(['t1', 'not-a-real-id']);
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(rowCheckbox('t1').checked).toBe(true);
		expect(preview).toHaveBeenCalledWith(['t1']); // unknown id dropped
	});

	it('filter narrows rows but selection persists and is reported', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open(['n1']);
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const filter = document.body.querySelector<HTMLInputElement>('[data-testid="export-filter"]')!;
		filter.value = 'fleet';
		filter.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.body.querySelector('[data-testid="export-row-n1"]')).toBeNull();
		expect(document.body.querySelector('[data-testid="export-row-t1"]')).not.toBeNull();
		expect(document.body.textContent).toContain('+1 selected not shown');
	});

	it('exports checked roots and closes; empty selection disables the button', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		const resp = new Response('{}');
		const exp = vi.spyOn(bundleApi, 'exportBundle').mockResolvedValue(resp);
		const save = vi
			.spyOn(fileSave, 'saveResponseToFile')
			.mockResolvedValue({ filename: 'artifacts.bundle.json', handle: null });
		open();
		const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="export-submit"]')!;
		expect(btn.disabled).toBe(true);
		rowCheckbox('n1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(btn.disabled).toBe(false);
		btn.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(exp).toHaveBeenCalledWith(['n1']);
		expect(save).toHaveBeenCalledWith(resp, 'artifacts.bundle.json');
	});

	// Regression for review finding #1: getCommittedArtifactHeaders() is a
	// genuinely reactive $state that changes on ANY committed artifact
	// create/rename/delete — including a peer's commit arriving over the
	// realtime feed while this dialog stays open. The seeding effect must not
	// resubscribe to it, or an unrelated headers change would wipe every
	// checkbox the user had already toggled and re-seed from the stale
	// original seed array.
	it('a committed-headers change while open does not wipe the live selection', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open();
		rowCheckbox('n1').click();
		flushSync();
		expect(rowCheckbox('n1').checked).toBe(true);

		// Simulate a peer's commit landing while the dialog is still open: the
		// committed-headers store changes underneath the mounted dialog.
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [
				...HEADERS,
				{
					id: 'n2',
					kind: 'navigation',
					name: 'New route',
					artifact_rev: 1,
					updated_at: '',
					updated_by: null,
					entry_points: null
				}
			]
		});
		await loadArtifacts();
		flushSync();

		// The new row renders (headers ARE live)...
		expect(document.body.querySelector('[data-testid="export-row-n2"]')).not.toBeNull();
		// ...but the user's own toggle survived: no re-seed happened.
		expect(rowCheckbox('n1').checked).toBe(true);
	});

	// Review finding #2: the preview-rejection branch was previously
	// unexercised.
	it('a rejected preview call renders an inline alert', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockRejectedValue(new Error('boom'));
		open();
		rowCheckbox('n1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const alert = document.body.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Could not compute the bundle preview.');
	});

	// Review finding #2: the AbortError-is-silent branch was previously
	// unexercised.
	it('a cancelled save picker (AbortError) is silent and keeps the dialog open', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		vi.spyOn(bundleApi, 'exportBundle').mockResolvedValue(new Response('{}'));
		vi.spyOn(fileSave, 'saveResponseToFile').mockRejectedValue(
			new DOMException('The user aborted a request.', 'AbortError')
		);
		open();
		rowCheckbox('n1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="export-submit"]')!;
		btn.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(getExportArtifactsOpen()).toBe(true);
		expect(document.body.querySelector('[role="alert"]')).toBeNull();
		expect(btn.disabled).toBe(false); // `saving` was reset in `finally`
	});

	// Review finding #2: the generic-export-error branch was previously
	// unexercised.
	it('a generic export failure renders an inline alert and keeps the dialog open', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		vi.spyOn(bundleApi, 'exportBundle').mockRejectedValue(new Error('network down'));
		open();
		rowCheckbox('n1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="export-submit"]')!;
		btn.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(getExportArtifactsOpen()).toBe(true);
		const alert = document.body.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Export failed. Try again.');
	});

	// Review finding #2: the per-section "all" checkbox, the global "Select
	// all" checkbox, and the staged-changes note were previously unexercised.
	it('the per-section "all" checkbox toggles every row in that section only', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open();
		const sectionAll = document.body.querySelector<HTMLInputElement>(
			'[data-testid="export-section-all-navigation"]'
		)!;
		sectionAll.click();
		flushSync();
		expect(rowCheckbox('n1').checked).toBe(true);
		expect(rowCheckbox('t1').checked).toBe(false);
		sectionAll.click();
		flushSync();
		expect(rowCheckbox('n1').checked).toBe(false);
	});

	it('the global "Select all" checkbox toggles every visible row', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open();
		const selectAll = document.body.querySelector<HTMLInputElement>(
			'[data-testid="export-select-all"]'
		)!;
		selectAll.click();
		flushSync();
		expect(rowCheckbox('n1').checked).toBe(true);
		expect(rowCheckbox('t1').checked).toBe(true);
		expect(rowCheckbox('s1').checked).toBe(true);
		selectAll.click();
		flushSync();
		expect(rowCheckbox('n1').checked).toBe(false);
		expect(rowCheckbox('t1').checked).toBe(false);
		expect(rowCheckbox('s1').checked).toBe(false);
	});

	// Regression for review finding #4: GET /artifacts returns EVERY kind,
	// including legacy/unregistered ones (`diagram`) SECTIONS has no row for.
	// Before the fix, `headers` was unfiltered, so `allVisibleChecked` could
	// never become true (the diagram row could never be checked) — "Select
	// all" was permanently unreachable and `toggleAll` a one-way add that
	// would silently promote the diagram row to an export root.
	it('filters out unregistered artifact kinds so "Select all" is reachable and never exports them', async () => {
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: [
				...HEADERS,
				{
					id: 'd1',
					kind: 'diagram',
					name: 'Legacy diagram',
					artifact_rev: 1,
					updated_at: '',
					updated_by: null,
					entry_points: null
				}
			]
		});
		await loadArtifacts();
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		const exp = vi.spyOn(bundleApi, 'exportBundle').mockResolvedValue(new Response('{}'));
		vi.spyOn(fileSave, 'saveResponseToFile').mockResolvedValue({
			filename: 'artifacts.bundle.json',
			handle: null
		});
		open();

		// The legacy kind renders no row at all — nothing to check.
		expect(document.body.querySelector('[data-testid="export-row-d1"]')).toBeNull();

		const selectAll = document.body.querySelector<HTMLInputElement>(
			'[data-testid="export-select-all"]'
		)!;
		selectAll.click();
		flushSync();
		// Reachable: the checkbox itself now reads checked (the bug made this
		// permanently false), with every renderable row checked.
		expect(selectAll.checked).toBe(true);
		expect(rowCheckbox('n1').checked).toBe(true);
		expect(rowCheckbox('t1').checked).toBe(true);
		expect(rowCheckbox('s1').checked).toBe(true);

		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="export-submit"]')!;
		btn.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		// Never silently promoted to an export root.
		expect(exp).toHaveBeenCalledWith(expect.arrayContaining(['n1', 't1', 's1']));
		expect(exp.mock.calls[0][0]).not.toContain('d1');
	});

	it('shows a note when there are uncommitted artifact changes', () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		stageArtifactUpdate('n1', { name: 'Renamed' });
		open();
		expect(document.body.textContent).toContain('Uncommitted artifact changes are not exported.');
	});

	// Review finding #3: no test previously drove bits-ui's OWN close
	// (Escape/overlay) through `onOpenChange`, which is the path that must
	// sync `getExportArtifactsOpen()` back to false and cancel any pending
	// debounce. `cancelable: true` is load-bearing — bits-ui clones the event
	// via `new KeyboardEvent(e.type, e)` before dispatching it internally, so
	// a non-cancelable event turns its own `preventDefault()` into a silent
	// no-op (see ConfirmHost.test.ts for the same note).
	it('an internal close (Escape) syncs back to the store and cancels the pending debounce', async () => {
		const preview = vi
			.spyOn(bundleApi, 'exportPreview')
			.mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open();
		rowCheckbox('n1').click();
		flushSync();
		expect(preview).not.toHaveBeenCalled(); // debounce armed but not yet fired

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		flushSync();
		expect(getExportArtifactsOpen()).toBe(false);

		// The pending debounce must have been cancelled by the close, not just
		// outlived by a dialog that no longer renders it.
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(preview).not.toHaveBeenCalled();
	});

	// Regression for review finding #7 (hygiene #1): a mounted-but-never-closed
	// dialog (e.g. a caller that unmounts it directly, or a test) must not
	// leak its pending debounce timer past the component's own lifetime.
	it('clears the pending debounce timer on unmount even if the dialog was never closed', async () => {
		const preview = vi
			.spyOn(bundleApi, 'exportPreview')
			.mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open();
		rowCheckbox('n1').click();
		flushSync();
		expect(preview).not.toHaveBeenCalled(); // debounce armed but not yet fired

		unmount(app!);
		app = null;

		// If the timer had leaked, it would still fire and call exportPreview.
		await vi.advanceTimersByTimeAsync(350);
		expect(preview).not.toHaveBeenCalled();
	});
});
