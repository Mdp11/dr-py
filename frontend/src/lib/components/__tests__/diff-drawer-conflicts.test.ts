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

// A CR/compare proposal's create carries an `id` hint the engine stages the
// entity under (the temp id is only a batch-internal handle) — the row must
// show that id, not `tmp_…`.
const CONFLICT_WITH_ID_HINT: StagedConflict = {
	batch: {
		id: 9,
		ops: [
			{
				kind: 'create_element',
				temp_id: 'tmp_internal',
				id: 'e_from_cr',
				type_name: 'Organization',
				properties: {}
			}
		]
	},
	error: { status: 422, detail: "id 'e_from_cr' already exists" }
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

		// The engine's refusal text, verbatim — scoped to the `<p>` it renders
		// in, not the whole row (row A's op line and its error text both
		// legitimately contain "e1", so a whole-row match would pass even if
		// the op summary were missing entirely).
		const errorA = rowA!.querySelector('p')?.textContent;
		const errorB = rowB!.querySelector('p')?.textContent;
		expect(errorA).toContain("No element with id 'e1");
		expect(errorB).toContain('stale base_rev');

		// Each op summarised: kind glyph, type name or id, the name override —
		// scoped to the op line (`data-testid="conflict-op"`), not the row,
		// so this fails if the op summary itself is missing.
		const opA = rowA!.querySelector('[data-testid="conflict-op"]')?.textContent;
		const opB = rowB!.querySelector('[data-testid="conflict-op"]')?.textContent;
		expect(opA).toContain('e1');
		expect(opA).toContain('Renamed');
		expect(opB).toContain('Organization');
		expect(opB).toContain('Fresh');

		unmount(c);
	});

	it("a parked create shows the CR's id hint, not the temp id", async () => {
		conflicts = [CONFLICT_WITH_ID_HINT];

		const c = await openDrawer();

		const row = document.body.querySelector('[data-testid="conflict-row-9"]');
		expect(row).toBeTruthy();
		const op = row!.querySelector('[data-testid="conflict-op"]')?.textContent;
		expect(op).toContain('e_from_cr');
		expect(op).not.toContain('tmp_internal');

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

		// "No pending changes." would contradict the conflicts section sitting
		// right below it — it must not render while a conflict does.
		expect(document.body.textContent).not.toMatch(/No pending changes/i);
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
