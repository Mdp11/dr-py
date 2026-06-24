import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import DiffDrawer from '../DiffDrawer.svelte';

// Mock all $lib/state functions that DiffDrawer imports
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getStagedDiff: vi.fn(() => ({
			elements: [{ id: 'e1', type_name: 'Node', status: 'added', before: null, after: { id: 'e1', type_name: 'Node', properties: {}, rev: 1 } }],
			relationships: [],
			counts: { added: 1, modified: 0, deleted: 0 }
		})),
		previewStaged: vi.fn(async () => ({
			conformance_error_count: 2,
			structural_blockers: [],
			issues: [],
			would_block: true
		})),
		commitStaged: vi.fn(async () => {}),
		discardAll: vi.fn(async () => {}),
		discardElement: vi.fn(async () => {}),
		ensureElement: vi.fn(async () => {}),
		getIssues: vi.fn(() => []),
		indexIssues: vi.fn(() => ({ byEntity: new Map(), all: [] })),
		getView: vi.fn(() => null),
		getViewChanges: vi.fn(() => []),
		getViewFileHandle: vi.fn(() => null),
		getViewFilename: vi.fn(() => null),
		setViewFileHandle: vi.fn(),
		setViewFilename: vi.fn(),
		setViewBaseline: vi.fn(),
		getCachedElements: vi.fn(() => new Map()),
		viewChangeSegments: vi.fn(() => [])
	};
});

import { previewStaged } from '$lib/state';

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

describe('DiffDrawer strict-mode gating', () => {
	it('disables commit button and shows strict-mode message when preview returns would_block: true', async () => {
		(previewStaged as ReturnType<typeof vi.fn>).mockResolvedValue({
			conformance_error_count: 2,
			structural_blockers: [],
			issues: [],
			would_block: true
		});

		const c = mount(DiffDrawer, { target: document.body, props: { open: true } });
		flushSync();

		// Wait for the preview to be loaded (loading state cleared)
		await waitFor(() => !/loading/i.test(document.body.textContent ?? ''));
		flushSync();

		// The commit button should be disabled
		const commitBtn = Array.from(document.querySelectorAll('button')).find((b) =>
			/commit/i.test(b.textContent ?? '')
		) as HTMLButtonElement | undefined;
		expect(commitBtn).toBeTruthy();
		expect(commitBtn!.disabled).toBe(true);

		// A strict-mode message should be shown
		expect(document.body.textContent?.toLowerCase()).toMatch(/strict mode/i);

		unmount(c);
	});
});
