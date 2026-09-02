import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TopBar from '../TopBar.svelte';
import { getPendingConfirm, resetConfirm } from '$lib/state/confirm.svelte';

// Svelte 5 components are compiled to functions (anchor, props) => void.
// Provide a minimal no-op stub for each dialog/drawer child of TopBar so we
// don't need QueryClientProvider or other heavy contexts.
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
import {
	getMetamodel,
	getModelSummary,
	getStagedViewDepth,
	setHistoryDrawerOpen
} from '$lib/state';
import { downloadModel } from '$lib/api/model-read';
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

function openModelMenu(): void {
	document.querySelector<HTMLButtonElement>('[data-testid="model-menu-trigger"]')!.click();
	flushSync();
}

function menuItem(label: string): HTMLElement | undefined {
	return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
		(i) => i.textContent?.trim() === label
	);
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
			// would leave the commit drawer unreachable for such a batch.
			vi.mocked(getModelSummary).mockReturnValue(SUMMARY as never);
			stageArtifactCreate('navigation', 'N', {}, null);

			const c = mount(TopBar, { target: document.body });
			flushSync();

			expect(findButton(/commit/i)?.disabled).toBe(false);
			expect(document.body.textContent).toContain('● 1');

			unmount(c);
		});
	});

	// The "Metamodel" control opens the in-app metamodel editor tab; there is
	// no "Swap Metamodel" drawer.
	describe('Metamodel button', () => {
		it('opens the metamodel tab and offers no Swap Metamodel entry', () => {
			vi.mocked(getMetamodel).mockReturnValue({ elements: [], relationships: [] } as never);

			const c = mount(TopBar, { target: document.body });
			flushSync();

			expect(document.body.textContent).not.toContain('Edit Metamodel');
			expect(document.body.textContent).not.toContain('Swap Metamodel');
			expect(getDynamicTabs()).toHaveLength(0);

			findButton(/metamodel/i)!.click();
			flushSync();

			expect(getDynamicTabs().some((t) => t.kind === 'metamodel')).toBe(true);

			unmount(c);
		});

		it('is disabled with no metamodel loaded', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			expect(findButton(/metamodel/i)?.disabled).toBe(true);

			unmount(c);
		});
	});

	// Six left-nav controls in a fixed order, with Compare/Apply CR/Export/History folded into the Model dropdown.
	describe('top bar layout', () => {
		it('renders Metamodel · Model · View · Issues · Artifacts · Settings, in order', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			const nav = document.querySelector('nav[aria-label="Toolbar"]')!;
			const labels = [...nav.querySelectorAll('button, a')].map((n) => n.textContent?.trim());
			expect(labels).toEqual(['Metamodel', 'Model', 'View', 'Issues', 'Artifacts', 'Settings']);
			expect(document.querySelector('[aria-label="More actions"]')).toBeNull();
			expect(document.querySelector('[title="Command palette"]')).toBeNull();

			unmount(c);
		});

		it('Issues opens the issues tab', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			findButton(/issues/i)!.click();
			flushSync();

			expect(getDynamicTabs().some((t) => t.kind === 'issues')).toBe(true);

			unmount(c);
		});
	});

	// History, Compare, Apply CR and Export live in the Model dropdown, the same
	// treatment as the Artifacts menu, rather than as flat controls.
	describe('Model menu', () => {
		it('offers History, Compare…, Apply CR… and Export, in order', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();

			const items = [...document.querySelectorAll('[role="menuitem"]')].map((n) =>
				n.textContent?.trim()
			);
			expect(items).toEqual(['History', 'Compare…', 'Apply CR…', 'Export']);

			unmount(c);
		});

		it('History opens the history drawer', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();
			menuItem('History')!.click();
			flushSync();

			expect(setHistoryDrawerOpen).toHaveBeenCalledWith(true);

			unmount(c);
		});

		it('Compare… opens the compare dialog', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();
			menuItem('Compare…')!.click();
			flushSync();

			expect(document.body.textContent).toContain('Compare models');
			expect(goto).not.toHaveBeenCalled();

			unmount(c);
		});

		it('Apply CR… opens the apply-cr dialog', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();
			menuItem('Apply CR…')!.click();
			flushSync();

			expect(document.body.textContent).toContain('Apply change requests');

			unmount(c);
		});

		it('Export is disabled without a model', () => {
			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();

			expect(menuItem('Export')!.getAttribute('aria-disabled')).toBe('true');

			unmount(c);
		});

		it('Export downloads the model when one is loaded', async () => {
			vi.mocked(getModelSummary).mockReturnValue(SUMMARY as never);

			const c = mount(TopBar, { target: document.body });
			flushSync();

			openModelMenu();
			menuItem('Export')!.click();
			flushSync();
			await new Promise((r) => setTimeout(r, 0));

			expect(downloadModel).toHaveBeenCalled();

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
