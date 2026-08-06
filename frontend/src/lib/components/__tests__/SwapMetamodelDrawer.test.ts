import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SwapMetamodelDrawer from '../SwapMetamodelDrawer.svelte';
import { ApiError } from '$lib/api';

// Mock the API client so no network is needed.
vi.mock('$lib/api/metamodel', () => ({
	diffMetamodel: vi.fn(),
	rebindMetamodel: vi.fn(),
	getMetamodel: vi.fn()
}));
import { diffMetamodel, rebindMetamodel, getMetamodel as fetchMetamodel } from '$lib/api/metamodel';

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getRole: vi.fn(() => 'owner'),
		getModelRev: vi.fn(() => 7),
		setIssues: vi.fn(),
		setMetamodel: vi.fn(),
		setMetamodelFilename: vi.fn(),
		refreshSummary: vi.fn(async () => {})
	};
});

import { getRole, setIssues, refreshSummary } from '$lib/state';
// The quiet gate (`isProjectQuiet`) is left REAL by the `...actual` spread, so
// these tests drive its three terms through the actual stores: the staged model
// buffer, the staged artifact buffer, and the feed's lock table.
import { emit, resetModelStore, seedElements } from '$lib/state/model.svelte';
import { resetArtifactEdits } from '$lib/state/artifact-edits.svelte';
import { handleFeedEvent, resetRealtime } from '$lib/state/realtime.svelte';
import type { LeaseLite } from '$lib/api/feed';

/** Install `resourceIds` as the project-wide lock table, as a feed snapshot
 * would. `model_rev: 0` keeps the reducer's "am I behind?" summary refresh
 * (fire-and-forget, network) from firing. */
function seedLocks(...resourceIds: string[]): void {
	handleFeedEvent({
		type: 'snapshot',
		model_rev: 0,
		locks: resourceIds.map(
			(resource_id): LeaseLite => ({ resource_id, mode: 'exclusive', holder_id: 'peer' })
		),
		connected: []
	});
}

afterEach(() => {
	document.body.innerHTML = '';
	resetModelStore();
	resetArtifactEdits();
	resetRealtime();
	vi.clearAllMocks();
});

function file(text: string, name = 'cand.metamodel.yaml'): File {
	return new File([text], name, { type: 'application/x-yaml' });
}

