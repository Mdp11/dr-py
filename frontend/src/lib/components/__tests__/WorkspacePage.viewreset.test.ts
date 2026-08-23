/**
 * The two RESET paths that must take the staged-view-op journal with them.
 *
 * The journal (`view-edits.svelte.ts`) is a module-scope singleton, and its
 * ops name `folder:` ids that only mean anything for one project at one rev.
 * Two page-level resets therefore have to clear it:
 *
 *  - boot(): an in-SPA project switch would otherwise carry project A's staged
 *    view ops into project B and offer them for commit there.
 *  - onReloadModel(): the conflict-recovery "Reload model" banner resets the
 *    checkout store, dropping every `folder:` lease from the registry — a
 *    journal that survived that would be sent at the next commit with no
 *    folder tokens attached, i.e. a hard 409 "required lock not held".
 *
 * Mounted with the same stub harness as WorkspacePage.feedbanner.test.ts (real
 * state, faked network).
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
	metamodel: { getMetamodel: () => Promise.reject(new Error('no mm')) }
}));
vi.mock('$lib/api/metamodel', () => ({
	getMetamodel: () => Promise.reject(new Error('no mm'))
}));
vi.mock('$lib/state/validate-action', () => ({ runValidation: () => Promise.resolve() }));
vi.mock('$lib/state/session-recovery', () => ({
	recoverFromUnauthorized: () => Promise.resolve()
}));
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
		trackOpenProgress: () => Promise.resolve(),
		loadProjectInfo: () => Promise.resolve(),
		loadArtifacts: () => Promise.resolve(),
		reactToBootError: () => false,
		setAccessNotice: () => {}
	};
});

import Page from '../../../routes/p/[projectId]/+page.svelte';
import { getStagedViewDepth, resetViewEdits, stageViewOp } from '$lib/state/view-edits.svelte';
import { setModelError } from '$lib/state/model.svelte';

function stageOne(): void {
	stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'Renamed' }, 'Renamed folder');
}

beforeEach(() => {
	resetViewEdits();
	setModelError(null);
});

afterEach(() => {
	document.body.innerHTML = '';
	setModelError(null);
	resetViewEdits();
	vi.clearAllMocks();
});

async function settle() {
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('project (re)entry drops the staged view journal', () => {
	it('boot() clears ops left behind by a previously-open project', async () => {
		stageOne();
		expect(getStagedViewDepth()).toBe(1);

		const c = mount(Page, { target: document.body });
		await settle();

		expect(getStagedViewDepth()).toBe(0);
		unmount(c);
	});
});

describe('conflict-recovery reload drops the staged view journal', () => {
	it('onReloadModel() clears ops whose folder leases it just discarded', async () => {
		setModelError({ kind: 'conflict', message: 'stale rev' });
		const c = mount(Page, { target: document.body });
		await settle();

		// Stage AFTER boot, so we are testing the reload path and not boot's own
		// clear (boot ran on mount above and would have wiped anything earlier).
		stageOne();
		expect(getStagedViewDepth()).toBe(1);

		const reload = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Reload model'
		);
		expect(reload).toBeDefined();
		reload!.click();
		await settle();

		expect(getStagedViewDepth()).toBe(0);
		unmount(c);
	});
});
