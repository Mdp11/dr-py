import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { ConflictError } from '$lib/api/errors';
import type { StagedArtifactEntry } from '$lib/state';
import DiffDrawer from '../DiffDrawer.svelte';

/**
 * The artifact half of the commit review. Mirrors `DiffDrawer.strict.test.ts`'s
 * wholesale `$lib/state` mock: the drawer is exercised as a component over a
 * stubbed store surface, so what is asserted here is the drawer's own logic
 * (counting, rendering, error mapping, the post-commit lease sweep) and not
 * the stores'.
 */

const EMPTY_DIFF = {
	elements: [],
	relationships: [],
	counts: { added: 0, modified: 0, deleted: 0 }
};

let artifactEntries: StagedArtifactEntry[] = [];

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
		ensureElement: vi.fn(async () => {}),
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
		getStagedArtifactEntries: vi.fn(() => artifactEntries),
		discardArtifact: vi.fn(async () => {}),
		artifactHeaderById: vi.fn(() => undefined),
		reacquireOpenArtifactLeases: vi.fn(async () => {}),
		markEditorLockDenied: vi.fn()
	};
});

import {
	artifactHeaderById,
	commitStaged,
	markEditorLockDenied,
	discardArtifact,
	reacquireOpenArtifactLeases
} from '$lib/state';

const mocked = <T>(fn: T): ReturnType<typeof vi.fn> => fn as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
	artifactEntries = [];
	// `clearAllMocks` clears CALLS, not implementations — a per-test
	// `mockRejectedValue` would otherwise leak into every later test.
	mocked(commitStaged).mockReset().mockResolvedValue({});
	mocked(reacquireOpenArtifactLeases).mockReset().mockResolvedValue(undefined);
	mocked(artifactHeaderById).mockReset().mockReturnValue(undefined);
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

const UPDATE_ENTRY: StagedArtifactEntry = {
	kind: 'update',
	id: 'a1',
	name: 'Renamed',
	header: null
};

