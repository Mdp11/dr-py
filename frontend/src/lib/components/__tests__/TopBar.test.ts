import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TopBar from '../TopBar.svelte';
import { getPendingConfirm, resetConfirm } from '$lib/state/confirm.svelte';

// Svelte 5 components are compiled to functions (anchor, props) => void.
// Provide a minimal no-op stub for each dialog/drawer child of TopBar so we
// don't need QueryClientProvider or other heavy contexts.
vi.mock('../ApplyCrDialog.svelte', () => ({ default: () => {} }));
vi.mock('../SettingsDialog.svelte', () => ({ default: () => {} }));

const goto = vi.fn();
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));

// Mock $lib/state — spread actual so all other exports stay real; override
// only what TopBar needs with benign defaults so the component mounts.
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getActiveProjectId: vi.fn(() => 'p1'),
		getFilename: vi.fn(() => null),
		getMetamodelFilename: vi.fn(() => null),
		getViewFilename: vi.fn(() => null),
		getMetamodel: vi.fn(() => null),
		getModelSummary: vi.fn(() => null),
		getModelRev: vi.fn(() => 0),
		getModelGeneration: vi.fn(() => 0),
		getStagedChangeCount: vi.fn(() => 0),
		getStagedViewDepth: vi.fn(() => 0),
		getStagedDepth: vi.fn(() => 0),
		isRunning: vi.fn(() => false),
		getEffectiveIssues: vi.fn(() => []),
		getLastRunAt: vi.fn(() => null),
		getLastError: vi.fn(() => null),
		getView: vi.fn(() => null),
		refreshSummary: vi.fn(async () => {}),
		popLastStaged: vi.fn(),
		setDiffDrawerOpen: vi.fn(),
		setHistoryDrawerOpen: vi.fn(),
		getStrictMode: vi.fn(() => false)
	};
});

vi.mock('$lib/state/validate-action', () => ({
	runValidation: vi.fn(async () => {})
}));

vi.mock('$lib/api/model-read', () => ({ downloadModel: vi.fn(async () => new Response()) }));
vi.mock('$lib/util/fileSave', () => ({ saveResponseToFile: vi.fn(async () => {}) }));

// Imported AFTER the vi.mock factory above so these are the mocked bindings;
// the artifact-edits store is deliberately NOT mocked (the `...actual` spread
// keeps it real) so the Commit gate is exercised against the real staged
// buffer rather than a stub.
import { getMetamodel, getModelSummary, getStagedViewDepth } from '$lib/state';
import { resetArtifactEdits, stageArtifactCreate } from '$lib/state/artifact-edits.svelte';
// The workspace tab store is deliberately NOT mocked (the `...actual` spread
// keeps it real), so the menu item is asserted through the tab it opens.
import { getDynamicTabs, resetWorkspaceTabs } from '$lib/state/workspace.svelte';

const SUMMARY = {
	model_rev: 1,
	element_count: 0,
	relationship_count: 0,
	elements_by_type: {},
	issue_counts: null,
	undo_depth: 0
};

function findButton(name: RegExp): HTMLButtonElement | undefined {
	return [...document.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

beforeEach(() => {
	resetWorkspaceTabs();
});

afterEach(() => {
	resetConfirm();
	resetArtifactEdits();
	resetWorkspaceTabs();
	document.body.innerHTML = '';
	// clearAllMocks() only clears CALLS, not implementations, so a test that
	// installed a non-null summary would leak it into the next one.
	vi.mocked(getModelSummary).mockReturnValue(null);
	vi.mocked(getStagedViewDepth).mockReturnValue(0);
	vi.mocked(getMetamodel).mockReturnValue(null);
	vi.clearAllMocks();
});

describe('TopBar', () => {
	it('has no "Load Model" button', () => {
		const c = mount(TopBar, { target: document.body });
		flushSync();

		expect(findButton(/load model/i)).toBeUndefined();

		unmount(c);
	});

	// goHome is async: leaving now clears its unsaved-changes gate through the
	// in-app `confirm()` helper instead of the browser's blocking dialog. With
	// no staged changes the gate short-circuits without prompting, but the
	// navigation still lands a microtask later.
	it('home link navigates to /projects', async () => {
		const c = mount(TopBar, { target: document.body });
		flushSync();

		const homeButton = document.querySelector<HTMLButtonElement>('[aria-label="Data Rover"]');
		homeButton!.click();
		await new Promise((r) => setTimeout(r, 0));

		expect(getPendingConfirm()).toBeNull();
		expect(goto).toHaveBeenCalledWith('/projects');

		unmount(c);
	});

	describe('Commit gate', () => {
		it('is disabled with nothing staged at all', () => {
			vi.mocked(getModelSummary).mockReturnValue(SUMMARY as never);

			const c = mount(TopBar, { target: document.body });
			flushSync();

			expect(findButton(/commit/i)?.disabled).toBe(true);

			unmount(c);
		});

		it('an artifact-only staged batch enables Commit and counts as a change', () => {
			// The whole slice hangs off this: an artifact edit stages nothing in the
			// MODEL buffer, so a Commit gate that only summed getStagedChangeCount()
			// would leave the drawer reachable only via the command palette.
			vi.mocked(getModelSummary).mockReturnValue(SUMMARY as never);
			stageArtifactCreate('navigation', 'N', {}, null);

			const c = mount(TopBar, { target: document.body });
			flushSync();

			expect(findButton(/commit/i)?.disabled).toBe(false);
			expect(document.body.textContent).toContain('● 1');

			unmount(c);
		});
	});

	// The old "Swap Metamodel" drawer is gone; the overflow menu now opens the
	// in-app metamodel editor tab instead.
	describe('Edit Metamodel item', () => {
		function openOverflowMenu(): void {
			document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!.click();
			flushSync();
		}

		function metamodelItem(): HTMLElement | undefined {
			return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
				(n) => n.textContent?.trim() === 'Edit Metamodel'
			);
		}

		it('opens the metamodel tab and offers no Swap Metamodel entry', () => {
			vi.mocked(getMetamodel).mockReturnValue({ elements: [], relationships: [] } as never);

			const c = mount(TopBar, { target: document.body });
			flushSync();
			openOverflowMenu();

			expect(document.body.textContent).toContain('Edit Metamodel');
			expect(document.body.textContent).not.toContain('Swap Metamodel');
			expect(getDynamicTabs()).toHaveLength(0);

			metamodelItem()!.click();
			flushSync();

			expect(getDynamicTabs().some((t) => t.kind === 'metamodel')).toBe(true);

			unmount(c);
		});

		it('is disabled with no metamodel loaded', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();
			openOverflowMenu();

			expect(metamodelItem()?.getAttribute('aria-disabled')).toBe('true');

			unmount(c);
		});
	});

	describe('view change counter', () => {
		// The badge composes the staged VIEW-OP JOURNAL's depth
		// (`getStagedViewDepth`), not a baseline diff count — this is the
		// TopBar half of the journal switch (DiffDrawer.view.test.ts covers
		// the drawer half).
		it('reflects the staged view-op journal depth', () => {
			vi.mocked(getModelSummary).mockReturnValue(SUMMARY as never);
			vi.mocked(getStagedViewDepth).mockReturnValue(3);

			const c = mount(TopBar, { target: document.body });
			flushSync();

			expect(document.body.textContent).toContain('● 3');

			unmount(c);
		});
	});
});
