import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import DiffDrawer from '../DiffDrawer.svelte';

// Mock all $lib/state functions that DiffDrawer imports
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getStagedDiff: vi.fn(() => ({
			elements: [
				{
					id: 'e1',
					type_name: 'Node',
					status: 'added',
					before: null,
					after: { id: 'e1', type_name: 'Node', properties: {}, rev: 1 }
				}
			],
			relationships: [],
			counts: { added: 1, modified: 0, deleted: 0 }
		})),
		previewStaged: vi.fn(async () => ({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: false
		})),
		commitStaged: vi.fn(async () => {}),
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
		discardViewChanges: vi.fn(async () => {})
	};
});

import { previewStaged } from '$lib/state';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

const REASON = 'rebind leaves 7 entities the new metamodel cannot hold: g0, g1, g2, g3, g4';

const commitButton = () =>
	Array.from(document.querySelectorAll('button')).find((b) =>
		/^commit/i.test(b.textContent?.trim() ?? '')
	) as HTMLButtonElement | undefined;

/** Mounts the drawer open and lets the preview land. */
async function previewed(preview: object) {
	(previewStaged as ReturnType<typeof vi.fn>).mockResolvedValue(preview);
	const c = mount(DiffDrawer, { target: document.body, props: { open: true } });
	flushSync();
	for (let i = 0; i < 5; i++) await tick();
	return c;
}

describe('DiffDrawer with a rebind the server would refuse', () => {
	it("shows the server's 422 text with how to proceed, and does not offer the commit", async () => {
		const c = await previewed({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: true,
			block_reason: REASON
		});

		const note = document.querySelector('[data-testid="rebind-block"]');
		expect(note?.textContent).toContain(`Commit blocked: ${REASON}`);
		expect(note?.textContent).toMatch(/Delete or migrate those rows in an earlier commit/);
		expect(note?.textContent).toMatch(/Renaming a type that has instances is refused/);
		expect(document.body.textContent).not.toMatch(/strict mode/i);
		expect(commitButton()!.disabled).toBe(true);

		unmount(c);
	});

	it('offers the commit of a rebind nothing blocks', async () => {
		const c = await previewed({
			conformance_error_count: 0,
			structural_blockers: [],
			issues: [],
			would_block: false
		});

		expect(document.querySelector('[data-testid="rebind-block"]')).toBeNull();
		expect(commitButton()!.disabled).toBe(false);

		unmount(c);
	});
});
