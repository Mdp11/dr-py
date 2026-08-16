/**
 * Project (re)entry must drop the staged METAMODEL moves, for exactly the
 * reason `WorkspacePage.viewreset.test.ts` gives for the staged view journal.
 *
 * `metamodel-stage.svelte.ts` is a module-scope singleton whose `_moves` name
 * diagram nodes of ONE project's metamodel. It is re-pointed only by
 * `initMetamodelStage`, which the metamodel TAB's init calls — so an in-SPA
 * switch from project A to project B where the user never opens B's metamodel
 * tab leaves A's moves staged, and `commitStaged` reads them unconditionally:
 * any model/artifact/view commit in B would silently carry A's
 * `metamodel.move_node` ops.
 *
 * `closeMetamodelStage()` is the right hammer (not `discardStagedNodeMoves`):
 * it drops the in-memory copy and un-points the project while deliberately
 * LEAVING A's localStorage mirror intact, so switching back to A restores the
 * work rather than destroying it.
 *
 * Same stub harness as the view-reset test (real state, faked network).
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
import {
	closeMetamodelStage,
	getStagedNodeMoves,
	initMetamodelStage,
	stageNodeMove
} from '$lib/state/metamodel-stage.svelte';

beforeEach(() => {
	localStorage.clear();
	closeMetamodelStage();
});

afterEach(() => {
	document.body.innerHTML = '';
	localStorage.clear();
	closeMetamodelStage();
	vi.clearAllMocks();
});

async function settle() {
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('project (re)entry drops the staged metamodel node moves', () => {
	it('boot() clears moves left behind by a previously-open project', async () => {
		initMetamodelStage('project-a');
		stageNodeMove('el:Pump', { x: 10, y: 20 });
		expect(getStagedNodeMoves().size).toBe(1);

		const c = mount(Page, { target: document.body });
		await settle();

		expect(getStagedNodeMoves().size).toBe(0);
		unmount(c);
	});

	it("leaves the previous project's persisted moves recoverable", async () => {
		initMetamodelStage('project-a');
		stageNodeMove('el:Pump', { x: 10, y: 20 });

		const c = mount(Page, { target: document.body });
		await settle();
		expect(getStagedNodeMoves().size).toBe(0);

		// Switching back re-opens A's stage and finds the work where it was left
		// — the moves were dropped from memory, not discarded.
		initMetamodelStage('project-a');
		expect(getStagedNodeMoves().size).toBe(1);

		unmount(c);
	});
});
