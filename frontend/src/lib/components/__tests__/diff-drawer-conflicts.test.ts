import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { StagedConflict } from '$lib/state';
import DiffDrawer from '../DiffDrawer.svelte';

/**
 * The DiffDrawer's conflicts section: parked batches the engine can no
 * longer apply. Mirrors `DiffDrawer.artifacts.test.ts`'s wholesale `$lib/state`
 * mock — a hand-made facade over the drawer, not the real replica.
 */

const EMPTY_DIFF = {
	elements: [],
	relationships: [],
	counts: { added: 0, modified: 0, deleted: 0 }
};

let conflicts: StagedConflict[] = [];

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
		getEffectiveIssues: vi.fn(() => []),
		indexIssues: vi.fn(() => ({ byEntity: new Map(), all: [] })),
		getView: vi.fn(() => null),
		getViewFileHandle: vi.fn(() => null),
		getViewFilename: vi.fn(() => null),
		setViewFileHandle: vi.fn(),
		setViewFilename: vi.fn(),
		getStagedViewEntries: vi.fn(() => []),
		getStagedViewDepth: vi.fn(() => 0),
		discardViewChanges: vi.fn(async () => {}),
		getStagedArtifactEntries: vi.fn(() => []),
		discardArtifact: vi.fn(async () => {}),
		artifactHeaderById: vi.fn(() => undefined),
		reacquireOpenArtifactLeases: vi.fn(async () => {}),
		markEditorLockDenied: vi.fn(),
		getStagedConflicts: vi.fn(() => conflicts),
		discardConflict: vi.fn(async () => {})
	};
});

import { discardConflict } from '$lib/state';

beforeEach(() => {
	conflicts = [];
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

const CONFLICT_A: StagedConflict = {
	batch: {
		id: 5,
		ops: [{ kind: 'update_element', id: 'e1', properties_patch: { name: 'Renamed' } }]
	},
	error: { status: 422, detail: "No element with id 'e1" }
};

const CONFLICT_B: StagedConflict = {
	batch: {
		id: 7,
		ops: [
			{
				kind: 'create_element',
				temp_id: 'tmp_9',
				type_name: 'Organization',
				properties: { name: 'Fresh' }
			}
		]
	},
	error: { status: 422, detail: 'stale base_rev' }
};

describe('DiffDrawer conflicts section', () => {
	it('renders no section when there are no conflicts', async () => {
		conflicts = [];

		const c = await openDrawer();

		expect(document.body.querySelector('[data-testid="staged-conflicts"]')).toBeNull();

		unmount(c);
	});

	it('shows the heading and one row per parked batch, the engine text verbatim', async () => {
		conflicts = [CONFLICT_A, CONFLICT_B];

		const c = await openDrawer();

		const section = document.body.querySelector('[data-testid="staged-conflicts"]');
		expect(section).toBeTruthy();
		expect(section!.textContent).toContain('2 staged edits no longer apply');

		const rowA = document.body.querySelector('[data-testid="conflict-row-5"]');
		const rowB = document.body.querySelector('[data-testid="conflict-row-7"]');
		expect(rowA).toBeTruthy();
		expect(rowB).toBeTruthy();

		// The engine's refusal text, verbatim.
		expect(rowA!.textContent).toContain("No element with id 'e1");
		expect(rowB!.textContent).toContain('stale base_rev');

		// Each op summarised: kind glyph, type name or id, the name override.
		expect(rowA!.textContent).toContain('e1');
		expect(rowA!.textContent).toContain('Renamed');
		expect(rowB!.textContent).toContain('Organization');
		expect(rowB!.textContent).toContain('Fresh');

		unmount(c);
	});

	it('Discard calls discardConflict with the batch id', async () => {
		conflicts = [CONFLICT_A];

		const c = await openDrawer();

		const row = document.body.querySelector('[data-testid="conflict-row-5"]')!;
		const discardBtn = Array.from(row.querySelectorAll('button')).find((b) =>
			/discard/i.test(b.textContent ?? '')
		) as HTMLButtonElement | undefined;
		expect(discardBtn).toBeTruthy();
		discardBtn!.click();
		flushSync();

		expect(discardConflict).toHaveBeenCalledWith(5);

		unmount(c);
	});

	it("the drawer's total does not count parked conflicts, and Commit ignores them", async () => {
		conflicts = [CONFLICT_A, CONFLICT_B];

		const c = await openDrawer();

		expect(document.body.textContent).toMatch(/No pending changes/i);
		const commitBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			/^\s*Commit/.test(b.textContent ?? '')
		) as HTMLButtonElement | undefined;
		expect(commitBtn).toBeTruthy();
		expect(commitBtn!.textContent?.trim()).toBe('Commit (0)');
		expect(commitBtn!.disabled).toBe(true);
		// The conflicts section still renders even though the commit total is 0.
		expect(document.body.querySelector('[data-testid="staged-conflicts"]')).toBeTruthy();

		unmount(c);
	});
});