/** Wait up to ms for predicate to be truthy, polling every 10 ms. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function triggerFilePick(f: File): Promise<void> {
	const input = document.querySelector('input[type="file"]') as HTMLInputElement;
	if (!input) throw new Error('no file input found');
	// Simulate file pick: set .files via DataTransfer, then dispatch change.
	const dt = new DataTransfer();
	dt.items.add(f);
	Object.defineProperty(input, 'files', { value: dt.files, configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

function bodyText(): string {
	return document.body.textContent ?? '';
}

describe('SwapMetamodelDrawer read path', () => {
	it('runs the diff on file pick and shows the counts headline', async () => {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: [
				{ severity: 'error', message: 'a unknown type', target_ids: ['a'], category: 'conformance' }
			],
			now_passing: [],
			unchanged_count: 5,
			current_error_count: 5,
			candidate_error_count: 6
		});
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await triggerFilePick(file('elements: []\n'));
			await waitFor(() => /1 now failing/i.test(bodyText()));
			expect(diffMetamodel).toHaveBeenCalledWith('elements: []\n');
			expect(/0 now passing/i.test(bodyText())).toBe(true);
			expect(/5 unchanged/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});

	it('caps each issue section at 200 with an "and N more" footer', async () => {
		const many = Array.from({ length: 250 }, (_, i) => ({
			severity: 'error',
			message: `issue ${i}`,
			target_ids: [`e${i}`],
			category: 'conformance'
		}));
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: many,
			now_passing: [],
			unchanged_count: 0,
			current_error_count: 0,
			candidate_error_count: 250
		});
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await triggerFilePick(file('elements: []\n'));
			await waitFor(() => /and 50 more/i.test(bodyText()));
			expect(/and 50 more/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});

	it('surfaces a parse error when the diff call rejects', async () => {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('bad yaml'));
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await triggerFilePick(file('nope'));
			await waitFor(() => /couldn.t read the candidate/i.test(bodyText()));
			expect(/couldn.t read the candidate/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});
});

describe('SwapMetamodelDrawer rebind path', () => {
	/** Reach the review step with a diff already rendered. */
	async function pickAndDiff(): Promise<void> {
		(diffMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			now_failing: [],
			now_passing: [],
			unchanged_count: 2,
			current_error_count: 2,
			candidate_error_count: 2
		});
		await triggerFilePick(file('elements: []\n'));
		await waitFor(() => /2 unchanged/i.test(bodyText()));
	}

	it('hides the rebind button for non-owners', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('editor');
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await pickAndDiff();
			// Non-owners see a read-only message, not a rebind button
			expect(/read-only for your role/i.test(bodyText())).toBe(true);
			const btn = document.querySelector('button[aria-busy]') as HTMLButtonElement | null;
			expect(btn).toBeNull();
		} finally {
			unmount(component);
		}
	});

	it('blocks rebind when staged edits exist (quiet-project)', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await pickAndDiff();
			expect(/needs a quiet project/i.test(bodyText())).toBe(true);
			// The rebind button should be disabled when not quiet
			const btn = Array.from(document.querySelectorAll('button')).find((b) =>
				/rebind/i.test(b.textContent ?? '')
			) as HTMLButtonElement | undefined;
			expect(btn).toBeTruthy();
			expect(btn!.disabled).toBe(true);
		} finally {
			unmount(component);
		}
	});

	it('blocks rebind when a MODEL-scope lease is live', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		seedLocks('e1');
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await pickAndDiff();
			const btn = Array.from(document.querySelectorAll('button')).find((b) =>
				/rebind/i.test(b.textContent ?? '')
			) as HTMLButtonElement | undefined;
			expect(btn).toBeTruthy();
			expect(btn!.disabled).toBe(true);
		} finally {
			unmount(component);
		}
	});

	it('STAYS ENABLED while only an art: lease is live (regression)', async () => {
		// An `art:` lease just means someone has an artifact editor tab open. A
		// rebind rewrites MODEL content; gating on it disabled Swap metamodel for
		// the whole project, for the full lock TTL, whenever anyone had a table or
		// navigation open.
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		seedLocks('art:a9');
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await pickAndDiff();
			expect(/needs a quiet project/i.test(bodyText())).toBe(false);
			const btn = Array.from(document.querySelectorAll('button')).find((b) =>
				/rebind/i.test(b.textContent ?? '')
			) as HTMLButtonElement | undefined;
			expect(btn).toBeTruthy();
			expect(btn!.disabled).toBe(false);
		} finally {
			unmount(component);
		}
	});

	it('on success refreshes metamodel, issues, summary and closes', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		(rebindMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			model_rev: 8,
			metamodel_id: 'mm-2',
			validation_error_count: 1,
			issue_counts: { conformance: 1 },
			issues: [
				{ severity: 'error', message: 'x unknown', target_ids: ['x'], category: 'conformance' }
			]
		});
		(fetchMetamodel as ReturnType<typeof vi.fn>).mockResolvedValue({
			elements: [],
			relationships: []
		});
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await pickAndDiff();
			const btn = Array.from(document.querySelectorAll('button')).find((b) =>
				/rebind/i.test(b.textContent ?? '')
			) as HTMLButtonElement | undefined;
			expect(btn).toBeTruthy();
			btn!.click();
			await waitFor(() => (rebindMetamodel as ReturnType<typeof vi.fn>).mock.calls.length > 0);
			expect(rebindMetamodel).toHaveBeenCalledWith('elements: []\n', { baseRev: 7, message: '' });
			await waitFor(() => (fetchMetamodel as ReturnType<typeof vi.fn>).mock.calls.length > 0);
			expect(fetchMetamodel).toHaveBeenCalled();
			await waitFor(() => (setIssues as ReturnType<typeof vi.fn>).mock.calls.length > 0);
			expect(setIssues).toHaveBeenCalled();
			await waitFor(() => (refreshSummary as ReturnType<typeof vi.fn>).mock.calls.length > 0);
			expect(refreshSummary).toHaveBeenCalled();
		} finally {
			unmount(component);
		}
	});

	it('shows a stale-rev message on 409 base_rev', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		// Fabricate a real ApiError (status 409) so instanceof check in the component works
		const err = new ApiError(409, { detail: 'stale base_rev' }, 'stale base_rev');
		(rebindMetamodel as ReturnType<typeof vi.fn>).mockRejectedValue(err);
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await pickAndDiff();
			const btn = Array.from(document.querySelectorAll('button')).find((b) =>
				/rebind/i.test(b.textContent ?? '')
			) as HTMLButtonElement | undefined;
			expect(btn).toBeTruthy();
			btn!.click();
			await waitFor(() => /re-run the diff/i.test(bodyText()));
			expect(/re-run the diff/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});

	it('shows an active-locks message on 409 with lock detail', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		// detail contains "lock" → component shows the active-locks message, not stale-rev
		const err = new ApiError(
			409,
			{ detail: 'active locks; rebind requires a quiet project' },
			'active locks; rebind requires a quiet project'
		);
		(rebindMetamodel as ReturnType<typeof vi.fn>).mockRejectedValue(err);
		const component = mount(SwapMetamodelDrawer, {
			target: document.body,
			props: { open: true }
		});
		try {
			flushSync();
			await pickAndDiff();
			const btn = Array.from(document.querySelectorAll('button')).find((b) =>
				/rebind/i.test(b.textContent ?? '')
			) as HTMLButtonElement | undefined;
			expect(btn).toBeTruthy();
			btn!.click();
			await waitFor(() => /not quiet|lock is active/i.test(bodyText()));
			expect(/not quiet|lock is active/i.test(bodyText())).toBe(true);
		} finally {
			unmount(component);
		}
	});
});
