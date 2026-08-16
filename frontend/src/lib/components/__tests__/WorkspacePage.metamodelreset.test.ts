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

/** `vi.hoisted` because the `$lib/api/metamodel` factory below is hoisted above
 * every plain module-scope const. */
const BASE = vi.hoisted(() => '# base\nelements: []\n');

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
	getMetamodel: () => Promise.reject(new Error('no mm')),
	// The draft half of the family needs a loadable baseline: `initMetamodelEditor`
	// is the only way into the `ready` phase, and only a `ready` editor
	// contributes a `metamodel.rebind` to the staged batch.
	getMetamodelRaw: () => Promise.resolve({ blob: BASE, source: 'stored' as const }),
	lintMetamodel: () => Promise.resolve({ ok: true, errors: [] })
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
import * as lockApi from '$lib/api/checkout';
import { resetCheckout, setProjectInfo } from '$lib/state/checkout.svelte';
import {
	editMetamodelBuffer,
	initMetamodelEditor,
	resetMetamodelEditor
} from '$lib/state/metamodel-editor.svelte';
import {
	closeMetamodelStage,
	getStagedMetamodelOps,
	getStagedNodeMoves,
	initMetamodelStage,
	stageNodeMove
} from '$lib/state/metamodel-stage.svelte';
import { setModelError } from '$lib/state/model.svelte';
import type { LockResponse } from '$lib/api/types';

const LEASE: LockResponse = {
	token: 't-mm',
	leases: [
		{
			resource_id: 'mm',
			mode: 'exclusive',
			holder: 'default-user',
			holder_email: 'default@example.com',
			token: 't-mm',
			intent: 'edit',
			expires_at: 1
		}
	]
};

beforeEach(() => {
	localStorage.clear();
	closeMetamodelStage();
	resetMetamodelEditor();
	resetCheckout();
	setModelError(null);
});

afterEach(() => {
	document.body.innerHTML = '';
	localStorage.clear();
	closeMetamodelStage();
	resetMetamodelEditor();
	resetCheckout();
	setModelError(null);
	vi.clearAllMocks();
	vi.restoreAllMocks();
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

describe('conflict-recovery reload drops the staged metamodel node moves', () => {
	it('onReloadModel() clears moves whose mm lease it just discarded', async () => {
		// The SECOND door onto the same 409. `resetCheckout()` empties the lock
		// registry, and the `mm` token goes with the `folder:` ones the view
		// journal is reset for — so staged moves that survived a reload would be
		// sent at the next commit with no `mm` token attached, i.e. a hard
		// "required lock not held".
		setModelError({ kind: 'conflict', message: 'stale rev' });
		const c = mount(Page, { target: document.body });
		await settle();

		// Stage AFTER boot, so this exercises the reload path and not boot's own
		// clear (boot ran on mount above and would have wiped anything earlier).
		initMetamodelStage('project-a');
		stageNodeMove('el:Pump', { x: 10, y: 20 });
		expect(getStagedNodeMoves().size).toBe(1);

		const reload = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Reload model'
		);
		expect(reload).toBeDefined();
		reload!.click();
		await settle();

		expect(getStagedNodeMoves().size).toBe(0);
		unmount(c);
	});
});

/**
 * The DRAFT half of the same family (final-review Finding 3). The moves above
 * were the obvious leak; the YAML buffer is the other one, and it was the only
 * one of the four staged families with no cross-project boot reset:
 * `metamodel-editor.svelte.ts` holds `_baseline`/`_buffer`/`_phase` at module
 * scope and registers a provider the stage reads UNCONDITIONALLY at batch-build
 * time, so an in-SPA switch from A to B where the tab is not re-initialised
 * emits project A's YAML as a `metamodel.rebind` inside B's commit batch.
 */
describe('project (re)entry resets the metamodel YAML draft', () => {
	it('boot() drops a dirty buffer left behind by the previous project', async () => {
		vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
		await initMetamodelEditor('project-a');
		editMetamodelBuffer(`${BASE}# only-in-A\n`);
		expect(getStagedMetamodelOps()).toEqual([
			{ kind: 'metamodel.rebind', blob: `${BASE}# only-in-A\n` }
		]);

		const c = mount(Page, { target: document.body });
		await settle();

		// Project B's next commit carries nothing of A's.
		expect(getStagedMetamodelOps()).toEqual([]);
		unmount(c);
	});
});
