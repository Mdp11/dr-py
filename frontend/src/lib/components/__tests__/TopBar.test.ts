import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TopBar from '../TopBar.svelte';

// Svelte 5 components are compiled to functions (anchor, props) => void.
// Provide a minimal no-op stub for each dialog/drawer child of TopBar so we
// don't need QueryClientProvider or other heavy contexts.
vi.mock('../ApplyCrDialog.svelte', () => ({ default: () => {} }));
vi.mock('../LoadFilesDialog.svelte', () => ({ default: () => {} }));
vi.mock('../SwapMetamodelDrawer.svelte', () => ({ default: () => {} }));
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
		getViewChangesCount: vi.fn(() => 0),
		getStagedDepth: vi.fn(() => 0),
		isRunning: vi.fn(() => false),
		getIssues: vi.fn(() => []),
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

function findButton(name: RegExp): HTMLButtonElement | undefined {
	return [...document.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('TopBar', () => {
	it('has no "Load Model" button', () => {
		const c = mount(TopBar, { target: document.body });
		flushSync();

		expect(findButton(/load model/i)).toBeUndefined();

		unmount(c);
	});

	it('home link navigates to /projects', () => {
		const c = mount(TopBar, { target: document.body });
		flushSync();

		const homeButton = document.querySelector<HTMLButtonElement>('[aria-label="Data Rover"]');
		homeButton!.click();

		expect(goto).toHaveBeenCalledWith('/projects');

		unmount(c);
	});
});