describe('DiffDrawer artifact changes', () => {
	it('counts staged artifact changes into the commit total', async () => {
		artifactEntries = [UPDATE_ENTRY];

		const c = await openDrawer();

		const commitBtn = buttonMatching(/^\s*Commit/);
		expect(commitBtn).toBeTruthy();
		expect(commitBtn!.disabled).toBe(false);
		expect(commitBtn!.textContent?.trim()).toBe('Commit (1)');
		expect(document.body.textContent).not.toMatch(/No pending changes/i);

		unmount(c);
	});

	it('renders a row per staged artifact entry with kind + name', async () => {
		mocked(artifactHeaderById).mockImplementation((id: string) =>
			id === 'a1' ? { id: 'a1', name: 'Fleet table', kind: 'table' } : undefined
		);
		artifactEntries = [
			{
				kind: 'create',
				tempId: 'tmp_1',
				artifactKind: 'code_snippet',
				name: 'Counter',
				payload: {},
				sourceTabId: 'snip:draft:1'
			},
			UPDATE_ENTRY,
			{
				kind: 'delete',
				id: 'a2',
				header: {
					id: 'a2',
					name: 'Old nav',
					kind: 'navigation',
					artifact_rev: 3,
					updated_at: '',
					updated_by: null,
					entry_points: null
				}
			}
		];

		const c = await openDrawer();

		const text = document.body.textContent ?? '';
		expect(text).toMatch(/Artifacts \(3\)/);
		// create: staged name + its kind, spelled for humans
		expect(text).toMatch(/Counter/);
		expect(text).toMatch(/new code snippet/i);
		// update: the overlay-resolved header name, not the bare id
		expect(text).toMatch(/Fleet table/);
		expect(text).toMatch(/edited/i);
		// delete: the COMMITTED header name
		expect(text).toMatch(/Old nav/);
		expect(text).toMatch(/deleted/i);

		unmount(c);
	});

	// Through `discardArtifact`, NOT the raw `revertStagedArtifact`: only the
	// former also releases the `art:` lease. Reverting the buffer alone stranded
	// the lease for its full TTL — with no editor tab to release it on close and
	// no token for `commitStaged` to send, nothing would ever clean it up.
	it('discards a single staged artifact entry from its row', async () => {
		artifactEntries = [UPDATE_ENTRY];

		const c = await openDrawer();

		const discardRow = buttonMatching(/^\s*Discard\s*$/);
		expect(discardRow).toBeTruthy();
		discardRow!.click();
		flushSync();

		expect(discardArtifact).toHaveBeenCalledWith('a1');

		unmount(c);
	});

	it('maps the required-lock-not-held 409 to an actionable message', async () => {
		artifactEntries = [UPDATE_ENTRY];
		mocked(commitStaged).mockRejectedValue(
			new ConflictError(409, { detail: 'required lock not held' }, 'required lock not held')
		);

		const c = await openDrawer();
		buttonMatching(/^\s*Commit/)!.click();
		await waitFor(() => /commit failed/i.test(document.body.textContent ?? ''));
		flushSync();

		const text = document.body.textContent ?? '';
		expect(text).toMatch(/lock/i);
		expect(text).toMatch(/re-open|reopen/i);

		unmount(c);
	});

	it('maps the overlapping-commit and stale-rev 409s', async () => {
		artifactEntries = [UPDATE_ENTRY];
		mocked(commitStaged).mockRejectedValue(
			new ConflictError(
				409,
				{ detail: 'conflicting concurrent commits', model_rev: 7 },
				'conflicting concurrent commits'
			)
		);

		const c = await openDrawer();
		buttonMatching(/^\s*Commit/)!.click();
		await waitFor(() => /commit failed/i.test(document.body.textContent ?? ''));
		flushSync();
		expect(document.body.textContent).toMatch(/someone else committed/i);
		unmount(c);

		mocked(commitStaged).mockRejectedValue(
			new ConflictError(409, { detail: 'stale base_rev', model_rev: 9 }, 'stale base_rev')
		);
		const c2 = await openDrawer();
		buttonMatching(/^\s*Commit/)!.click();
		await waitFor(() => /commit failed/i.test(document.body.textContent ?? ''));
		flushSync();
		expect(document.body.textContent).toMatch(/reload/i);
		unmount(c2);
	});

	it('falls back to the raw message for an unmapped failure', async () => {
		artifactEntries = [UPDATE_ENTRY];
		mocked(commitStaged).mockRejectedValue(new Error('boom from the server'));

		const c = await openDrawer();
		buttonMatching(/^\s*Commit/)!.click();
		await waitFor(() => /commit failed/i.test(document.body.textContent ?? ''));
		flushSync();

		expect(document.body.textContent).toMatch(/boom from the server/);

		unmount(c);
	});

	it('reacquires open artifact leases after a successful commit', async () => {
		artifactEntries = [UPDATE_ENTRY];

		const c = await openDrawer();
		buttonMatching(/^\s*Commit/)!.click();
		await waitFor(() => mocked(reacquireOpenArtifactLeases).mock.calls.length > 0);

		expect(reacquireOpenArtifactLeases).toHaveBeenCalledTimes(1);

		unmount(c);
	});

	it('flips a denied tab to lock-denied through markEditorLockDenied', async () => {
		artifactEntries = [UPDATE_ENTRY];
		mocked(reacquireOpenArtifactLeases).mockImplementation(
			async (onDenied: (tabId: string, holder: string) => void) => {
				onDenied('nav:a1', 'ada@example.com');
			}
		);

		const c = await openDrawer();
		buttonMatching(/^\s*Commit/)!.click();
		await waitFor(() => mocked(markEditorLockDenied).mock.calls.length > 0);

		expect(markEditorLockDenied).toHaveBeenCalledWith('nav:a1', 'ada@example.com');

		unmount(c);
	});

	it('swallows a failing lease sweep instead of leaving an unhandled rejection', async () => {
		artifactEntries = [UPDATE_ENTRY];
		// The sweep bottoms out in `ensureCheckout`, which RETHROWS anything that is
		// not a lock conflict — so a 500 mid-sweep must be caught at the call site
		// or it escapes the fire-and-forget `void` as an unhandled rejection.
		// Asserted by observing that the caller attaches a rejection handler to the
		// promise, because the absence of an unhandled rejection is not directly
		// observable here (a `process.on('unhandledRejection')` probe stays silent
		// even with the guard deleted). The rejected promise is minted INSIDE the
		// mock call, so the handler lands in the same turn and the test itself does
		// not create the very unhandled rejection it is about.
		const sweepCatch = vi.fn();
		mocked(reacquireOpenArtifactLeases).mockImplementation(() => {
			const p: Promise<void> = Promise.reject(new Error('HTTP 500'));
			const original = p.catch.bind(p);
			p.catch = ((onRejected) => {
				sweepCatch();
				return original(onRejected);
			}) as Promise<void>['catch'];
			return p;
		});

		const c = await openDrawer();
		buttonMatching(/^\s*Commit/)!.click();
		await waitFor(() => mocked(reacquireOpenArtifactLeases).mock.calls.length > 0);
		await new Promise((r) => setTimeout(r, 10));

		expect(sweepCatch).toHaveBeenCalled();

		// The commit itself succeeded and is durable — a failed re-check-out must
		// not be reported as a failed commit either.
		expect(document.body.textContent ?? '').not.toMatch(/commit failed/i);

		unmount(c);
	});

	it('disables Commit and Discard all when nothing is staged at all', async () => {
		artifactEntries = [];

		const c = await openDrawer();

		expect(document.body.textContent).toMatch(/No pending changes/i);
		expect(buttonMatching(/^\s*Commit/)!.disabled).toBe(true);
		expect(buttonMatching(/Discard all/)!.disabled).toBe(true);

		unmount(c);
	});
});
