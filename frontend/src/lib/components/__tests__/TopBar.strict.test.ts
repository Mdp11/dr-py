import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import TopBar from '../TopBar.svelte';

// $app/paths is a SvelteKit runtime module aliased to a stub in vitest.config.ts.
vi.mock('$app/paths', () => ({
	resolve: vi.fn((p: string) => p),
	base: '',
	assets: ''
}));

// Svelte 5 components are compiled to functions (anchor, props) => void.
// Provide a minimal no-op stub for each dialog/drawer child of TopBar so we
// don't need QueryClientProvider or other heavy contexts.
vi.mock('../ApplyCrDialog.svelte', () => ({ default: () => {} }));
vi.mock('../LoadFilesDialog.svelte', () => ({ default: () => {} }));
vi.mock('../SwapMetamodelDrawer.svelte', () => ({ default: () => {} }));
vi.mock('../SettingsDialog.svelte', () => ({ default: () => {} }));

// Mock $lib/state — spread actual so all other exports stay real;
// override only what TopBar needs + getStrictMode for this test.
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
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
		// Test-controlled strict mode — default off
		getStrictMode: vi.fn(() => false)
	};
});

vi.mock('$lib/state/validate-action', () => ({
	runValidation: vi.fn(async () => {})
}));

vi.mock('$lib/api/model-read', () => ({ downloadModel: vi.fn(async () => new Response()) }));
vi.mock('$lib/util/fileSave', () => ({ saveResponseToFile: vi.fn(async () => {}) }));

import { getStrictMode } from '$lib/state';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('TopBar strict-mode indicator', () => {
	it('hides the strict-mode badge when getStrictMode() returns false', () => {
		(getStrictMode as ReturnType<typeof vi.fn>).mockReturnValue(false);

		const c = mount(TopBar, { target: document.body });
		flushSync();

		const text = document.body.textContent ?? '';
		expect(/strict/i.test(text)).toBe(false);

		unmount(c);
	});

	it('shows the strict-mode badge when getStrictMode() returns true', () => {
		(getStrictMode as ReturnType<typeof vi.fn>).mockReturnValue(true);

		const c = mount(TopBar, { target: document.body });
		flushSync();

		const text = document.body.textContent ?? '';
		expect(/strict/i.test(text)).toBe(true);

		unmount(c);
	});
});
