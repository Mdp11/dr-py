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
import { REGISTERED_KINDS } from '$lib/artifacts/kinds';
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

// An unregistered legacy kind the dialog has no section for — shared by the
// two sibling regression tests (row filtering and seed validation) so a
// fixture-shape change cannot make them diverge.
const LEGACY_DIAGRAM = {
	id: 'd1',
	kind: 'diagram',
	name: 'Legacy diagram',
	artifact_rev: 1,
	updated_at: '',
	updated_by: null,
	entry_points: null
};

async function loadWithLegacyDiagram() {
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
		items: [...HEADERS, LEGACY_DIAGRAM]
	});
	await loadArtifacts();
}

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

	// getCommittedArtifactHeaders() is a genuinely reactive $state that
	// changes on ANY committed artifact create/rename/delete — including a
	// peer's commit arriving over the realtime feed while this dialog stays
	// open. The seeding effect must not resubscribe to it, or an unrelated
	// headers change would wipe every checkbox the user had already toggled
	// and re-seed from the stale original seed array.
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

	it('a rejected preview call renders an inline alert', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockRejectedValue(new Error('boom'));
		open();
		rowCheckbox('n1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		const alert = document.body.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Could not compute the bundle preview.');
	});

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

	// GET /artifacts returns EVERY kind, including legacy/unregistered ones
	// (`diagram`) SECTIONS has no row for. `headers` must filter those out, or
	// `allVisibleChecked` could never become true (the diagram row could
	// never be checked) — "Select all" would be permanently unreachable and
	// `toggleAll` a one-way add that would silently promote the diagram row
	// to an export root.
	it('filters out unregistered artifact kinds so "Select all" is reachable and never exports them', async () => {
		await loadWithLegacyDiagram();
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

	// Companion to the filtering test above, for the SEED path: the
	// open-transition effect validates seed ids against a membership set that
	// must be built from the same filtered `headers` the rows render from. An
	// unregistered-kind id (e.g. legacy `diagram`) present in the committed
	// store would otherwise pass validation and enter `checked` while never
	// rendering a row — an invisible selection that silently becomes an
	// export root.
	it('a seeded unregistered-kind id is dropped, not silently checked', async () => {
		await loadWithLegacyDiagram();
		const preview = vi
			.spyOn(bundleApi, 'exportPreview')
			.mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open(['n1', 'd1']);
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		// Only the renderable seed survives; d1 never enters the selection.
		expect(preview).toHaveBeenCalledWith(['n1']);
		expect(rowCheckbox('n1').checked).toBe(true);
		// d1 must not sit checked-but-rowless, which would surface here as a
		// phantom "+1 selected not shown".
		expect(document.body.textContent).not.toContain('selected not shown');
	});

	// `checked` is only ever ADDED to by user or seed action, but the
	// committed headers can shrink underneath it — a peer's delete commit
	// over the realtime feed removes the row while the untracked open-effect
	// (correctly) never reruns. The dead id must not linger as a phantom "+N
	// selected not shown" nor be POSTed as an export root; the EFFECTIVE
	// selection is `checked` ∩ live headers.
	it('a peer delete of a checked artifact drops it from the effective selection', async () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		const exp = vi.spyOn(bundleApi, 'exportBundle').mockResolvedValue(new Response('{}'));
		vi.spyOn(fileSave, 'saveResponseToFile').mockResolvedValue({
			filename: 'artifacts.bundle.json',
			handle: null
		});
		open();
		rowCheckbox('n1').click();
		rowCheckbox('t1').click();
		await vi.advanceTimersByTimeAsync(350);
		flushSync();

		// A peer's delete commit lands: n1 vanishes from the committed store.
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: HEADERS.filter((h) => h.id !== 'n1')
		});
		await loadArtifacts();
		flushSync();
		expect(document.body.querySelector('[data-testid="export-row-n1"]')).toBeNull();

		// No phantom hidden selection the user cannot clear...
		expect(document.body.textContent).not.toContain('selected not shown');

		// ...the preview is recomputed for the shrunken selection rather than
		// left advertising the deleted artifact's closure...
		const preview = vi.mocked(bundleApi.exportPreview);
		const callsBefore = preview.mock.calls.length;
		await vi.advanceTimersByTimeAsync(350);
		flushSync();
		expect(preview.mock.calls.length).toBeGreaterThan(callsBefore);
		expect(preview).toHaveBeenLastCalledWith(['t1']);

		// ...and the dead id is not exported as a root.
		const btn = document.body.querySelector<HTMLButtonElement>('[data-testid="export-submit"]')!;
		btn.click();
		await vi.advanceTimersByTimeAsync(0);
		flushSync();
		expect(exp).toHaveBeenCalledWith(['t1']);
	});

	it('shows a note when there are uncommitted artifact changes', () => {
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		stageArtifactUpdate('n1', { name: 'Renamed' });
		open();
		expect(document.body.textContent).toContain('Uncommitted artifact changes are not exported.');
	});

	// bits-ui's OWN close (Escape/overlay) goes through `onOpenChange`, which
	// is the path that must sync `getExportArtifactsOpen()` back to false and
	// cancel any pending debounce. `cancelable: true` is load-bearing — bits-ui
	// clones the event
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

	// A mounted-but-never-closed dialog (e.g. a caller that unmounts it
	// directly, or a test) must not leak its pending debounce timer past the
	// component's own lifetime.
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

describe('ExportArtifactsDialog kind coverage', () => {
	// SECTIONS is an array, not a Record<ArtifactKind, …>, so a kind missing from
	// it type-checks cleanly and silently drops that kind's artifacts from the
	// dialog — they can never be selected as an export root. Derived from
	// REGISTERED_KINDS rather than a second hand-written list, so the next kind
	// added fails here.
	it('renders one section per registered artifact kind', async () => {
		resetArtifacts();
		vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
			items: REGISTERED_KINDS.map((kind, i) => ({
				id: `k${i}`,
				kind,
				name: `${kind} artifact`,
				artifact_rev: 1,
				updated_at: '',
				updated_by: null,
				entry_points: null
			}))
		});
		await loadArtifacts();
		vi.spyOn(bundleApi, 'exportPreview').mockResolvedValue({ artifacts: [], dangling_refs: [] });
		open();

		const rendered = [
			...document.body.querySelectorAll('[data-testid^="export-section-all-"]')
		].map((el) => el.getAttribute('data-testid')!.slice('export-section-all-'.length));
		expect(new Set(rendered)).toEqual(new Set(REGISTERED_KINDS));
	});
});
