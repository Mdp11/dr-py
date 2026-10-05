/**
 * A boot that finds the replica blocked (artifacts that would not load, a
 * replica that could not be rebuilt) skips the content steps; they must run
 * once Retry clears the block. Same stub harness as
 * WorkspacePage.viewreset.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/state/realtime.svelte', async (orig) => {
	const real = (await orig()) as typeof import('$lib/state/realtime.svelte');
	return {
		...real,
		getFeedTermination: () => null,
		startRealtime: () => {},
		stopRealtime: () => {},
		onLockEvent: () => () => {}
	};
});

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
vi.mock('$lib/api', () => ({
	metamodel: { getMetamodel: () => Promise.resolve({ enums: {}, elements: [], relationships: [] }) }
}));
vi.mock('$lib/api/metamodel', () => ({
	getMetamodel: () => Promise.resolve({ enums: {}, elements: [], relationships: [] })
}));
vi.mock('$lib/state/validate-action', () => ({ runValidation: () => Promise.resolve() }));
vi.mock('$lib/state/session-recovery', () => ({
	recoverFromUnauthorized: () => Promise.resolve()
}));
const loaded = vi.hoisted(() => ({
	info: vi.fn(() => Promise.resolve()),
	artifacts: vi.fn(() => Promise.resolve())
}));
const boot = vi.hoisted(() => ({
	blocked: true,
	unblock: () => {},
	summaries: 0
}));

vi.mock('$lib/state', async (orig) => {
	const real = (await orig()) as typeof import('$lib/state');
	return {
		...real,
		isReplicaBlocked: () => boot.blocked,
		whenReplicaUnblocked: () => new Promise<void>((resolve) => (boot.unblock = resolve)),
		refetchIssues: () => Promise.resolve(),
		loadViews: () => Promise.resolve(),
		startRealtime: () => {},
		stopRealtime: () => {},
		onLockEvent: () => () => {},
		handleRemoteLockEvent: () => {},
		refreshSummary: () => {
			boot.summaries += 1;
			return boot.blocked ? Promise.reject(new Error('the replica is blocked')) : Promise.resolve();
		},
		refreshView: () => Promise.resolve(),
		trackOpenProgress: () => Promise.resolve(),
		loadProjectInfo: loaded.info,
		loadArtifacts: loaded.artifacts,
		reactToBootError: () => false,
		setAccessNotice: () => {}
	};
});

import Page from '../../../routes/p/[projectId]/+page.svelte';

beforeEach(() => {
	boot.blocked = true;
	boot.summaries = 0;
});

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

async function settle() {
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('a boot whose replica is blocked', () => {
	it('ends without the content steps, and runs them once, after the block clears', async () => {
		const c = mount(Page, { target: document.body });
		await settle();

		expect(boot.summaries).toBe(1);
		expect(loaded.info).not.toHaveBeenCalled();
		expect(loaded.artifacts).not.toHaveBeenCalled();

		boot.blocked = false;
		boot.unblock();
		await settle();

		expect(boot.summaries).toBe(2);
		expect(loaded.info).toHaveBeenCalledOnce();
		expect(loaded.artifacts).toHaveBeenCalledOnce();
		unmount(c);
	});
});
