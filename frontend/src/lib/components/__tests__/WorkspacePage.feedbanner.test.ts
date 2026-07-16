/**
 * Minimal test suite for the feed-termination banner on the workspace page.
 * Mounts the full page component with stubbed API/state dependencies so we
 * can verify that terminal close codes map to the correct banner text without
 * spinning up a real backend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

// Mutable terminal code set before each test so the initial $derived reads it.
let _termCode: number | null = null;

// Mock $lib/state/realtime.svelte: preserve real exports but control getFeedTermination
// and no-op startRealtime/stopRealtime/onLockEvent to prevent feed connections.
vi.mock('$lib/state/realtime.svelte', async (orig) => {
	const real = (await orig()) as typeof import('$lib/state/realtime.svelte');
	return {
		...real,
		getFeedTermination: () => (_termCode !== null ? { code: _termCode } : null),
		startRealtime: () => {},
		stopRealtime: () => {},
		onLockEvent: () => () => {}
	};
});

// Stub @tanstack/svelte-query so child components (e.g. LoadFilesDialog via
// TopBar) don't require a QueryClientProvider in the test context.
vi.mock('@tanstack/svelte-query', () => ({
	createMutation: () => ({
		state: { status: 'idle', data: undefined, error: null },
		mutate: () => {},
		mutateAsync: async () => {},
		isPending: false,
		isError: false,
		isSuccess: false,
		isIdle: true,
		reset: () => {}
	}),
	QueryClientProvider: () => {},
	useQueryClient: () => ({})
}));

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p, assets: '' }));
vi.mock('$app/environment', () => ({ browser: false }));
// Boot calls metamodelApi.getMetamodel(); reject so boot() exits early from the catch.
vi.mock('$lib/api', () => ({
	metamodel: { getMetamodel: () => Promise.reject(new Error('no mm')) }
}));
vi.mock('$lib/api/metamodel', () => ({
	getMetamodel: () => Promise.reject(new Error('no mm'))
}));
vi.mock('$lib/state/validate-action', () => ({ runValidation: () => Promise.resolve() }));
vi.mock('$lib/state/session-recovery', () => ({
	recoverFromUnauthorized: () => Promise.resolve()
}));
// Override the parts of $lib/state that would make live network calls, but
// preserve the real reactive state so child components render without throwing.
vi.mock('$lib/state', async (orig) => {
	const real = (await orig()) as typeof import('$lib/state');
	return {
		...real,
		startRealtime: () => {},
		stopRealtime: () => {},
		onLockEvent: () => () => {},
		handleRemoteLockEvent: () => {},
		refreshSummary: () => Promise.resolve(),
		refreshView: () => Promise.resolve(),
		loadProjectInfo: () => Promise.resolve(),
		reactToBootError: () => false,
		setAccessNotice: () => {}
	};
});

import Page from '../../../routes/p/[projectId]/+page.svelte';

beforeEach(() => {
	_termCode = null;
});

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

async function settle() {
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('workspace feed-termination banner', () => {
	it('renders a "Realtime connection lost." fallback banner for terminal code 4408', async () => {
		_termCode = 4408;
		const c = mount(Page, { target: document.body });
		await settle();
		expect(document.body.textContent).toContain('Realtime connection lost.');
		unmount(c);
	});

	it('renders "Your session expired." for terminal code 4401', async () => {
		_termCode = 4401;
		const c = mount(Page, { target: document.body });
		await settle();
		expect(document.body.textContent).toContain('Your session expired.');
		unmount(c);
	});

	it('renders no termination banner when the feed is healthy (null)', async () => {
		_termCode = null;
		const c = mount(Page, { target: document.body });
		await settle();
		// The "Disconnected" label only appears when there is a termination.
		expect(document.body.textContent).not.toContain('Disconnected');
		unmount(c);
	});
});
