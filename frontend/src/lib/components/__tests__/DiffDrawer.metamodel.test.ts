import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import DiffDrawer from '../DiffDrawer.svelte';

/**
 * The METAMODEL half of the commit review (spec 2026-08-16): the fourth staged
 * family folds into the drawer's total and gets its own section on the Changes
 * tab, rendering at most two rows — the YAML draft and the coalesced node moves
 * — because the family discards all-or-nothing like the View tab does.
 *
 * Mirrors `DiffDrawer.view.test.ts`'s wholesale `$lib/state` mock; only the
 * metamodel readers vary per case.
 */

const EMPTY_DIFF = {
	elements: [],
	relationships: [],
	counts: { added: 0, modified: 0, deleted: 0 }
};

let draftDirty = false;
let moves = new Map<string, { x: number; y: number } | null>();

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
		getStagedArtifactEntries: vi.fn(() => []),
		discardArtifact: vi.fn(async () => {}),
		artifactHeaderById: vi.fn(() => undefined),
		reacquireOpenArtifactLeases: vi.fn(async () => {}),
		markEditorLockDenied: vi.fn(),
		getStagedViewEntries: vi.fn(() => []),
		getStagedViewDepth: vi.fn(() => 0),
		discardViewChanges: vi.fn(async () => {}),
		// The depth is what the store itself computes: one for a dirty draft plus
		// one per moved node.
		getStagedMetamodelDepth: vi.fn(() => (draftDirty ? 1 : 0) + moves.size),
		getStagedNodeMoves: vi.fn(() => moves),
		isMetamodelEditorDirty: vi.fn(() => draftDirty),
		discardMetamodelDraft: vi.fn(),
		discardStagedNodeMoves: vi.fn()
	};
});

import { discardMetamodelDraft, discardStagedNodeMoves } from '$lib/state';

const mocked = <T>(fn: T): ReturnType<typeof vi.fn> => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	draftDirty = false;
	moves = new Map();
	mocked(discardMetamodelDraft).mockReset();
	mocked(discardStagedNodeMoves).mockReset();
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

function text(): string {
	return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

describe('DiffDrawer metamodel changes', () => {
	it('renders no metamodel section when nothing metamodel-shaped is staged', async () => {
		const c = await openDrawer();

		expect(text()).not.toMatch(/Metamodel \(/);
		expect(text()).toMatch(/No pending changes/i);

		unmount(c);
	});

	it('counts a dirty YAML draft into the commit total and renders one row', async () => {
		draftDirty = true;

		const c = await openDrawer();

		expect(text()).toMatch(/Metamodel \(1\)/);
		expect(text()).toMatch(/metamodel schema \(YAML edited\)/);
		const commit = buttonMatching(/^\s*Commit/);
		expect(commit?.textContent?.trim()).toBe('Commit (1)');
		expect(commit?.disabled).toBe(false);

		unmount(c);
	});

	it('renders staged node moves as ONE pluralized row, not one row per node', async () => {
		moves = new Map([
			['el:Pump', { x: 1, y: 2 }],
			['el:Valve', null]
		]);

		const c = await openDrawer();

		expect(text()).toMatch(/Metamodel \(2\)/);
		expect(text()).toMatch(/2 diagram nodes moved/);
		expect(text()).not.toMatch(/el:Pump/);
		expect(buttonMatching(/^\s*Commit/)?.textContent?.trim()).toBe('Commit (2)');

		unmount(c);
	});

	it('says "1 diagram node moved" for a single move', async () => {
		moves = new Map([['el:Pump', { x: 1, y: 2 }]]);

		const c = await openDrawer();

		expect(text()).toMatch(/1 diagram node moved/);

		unmount(c);
	});

	it('shows both rows when the draft and moves are staged together', async () => {
		draftDirty = true;
		moves = new Map([['el:Pump', { x: 1, y: 2 }]]);

		const c = await openDrawer();

		expect(text()).toMatch(/Metamodel \(2\)/);
		expect(text()).toMatch(/metamodel schema \(YAML edited\)/);
		expect(text()).toMatch(/1 diagram node moved/);

		unmount(c);
	});

	it('never shows the view-tab pointer for a metamodel-only batch', async () => {
		// The pointer branch fires when every Changes-tab section is empty — but
		// the metamodel section renders right there, and with no view ops staged
		// it would otherwise read "0 staged view changes — see the View tab."
		draftDirty = true;

		const c = await openDrawer();

		expect(text()).not.toMatch(/staged view change/i);
		expect(text()).not.toMatch(/No pending changes/i);

		unmount(c);
	});

	it('discards both halves from the single section button', async () => {
		draftDirty = true;
		moves = new Map([['el:Pump', { x: 1, y: 2 }]]);

		const c = await openDrawer();

		const discard = buttonMatching(/Discard metamodel changes/i);
		expect(discard).toBeTruthy();
		discard!.click();
		flushSync();

		expect(discardMetamodelDraft).toHaveBeenCalledTimes(1);
		expect(discardStagedNodeMoves).toHaveBeenCalledTimes(1);

		unmount(c);
	});

	it('wipes the staged MOVES before discarding the draft (lease-release ordering)', async () => {
		// Not cosmetic ordering: `discardMetamodelDraft` ends in
		// `void dropMetamodelLease()`, and `releaseMetamodelLease` refuses to hand
		// the `mm` lease back while `getStagedMetamodelDepth() > 0` — a check it
		// makes SYNCHRONOUSLY, before this composite's next statement runs. Draft
		// first therefore strands the exclusive lease whenever both halves are
		// staged. `discardAll` already learned this; the two component composites
		// have to match it. Asserted by invocation order because the drawer's
		// state is mocked here — the lease itself is pinned in
		// `Metamodel/__tests__/metamodel-tab.test.ts` against the real store.
		draftDirty = true;
		moves = new Map([['el:Pump', { x: 1, y: 2 }]]);

		const c = await openDrawer();

		buttonMatching(/Discard metamodel changes/i)!.click();
		flushSync();

		const movesAt = mocked(discardStagedNodeMoves).mock.invocationCallOrder[0];
		const draftAt = mocked(discardMetamodelDraft).mock.invocationCallOrder[0];
		expect(movesAt).toBeLessThan(draftAt);

		unmount(c);
	});
});
