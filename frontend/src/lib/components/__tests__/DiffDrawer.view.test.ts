import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { StagedViewEntry } from '$lib/state';
import type { View } from '$lib/api/types';
import DiffDrawer from '../DiffDrawer.svelte';

/**
 * The View half of the commit review (artefacts revamp Phase 2, Task 8):
 * the drawer now reads the staged VIEW-OP JOURNAL (`getStagedViewEntries`/
 * `getStagedViewDepth`) rather than a baseline diff, and the whole section
 * discards all-or-nothing (`discardViewChanges`) — no per-row undo, since
 * the journal is order-dependent. Mirrors `DiffDrawer.artifacts.test.ts`'s
 * wholesale `$lib/state` mock.
 */

const EMPTY_DIFF = {
	elements: [],
	relationships: [],
	counts: { added: 0, modified: 0, deleted: 0 }
};

const VIEW: View = { name: 'My view', folders: [], artifacts: [] };

let viewEntries: StagedViewEntry[] = [];

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getStagedDiff: vi.fn(() => EMPTY_DIFF),
		previewStaged: vi.fn(async () => ({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: false
		})),
		commitStaged: vi.fn(async () => ({})),
		discardAll: vi.fn(async () => {}),
		discardElement: vi.fn(async () => {}),
		getIssues: vi.fn(() => []),
		indexIssues: vi.fn(() => ({ byEntity: new Map(), all: [] })),
		getView: vi.fn(() => VIEW),
		getViewFileHandle: vi.fn(() => null),
		getViewFilename: vi.fn(() => null),
		setViewFileHandle: vi.fn(),
		setViewFilename: vi.fn(),
		getStagedArtifactEntries: vi.fn(() => []),
		discardArtifact: vi.fn(async () => {}),
		artifactHeaderById: vi.fn(() => undefined),
		reacquireOpenArtifactLeases: vi.fn(async () => {}),
		markEditorLockDenied: vi.fn(),
		getStagedViewEntries: vi.fn(() => viewEntries),
		getStagedViewDepth: vi.fn(() => viewEntries.length),
		discardViewChanges: vi.fn(async () => {})
	};
});

import { discardViewChanges } from '$lib/state';

const mocked = <T>(fn: T): ReturnType<typeof vi.fn> => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	viewEntries = [];
	mocked(discardViewChanges).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

/** Wait up to ms for predicate to be truthy, polling every 10 ms. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

/** Mount the drawer open and wait for the preview round-trip to settle. */
async function openDrawer(): Promise<Record<string, unknown>> {
	const c = mount(DiffDrawer, { target: document.body, props: { open: true } });
	flushSync();
	await waitFor(() => !/loading changes/i.test(document.body.textContent ?? ''));
	flushSync();
	return c;
}

function buttonMatching(re: RegExp): HTMLButtonElement | undefined {
	return Array.from(document.querySelectorAll('button')).find((b) =>
		re.test(b.textContent ?? '')
	) as HTMLButtonElement | undefined;
}

function clickTab(name: RegExp): void {
	const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((b) =>
		name.test(b.textContent ?? '')
	) as HTMLElement | undefined;
	expect(tab).toBeTruthy();
	tab!.click();
	flushSync();
}

describe('DiffDrawer view changes', () => {
	it('renders staged view entries as label rows, in journal order', async () => {
		viewEntries = [
			{
				op: { kind: 'create_folder', temp_id: 'tmp_1', parent_id: 'root', name: 'Pumps' },
				label: 'Created folder "Pumps"',
				unplacedElementIds: []
			},
			{
				op: { kind: 'rename_folder', id: 'f1', name: 'Valves' },
				label: 'Renamed folder "Old" → "Valves"',
				unplacedElementIds: []
			}
		];

		const c = await openDrawer();
		clickTab(/^View/);

		const text = document.body.textContent ?? '';
		expect(text).toMatch(/Created folder "Pumps"/);
		expect(text).toMatch(/Renamed folder "Old" → "Valves"/);
		// journal order: the create line precedes the rename line in the DOM
		const idxCreate = text.indexOf('Created folder "Pumps"');
		const idxRename = text.indexOf('Renamed folder "Old" → "Valves"');
		expect(idxCreate).toBeGreaterThanOrEqual(0);
		expect(idxCreate).toBeLessThan(idxRename);

		unmount(c);
	});

	it("counts staged view entries into the commit gate's total", async () => {
		viewEntries = [
			{
				op: { kind: 'delete_folder', id: 'f1' },
				label: 'Deleted folder "Pumps"',
				unplacedElementIds: []
			}
		];

		const c = await openDrawer();

		const commitBtn = buttonMatching(/^\s*Commit/);
		expect(commitBtn).toBeTruthy();
		expect(commitBtn!.disabled).toBe(false);
		expect(commitBtn!.textContent?.trim()).toBe('Commit (1)');

		unmount(c);
	});

	it('a view-only staged batch enables Commit', async () => {
		viewEntries = [
			{
				op: { kind: 'delete_folder', id: 'f1' },
				label: 'Deleted folder "Pumps"',
				unplacedElementIds: []
			}
		];

		const c = await openDrawer();

		expect(buttonMatching(/^\s*Commit/)!.disabled).toBe(false);

		unmount(c);
	});

	// Regression: the Model tab is the default/active tab on open, and its
	// four content sections (added/modified/deleted/artifacts) are all empty
	// for a view-only batch — a naive `total === 0` fallback check leaves the
	// pane fully blank even though the tab label and Commit button both show
	// a nonzero count. A pointer message must render instead.
	it('shows a pointer to the View tab on the Model tab for a view-only batch, and keeps Commit enabled', async () => {
		viewEntries = [
			{
				op: { kind: 'delete_folder', id: 'f1' },
				label: 'Deleted folder "Pumps"',
				unplacedElementIds: []
			},
			{
				op: { kind: 'rename_folder', id: 'f2', name: 'Valves' },
				label: 'Renamed folder "Old" → "Valves"',
				unplacedElementIds: []
			}
		];

		const c = await openDrawer();

		// Collapse whitespace (the markup wraps mid-sentence) so the assertion
		// isn't sensitive to exactly where Prettier breaks the template's lines.
		const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
		expect(text).not.toMatch(/No pending changes/i);
		expect(text).toMatch(/2 staged view changes — see the View tab\./i);
		expect(buttonMatching(/^\s*Commit/)!.disabled).toBe(false);
		expect(buttonMatching(/^\s*Commit/)!.textContent?.trim()).toBe('Commit (2)');

		unmount(c);
	});

	it('calls discardViewChanges exactly once from the single discard button', async () => {
		viewEntries = [
			{
				op: { kind: 'delete_folder', id: 'f1' },
				label: 'Deleted folder "Pumps"',
				unplacedElementIds: []
			}
		];

		const c = await openDrawer();
		clickTab(/^View/);

		const discardBtn = buttonMatching(/Discard view changes/i);
		expect(discardBtn).toBeTruthy();
		discardBtn!.click();
		flushSync();
		await waitFor(() => mocked(discardViewChanges).mock.calls.length > 0);

		expect(discardViewChanges).toHaveBeenCalledTimes(1);

		unmount(c);
	});

	it('disables the discard-view-changes button when the journal is empty', async () => {
		viewEntries = [];

		const c = await openDrawer();
		clickTab(/^View/);

		const discardBtn = buttonMatching(/Discard view changes/i);
		expect(discardBtn).toBeTruthy();
		expect(discardBtn!.disabled).toBe(true);

		unmount(c);
	});
});
