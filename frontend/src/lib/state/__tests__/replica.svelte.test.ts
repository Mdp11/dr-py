import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { IDBFactory } from 'fake-indexeddb';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import { EngineUnavailableError } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import { evaluateNavigation } from '$lib/api/artifacts';
import { getElementsBatch } from '$lib/api/model-read';
import * as validationApi from '$lib/api/validation';
import { createSnapshotCache } from '$lib/engine/cache';
import type { EngineLink } from '$lib/engine/client';
import { FrameError } from '$lib/engine/frame';
import {
	OFF,
	replicaApi,
	type CommitFlight,
	type ReplicaStatus,
	type ReplicaSync,
	type SyncDeps
} from '$lib/engine/sync';
import { connectInProcess } from '$lib/engine/testing';
import { BASE, fakeProject, hold, PAGE_ORIGIN } from '$lib/engine/__tests__/support/project-server';
import {
	DE_ONLY,
	NOT_DE,
	parsed,
	ruleIssues,
	ruleSet,
	rulesPayload,
	yamlOf
} from '$lib/engine/__tests__/support/rules';
import type { ArtifactPayload } from '$lib/api/types';
import * as openJourney from '../open-journey';
import { commitStaged, resetCheckout, setProjectInfo } from '../checkout.svelte';
import { clearActiveProject, setActiveProject } from '../active-project.svelte';
import {
	clearStagedArtifacts,
	getStagedArtifactDepth,
	notifyArtifactCommit,
	resetArtifactEdits,
	stageArtifactCreate,
	stageArtifactUpdate
} from '../artifact-edits.svelte';
import {
	beginReplicaCommit,
	configureReplica,
	exportsIncludeStaged,
	metamodelIncludesStaged,
	forgetViewPlacement,
	forgetViewPlacements,
	getReplicaBlockReason,
	getReplicaStatus,
	handReplicaFeed,
	isReplicaBlocked,
	isReplicaRetrying,
	registerViewPlacement,
	replicaGate,
	replicaMetamodelAdopted,
	resetReplica,
	retryReplica,
	startReplica,
	stopReplica,
	subscribeReplicaStatus,
	whenReplicaUnblocked
} from '../replica.svelte';
import * as modelEngine from '../model-engine.svelte';
import {
	applyDelta,
	cancelIssuesRefetch,
	emit,
	ensureElements,
	getLiveIssues,
	getModelError,
	getStagedBatchIds,
	getStagedConflicts,
	getStagedOps,
	getStructureRev,
	refetchIssues,
	revertAllStaged,
	stagedSettled
} from '../model.svelte';
import {
	create,
	engineStore,
	forceFailed,
	nameOf,
	peerDelta,
	rename,
	settled,
	type EngineStore
} from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const links: EngineLink[] = [];

afterEach(() => {
	resetReplica();
	for (const link of links.splice(0)) link.dispose();
	clearActiveProject();
	server.resetHandlers();
	vi.restoreAllMocks();
});

/**
 * The real engine over a port, the real replica API against the fake
 * project's routes, a fresh cache and an instant sleep. `until` resolves on
 * the first status, from `from` on (default: from now on, so an already-
 * recorded status of the same shape as an earlier call does not resolve it
 * again), that passes its test; an explicit `from` reaches back into history
 * — for what the engine starts on its own, such as the background digest
 * check, which may already have run by the time a second `until` is called.
 */
function realReplica(overrides: Partial<SyncDeps> = {}) {
	const statuses: ReplicaStatus[] = [];
	const watchers: { from: number; test: (s: ReplicaStatus) => boolean; resolve(): void }[] = [];
	const connect = vi.fn(() => {
		const link = connectInProcess();
		links.push(link);
		return Promise.resolve(link);
	});
	configureReplica({
		deps: {
			connect,
			api: replicaApi(BASE),
			cache: createSnapshotCache({ factory: new IDBFactory() }),
			sleep: () => Promise.resolve(),
			onStatus: (status) => {
				statuses.push(status);
				for (const watcher of [...watchers]) {
					if (watcher.test(status)) {
						watchers.splice(watchers.indexOf(watcher), 1);
						watcher.resolve();
					}
				}
			},
			...overrides
		}
	});
	return {
		connect,
		statuses,
		until: (test: (s: ReplicaStatus) => boolean, from = statuses.length) => {
			if (statuses.slice(from).some(test)) return Promise.resolve();
			return new Promise<void>((resolve) => watchers.push({ from, test, resolve }));
		}
	};
}

/** A sync that records what it is told and does nothing; its status is `status`. */
function spySync(
	flight: CommitFlight = { settle: vi.fn(), abandon: vi.fn() },
	status: { current: ReplicaStatus } = { current: OFF }
) {
	return {
		open: vi.fn(),
		stop: vi.fn(),
		status: vi.fn(() => status.current),
		settled: vi.fn(() => Promise.resolve()),
		feedCommit: vi.fn(),
		feedRebind: vi.fn(),
		feedSnapshot: vi.fn(),
		feedReset: vi.fn(),
		retry: vi.fn(),
		beginCommit: vi.fn(() => flight),
		metamodelAdopted: vi.fn(),
		call: vi.fn(),
		on: vi.fn(() => () => {}),
		setViewPlacement: vi.fn(),
		dropViewPlacement: vi.fn(),
		setArtifacts: vi.fn(),
		putArtifacts: vi.fn(),
		setStagedArtifacts: vi.fn()
	} satisfies ReplicaSync;
}

const runs = <T>(values: T[]): T[] =>
	values.filter((value, i) => i === 0 || values[i - 1] !== value);

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Ready, then a divergence whose re-bootstrap cannot download: `failed`. */
async function failReplica(
	project: ReturnType<typeof fakeProject>,
	replica: ReturnType<typeof realReplica>
): Promise<void> {
	await forceFailed({ project, until: replica.until });
}

describe('the replica store', () => {
	it('starts nothing without an active project', async () => {
		const replica = realReplica();

		startReplica();
		await macrotask();

		expect(replica.connect).not.toHaveBeenCalled();
		expect(replica.statuses).toEqual([]);
		expect(getReplicaStatus()).toBe(OFF);
	});

	it("opens the active project's replica, its status reactive", async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		const phases: string[] = [];
		const dispose = $effect.root(() => {
			$effect(() => {
				phases.push(getReplicaStatus().phase);
			});
		});
		flushSync();
		setActiveProject('p');

		startReplica();
		flushSync();
		expect(getReplicaStatus().phase).toBe('opening');
		await replica.until((s) => s.phase === 'ready');
		flushSync();
		dispose();

		expect(runs(phases)).toEqual(['off', 'opening', 'ready']);
		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', rev: 0, source: 'network' });
		expect(replica.connect).toHaveBeenCalledOnce();
	});

	it('stopReplica turns it off', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');

		stopReplica();

		expect(getReplicaStatus()).toBe(OFF);
	});

	it('a commit frame handed over with its text moves the replica', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		const committed = project.commit([
			{ kind: 'update_element', id: 'e_000001', properties_patch: { name: 'moved' } }
		]);

		handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);
		await replica.until((s) => s.rev === 1);

		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', rev: 1 });
	});
});

describe('the hand-over', () => {
	const commit = (rev: number): FeedEvent => ({
		type: 'commit',
		rev,
		commit_id: 'c',
		author_id: 'u',
		message: 'm',
		validation_error_count: 0,
		changed_elements: [],
		changed_relationships: [],
		deleted_element_ids: [],
		deleted_relationship_ids: []
	});

	it('routes commit, rebind and snapshot events', () => {
		const sync = spySync();
		configureReplica({ sync });

		handReplicaFeed(commit(7), '{"type":"commit","rev":7}');
		handReplicaFeed(
			{
				type: 'rebind',
				rev: 8,
				from_metamodel_id: 'a',
				to_metamodel_id: 'b',
				validation_error_count: 0
			},
			'{}'
		);
		handReplicaFeed({ type: 'snapshot', model_rev: 9, locks: [], connected: [] }, '{}');
		handReplicaFeed({ type: 'presence', action: 'join', user_id: 'u', connected: ['u'] }, '{}');

		expect(sync.feedCommit).toHaveBeenCalledExactlyOnceWith('{"type":"commit","rev":7}', 7);
		expect(sync.feedRebind).toHaveBeenCalledExactlyOnceWith(8);
		expect(sync.feedSnapshot).toHaveBeenCalledExactlyOnceWith(9);
	});

	it('a reset event reaches the sync', () => {
		const sync = spySync();
		configureReplica({ sync });

		handReplicaFeed({ type: 'reset', model_rev: 10 }, '{"type":"reset","model_rev":10}');

		expect(sync.feedReset).toHaveBeenCalledExactlyOnceWith(10);
		expect(sync.feedSnapshot).not.toHaveBeenCalled();
	});

	it('placements reach the sync, and forgetting all drops each registered view', () => {
		const sync = spySync();
		configureReplica({ sync });

		registerViewPlacement('v1', ['a', 'b']);
		registerViewPlacement('v2', ['c']);
		forgetViewPlacement('v1');
		forgetViewPlacements();

		expect(sync.setViewPlacement.mock.calls).toEqual([
			['v1', ['a', 'b']],
			['v2', ['c']]
		]);
		expect(sync.dropViewPlacement.mock.calls).toEqual([['v1'], ['v2']]);
	});

	it('a commit without its text reaches nothing', () => {
		const sync = spySync();
		configureReplica({ sync });

		handReplicaFeed(commit(7), undefined);

		expect(sync.feedCommit).not.toHaveBeenCalled();
	});

	it('flights and adoption reach the sync', () => {
		const flight = { settle: vi.fn(), abandon: vi.fn() };
		const sync = spySync(flight);
		configureReplica({ sync });

		expect(beginReplicaCommit()).toBe(flight);
		replicaMetamodelAdopted();

		expect(sync.beginCommit).toHaveBeenCalledOnce();
		expect(sync.metamodelAdopted).toHaveBeenCalledOnce();
	});

	it('without a sync, a flight is one that does nothing', () => {
		const flight = beginReplicaCommit();

		expect(() => {
			flight.settle({ text: '{}', rev: 1, applied: true, rebound: false, idMap: {} });
			flight.abandon();
			replicaMetamodelAdopted();
			handReplicaFeed(commit(1), '{}');
		}).not.toThrow();
	});
});

describe('the engine seam', () => {
	const READY: ReplicaStatus = { ...OFF, phase: 'ready', rev: 0 };

	// A started replica's artifact follower asks for the project's artifacts.
	beforeEach(() => {
		server.use(
			http.get(`${PAGE_ORIGIN}/api/v1/projects/p/artifacts/payloads`, () =>
				HttpResponse.json({ items: [] })
			)
		);
	});
	it('stopReplica and resetReplica uninstall the seam: every read is unavailable', async () => {
		configureReplica({ sync: spySync(undefined, { current: READY }) });
		setActiveProject('p');

		startReplica();
		stopReplica();
		await expect(getElementsBatch(['e_000001'])).rejects.toBeInstanceOf(EngineUnavailableError);

		startReplica();
		resetReplica();
		await expect(getElementsBatch(['e_000001'])).rejects.toBeInstanceOf(EngineUnavailableError);
	});

	it('a read is answered by the replica', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		realReplica();
		setActiveProject('p');
		startReplica();

		// No read route is served: the answer can only be the engine's.
		const items = await getElementsBatch(['e_000001', 'missing']);

		expect(items.map((item) => item.id)).toEqual(['e_000001']);
		// Asked while the replica opened, it answered only once the gate was open.
		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', seeded: true });
	});

	it('a read waiting on the gate rejects when the replica cannot start, and so does one made after', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		realReplica({ connect: () => Promise.reject(new FrameError('same-host', 'no frame here')) });
		setActiveProject('p');
		startReplica();

		const waiting = getElementsBatch(['e_000001']);

		await expect(waiting).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(waiting).rejects.toThrow('no frame here');
		expect(getReplicaStatus().phase).toBe('unavailable');
		await expect(getElementsBatch(['e_000001'])).rejects.toBeInstanceOf(EngineUnavailableError);
	});

	it('a replica that never becomes ready is unavailable and blocks the workspace', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({
			connect: () => Promise.reject(new FrameError('same-host', 'no frame here'))
		});
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'unavailable');

		expect(isReplicaBlocked()).toBe(true);
		expect(getReplicaStatus().reason).toBe('no frame here');
		expect(getReplicaBlockReason()).toBe('no frame here');
		expect(isReplicaRetrying()).toBe(false);
	});

	it('retry from unavailable reconnects: a second connect is made and the phase reaches ready', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		let attempts = 0;
		const replica = realReplica({
			connect: () => {
				attempts += 1;
				if (attempts === 1) return Promise.reject(new FrameError('same-host', 'no frame here'));
				const link = connectInProcess();
				links.push(link);
				return Promise.resolve(link);
			}
		});
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'unavailable');
		let unblocked = false;
		const released = whenReplicaUnblocked().then(() => (unblocked = true));
		await macrotask();
		expect(unblocked).toBe(false);

		const ready = replica.until((s) => s.phase === 'ready' && s.seeded);
		retryReplica();
		expect(isReplicaRetrying()).toBe(true);
		expect(isReplicaBlocked()).toBe(true);
		await ready;
		await released;

		expect(attempts).toBe(2);
		expect(isReplicaBlocked()).toBe(false);
		expect(isReplicaRetrying()).toBe(false);
		expect(getReplicaBlockReason()).toBeNull();
		expect((await getElementsBatch(['e_000001'])).map((item) => item.id)).toEqual(['e_000001']);
	});

	it('a retry that fails again is unavailable again, with Retry enabled', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'unavailable');

		const again = replica.until((s) => s.phase === 'unavailable');
		retryReplica();
		await again;

		expect(isReplicaBlocked()).toBe(true);
		expect(isReplicaRetrying()).toBe(false);
	});

	it('a read in a project with no model is unavailable, saying so', async () => {
		const project = fakeProject();
		project.fail('descriptor', 404, 1);
		server.use(...project.handlers());
		realReplica();
		setActiveProject('p');
		startReplica();

		const read = getElementsBatch(['e_000001']);

		await expect(read).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(read).rejects.toThrow('no model');
		expect(getReplicaStatus().phase).toBe('off');
	});

	it('a failed replica refuses reads; once a retry reopens the gate a read waiting for it answers', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await failReplica(project, replica);

		await expect(getElementsBatch(['e_000001'])).rejects.toBeInstanceOf(EngineUnavailableError);

		project.fail('snapshot', 503, 0);
		const ready = replica.until((s) => s.phase === 'ready' && s.seeded);
		retryReplica();
		expect(getReplicaStatus().phase).toBe('resyncing');
		const waiting = getElementsBatch(['e_000001']);
		await ready;

		expect((await waiting).map((item) => item.id)).toEqual(['e_000001']);
	});

	it('a read waiting on the gate rejects when the replica stops, and the next one is unavailable at once', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		realReplica();
		setActiveProject('p');
		startReplica();
		const waiting = getElementsBatch(['e_000001']);

		stopReplica();

		await expect(waiting).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(getElementsBatch(['e_000001'])).rejects.toBeInstanceOf(EngineUnavailableError);
	});

	it('artifacts that cannot be loaded block the workspace and reject the reads; Retry loads them again', async () => {
		const project = fakeProject();
		let healthy = false;
		server.use(
			http.get(`${PAGE_ORIGIN}/api/v1/projects/p/artifacts/payloads`, () =>
				healthy ? HttpResponse.json({ items: [] }) : new HttpResponse(null, { status: 503 })
			),
			...project.handlers()
		);
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready' && s.seeded);
		// Asked before the load has failed for good: it waits, then rejects.
		const waiting = getElementsBatch(['e_000001']);

		await expect(waiting).rejects.toBeInstanceOf(EngineUnavailableError);
		await expect(waiting).rejects.toThrow('the artifacts could not be loaded');
		expect(getReplicaStatus().phase).toBe('ready');
		expect(isReplicaBlocked()).toBe(true);
		expect(getReplicaBlockReason()).toMatch(/^The artifacts could not be loaded/);
		await expect(getElementsBatch(['e_000001'])).rejects.toBeInstanceOf(EngineUnavailableError);

		let unblocked = false;
		const clear = whenReplicaUnblocked().then(() => (unblocked = true));
		await macrotask();
		expect(unblocked).toBe(false);

		healthy = true;
		retryReplica();
		expect(isReplicaRetrying()).toBe(true);
		const afterRetry = getElementsBatch(['e_000001']);

		expect((await afterRetry).map((item) => item.id)).toEqual(['e_000001']);
		await clear;
		expect(isReplicaBlocked()).toBe(false);
		expect(isReplicaRetrying()).toBe(false);
		expect(getReplicaBlockReason()).toBeNull();
	});

	it('a read waits for the artifacts too: none is answered before the follower has loaded', async () => {
		const project = fakeProject();
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		server.use(
			http.get(`${PAGE_ORIGIN}/api/v1/projects/p/artifacts/payloads`, async () => {
				await held;
				return HttpResponse.json({ items: [] });
			}),
			...project.handlers()
		);
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready' && s.seeded);
		let answered = false;
		const read = getElementsBatch(['e_000001']).then((items) => {
			answered = true;
			return items;
		});
		await macrotask();
		expect(answered).toBe(false);

		release();

		expect((await read).map((item) => item.id)).toEqual(['e_000001']);
	});
});

describe('the status listeners and the engine handle', () => {
	it('subscribeReplicaStatus gets (status, previous) on every change', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		const seen: [ReplicaStatus, ReplicaStatus][] = [];
		const unsubscribe = subscribeReplicaStatus((status, previous) => {
			seen.push([status, previous]);
		});
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		stopReplica();
		unsubscribe();

		// stopReplica's `off` included.
		expect(seen.map(([status]) => status)).toEqual(replica.statuses);
		expect(seen.at(-1)![0]).toBe(OFF);
		expect(seen[0]![1]).toBe(OFF);
		for (let i = 1; i < seen.length; i++) expect(seen[i]![1]).toBe(seen[i - 1]![0]);
		expect(runs(seen.map(([status]) => status.phase))).toEqual(['opening', 'ready', 'off']);
	});

	it('startReplica attaches the engine half; stopReplica detaches it', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		const attach = vi.spyOn(modelEngine, 'attachEngine');
		const detach = vi.spyOn(modelEngine, 'detachEngine');
		setActiveProject('p');

		startReplica();
		expect(attach).toHaveBeenCalledOnce();
		const handle = attach.mock.calls[0]![0];
		expect(handle.status()).toBe(getReplicaStatus());
		await replica.until((s) => s.phase === 'ready');
		expect(handle.status()).toBe(getReplicaStatus());
		expect(handle.status().phase).toBe('ready');
		expect(detach).not.toHaveBeenCalled();

		stopReplica();
		expect(detach).toHaveBeenCalled();
		expect(handle.status()).toBe(OFF);
	});
});

describe('the structure rev after a re-bootstrap', () => {
	it('a plain open (opening to ready) moves it by nothing', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		const before = getStructureRev();

		startReplica();
		await replica.until((s) => s.phase === 'ready');

		expect(getStructureRev()).toBe(before);
	});

	it('a retry that reaches ready from failed bumps it once', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await failReplica(project, replica);
		const before = getStructureRev();
		project.fail('snapshot', 503, 0);

		retryReplica();
		await replica.until((s) => s.phase === 'ready');

		expect(getStructureRev()).toBe(before + 1);
	});

	it('a re-bootstrap the replica starts on its own (a diverged digest check) bumps it too', async () => {
		const project = fakeProject();
		project.wrongDigestInNextSnapshot();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');

		startReplica();
		await replica.until((s) => s.phase === 'ready');
		const before = getStructureRev();
		await replica.until((s) => s.phase === 'resyncing');
		const resyncing = replica.statuses.findIndex((s) => s.phase === 'resyncing');

		await replica.until((s) => s.phase === 'ready', resyncing);

		expect(getStructureRev()).toBe(before + 1);
	});
});

describe('replicaGate', () => {
	it('waits for opening to end, resolving at ready', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await held.reached;
		expect(getReplicaStatus().phase).toBe('opening');

		let resolved = false;
		void replicaGate().then(() => {
			resolved = true;
		});
		await macrotask();
		expect(resolved).toBe(false);

		held.release();
		await replica.until((s) => s.phase === 'ready');
		await macrotask();

		expect(resolved).toBe(true);
	});

	it('resolves at unavailable (a rejected connect)', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'unavailable');

		let resolved = false;
		void replicaGate().then(() => {
			resolved = true;
		});
		await macrotask();

		expect(resolved).toBe(true);
	});

	it('resolves at off (no model)', async () => {
		const project = fakeProject();
		project.fail('descriptor', 404, 1);
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'off');

		let resolved = false;
		void replicaGate().then(() => {
			resolved = true;
		});
		await macrotask();

		expect(resolved).toBe(true);
	});

	it('resolves on stopReplica()', async () => {
		const project = fakeProject();
		const held = hold();
		server.use(...project.handlers({ hold: held }));
		realReplica();
		setActiveProject('p');
		startReplica();
		await held.reached;

		let resolved = false;
		void replicaGate().then(() => {
			resolved = true;
		});
		await macrotask();
		expect(resolved).toBe(false);

		stopReplica();
		await macrotask();

		expect(resolved).toBe(true);
		held.release();
	});

	it('feeds the journey (journeyReplica) while opening only', async () => {
		const spy = vi.spyOn(openJourney, 'journeyReplica');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		await macrotask();

		const openingReports = replica.statuses.filter(
			(s) => s.phase === 'opening' && s.progress !== null
		).length;
		expect(openingReports).toBeGreaterThan(0);
		expect(spy).toHaveBeenCalledTimes(openingReports);
		spy.mockRestore();
	});
});

describe('the block', () => {
	it("isReplicaBlocked is true at failed, stays true through the retry's resyncing, false at ready", async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await failReplica(project, replica);

		expect(isReplicaBlocked()).toBe(true);
		expect(isReplicaRetrying()).toBe(false);

		project.fail('snapshot', 503, 2);
		retryReplica();

		expect(getReplicaStatus().phase).toBe('resyncing');
		expect(isReplicaRetrying()).toBe(true);
		expect(isReplicaBlocked()).toBe(true);

		await replica.until((s) => s.phase === 'ready');

		expect(isReplicaRetrying()).toBe(false);
		expect(isReplicaBlocked()).toBe(false);
	});

	it('a retry that fails again is blocked again, with Retry enabled', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await failReplica(project, replica);

		project.fail('snapshot', 503, 99);
		retryReplica();
		await replica.until((s) => s.phase === 'failed' && s.attempt === 0);

		expect(isReplicaBlocked()).toBe(true);
		expect(isReplicaRetrying()).toBe(false);
	});

	it('retryReplica in ready leaves isReplicaRetrying false', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');

		retryReplica();

		expect(getReplicaStatus().phase).toBe('ready');
		expect(isReplicaRetrying()).toBe(false);
		expect(isReplicaBlocked()).toBe(false);
	});
});

describe('the block reacts through $derived', () => {
	/**
	 * Derived before `startReplica()` and read once, as `+page.svelte` does: a
	 * regression there (e.g. a tracked value going back to a plain `let`) shows
	 * up here exactly as it would in the app.
	 */
	function deriveBlocked(): { blocked(): boolean; dispose(): void } {
		let blocked: (() => boolean) | undefined;
		const dispose = $effect.root(() => {
			const b = $derived(isReplicaBlocked());
			blocked = () => b;
		});
		return { blocked: blocked!, dispose };
	}

	it('isReplicaBlocked flips when the phase reaches unavailable', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });

		const derived = deriveBlocked();
		flushSync();
		expect(derived.blocked()).toBe(false);

		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'unavailable');
		flushSync();

		expect(derived.blocked()).toBe(true);
		derived.dispose();
	});

	it('isReplicaBlocked flips when the phase reaches failed', async () => {
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();

		const derived = deriveBlocked();
		flushSync();
		expect(derived.blocked()).toBe(false);

		setActiveProject('p');
		startReplica();
		await failReplica(project, replica);
		flushSync();

		expect(derived.blocked()).toBe(true);
		derived.dispose();
	});
});

describe("the overlay's promise, and the frozen replica's", () => {
	let store: EngineStore | null = null;

	afterEach(() => {
		store?.dispose();
		store = null;
	});

	it('retryReplica() lands ready with the same staged batches once failed', async () => {
		store = await engineStore();
		const s = store;
		await ensureElements(['e_000001']);
		const opA = rename('e_000001', 'staged name');
		const opB = create('tmp_x', 'staged org');
		emit(opA);
		emit(opB);
		await settled(s);
		const ops = getStagedOps();
		const ids = getStagedBatchIds();
		expect(ids).toEqual([1, 2]);
		expect(isReplicaBlocked()).toBe(false);

		await forceFailed(s, { waitForReady: false });

		expect(isReplicaBlocked()).toBe(true);

		s.project.fail('snapshot', 503, 0);
		const ready = s.until((status) => status.phase === 'ready');
		retryReplica();

		expect(isReplicaBlocked()).toBe(true);
		await ready;
		await settled(s);

		expect(isReplicaBlocked()).toBe(false);
		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', rev: s.project.rev });
		// The overlay's "Your uncommitted edits are kept" is this: the same
		// two ops, under the same batch ids, once the replica is `ready` again.
		expect(getStagedOps()).toEqual(ops);
		expect(getStagedBatchIds()).toEqual(ids);
		expect(nameOf('e_000001')).toBe('staged name');
		expect(nameOf('tmp_x')).toBe('staged org');
	});

	it('a peer rebind freezes the replica without blocking it, and carries an edit through the adoption', async () => {
		store = await engineStore();
		const s = store;
		await ensureElements(['e_000002']);
		const freezeRev = s.project.rev + 1;

		const frozen = s.until((status) => status.phase === 'frozen');
		handReplicaFeed(
			{
				type: 'rebind',
				rev: freezeRev,
				from_metamodel_id: 'mm-1',
				to_metamodel_id: 'mm-2',
				validation_error_count: 0
			},
			undefined
		);
		await frozen;
		expect(getReplicaStatus().reason).toBe(`metamodel changed at rev ${freezeRev}`);
		expect(isReplicaBlocked()).toBe(false);

		const op = rename('e_000002', 'while frozen');
		emit(op);
		await settled(s);
		expect(getStagedOps()).toEqual([op]);

		s.project.rebind('mm-2');
		const ready = s.until((status) => status.phase === 'ready' && status.rev === s.project.rev);
		replicaMetamodelAdopted();
		await ready;
		await settled(s);

		// Staged or parked, never dropped: this fake project's `rebind` keeps
		// the metamodel document, so the op still applies and the batch stays
		// staged rather than being parked in `getStagedConflicts()`.
		expect(getStagedOps().length + getStagedConflicts().length).toBe(1);
		expect(getStagedOps()).toEqual([op]);
		expect(getStagedConflicts()).toEqual([]);
	});
});

describe('a worker that dies after the handshake', () => {
	let store: EngineStore | null = null;

	afterEach(() => {
		store?.dispose();
		store = null;
	});

	/** A rename and a create staged in the replica; the ops and batch ids the store shows. */
	async function twoEdits(s: EngineStore) {
		await ensureElements(['e_000001', 'e_000002']);
		emit(rename('e_000001', 'staged name'));
		emit(create('tmp_x', 'staged org'));
		await settled(s);
		const ops = getStagedOps();
		expect(getStagedBatchIds()).toEqual([1, 2]);
		return { ops, ids: [1, 2] };
	}

	/** A peer's commit: the feed frame to the replica, the delta to the model store. */
	function feedPeer(s: EngineStore): void {
		const committed = s.project.commit([
			{ kind: 'update_element', id: 'e_000003', properties_patch: { name: 'peer' } }
		]);
		handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);
		applyDelta(peerDelta(committed));
	}

	it('a delta that finds it gone rebuilds the replica on a new one, the staged edits carried', async () => {
		store = await engineStore();
		const s = store;
		const { ops, ids } = await twoEdits(s);
		const dead = s.link;

		dead.dispose();
		const back = s.until((status) => status.phase === 'ready');
		feedPeer(s);
		await back;
		await settled(s);

		expect(s.link).not.toBe(dead);
		expect(getStagedOps()).toEqual(ops);
		expect(getStagedBatchIds()).toEqual(ids);
		expect(await s.link.client.call('staged')).toEqual([
			{ id: 1, ops: [ops[0]] },
			{ id: 2, ops: [ops[1]] }
		]);
		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', rev: s.project.rev });
		expect(nameOf('e_000001')).toBe('staged name');
	});

	it('an edit made once it is gone reaches the replica that replaces it', async () => {
		store = await engineStore();
		const s = store;
		const { ops } = await twoEdits(s);

		s.link.dispose();
		const back = s.until((status) => status.phase === 'ready');
		emit(rename('e_000002', 'after'));
		await back;
		await settled(s);

		expect(getStagedOps()).toEqual([...ops, rename('e_000002', 'after')]);
		expect(getStagedBatchIds()).toEqual([1, 2, 3]);
		expect(await s.link.client.call('staged')).toEqual([
			{ id: 1, ops: [ops[0]] },
			{ id: 2, ops: [ops[1]] },
			{ id: 3, ops: [rename('e_000002', 'after')] }
		]);
		expect(nameOf('e_000002')).toBe('after');
	});

	it('frozen, an edit is refused until the adoption rebuilds the replica, the staged edits carried', async () => {
		store = await engineStore();
		const s = store;
		const { ops, ids } = await twoEdits(s);
		s.project.rebind('mm-2');
		const frozen = s.until((status) => status.phase === 'frozen');
		handReplicaFeed(
			{
				type: 'rebind',
				rev: s.project.rev,
				from_metamodel_id: 'mm-1',
				to_metamodel_id: 'mm-2',
				validation_error_count: 0
			},
			undefined
		);
		await frozen;

		s.link.dispose();
		// The refused edit's element is read back from the server: no replica answers.
		server.use(http.post('*/model/elements/batch', () => HttpResponse.json({ items: [] })));
		emit(rename('e_000002', 'refused'));
		await stagedSettled();
		expect(getModelError()?.kind).toBe('error');
		expect(getStagedOps()).toEqual(ops);

		const ready = s.until((status) => status.phase === 'ready');
		replicaMetamodelAdopted();
		await ready;
		await settled(s);

		expect(getStagedOps()).toEqual(ops);
		expect(getStagedBatchIds()).toEqual(ids);
		expect(await s.link.client.call('staged')).toEqual([
			{ id: 1, ops: [ops[0]] },
			{ id: 2, ops: [ops[1]] }
		]);
	});

	it('a worker that cannot be reached again leaves the replica failed, and retry brings the edits back', async () => {
		store = await engineStore();
		const s = store;
		const { ops, ids } = await twoEdits(s);

		s.refuseConnects(1);
		s.link.dispose();
		const gaveUp = s.until((status) => status.phase === 'failed' || status.phase === 'unavailable');
		feedPeer(s);
		await gaveUp;

		expect(getReplicaStatus().phase).toBe('failed');
		expect(isReplicaBlocked()).toBe(true);
		expect(getStagedOps()).toEqual(ops);

		const ready = s.until((status) => status.phase === 'ready');
		retryReplica();
		await ready;
		await settled(s);

		expect(getStagedOps()).toEqual(ops);
		expect(getStagedBatchIds()).toEqual(ids);
		expect(await s.link.client.call('staged')).toEqual([
			{ id: 1, ops: [ops[0]] },
			{ id: 2, ops: [ops[1]] }
		]);
		expect(isReplicaBlocked()).toBe(false);
	});
});

describe('the artifact follower', () => {
	const scope = (type: string) => ({
		kind: 'path',
		start: { kind: 'scope', types: [type] },
		steps: []
	});
	const nav = (id: string, rev: number, type: string) => ({
		id,
		kind: 'navigation',
		name: `nav ${id}`,
		artifact_rev: rev,
		updated_at: '2026-09-24T00:00:00Z',
		updated_by: null,
		entry_points: null,
		payload: scope(type)
	});
	const wire = ({ id, kind, name, artifact_rev, payload }: ReturnType<typeof nav>) => ({
		id,
		kind,
		name,
		artifact_rev,
		payload
	});
	const header = ({
		id,
		kind,
		name,
		artifact_rev,
		updated_at,
		updated_by,
		entry_points
	}: ReturnType<typeof nav>) => ({
		id,
		kind,
		name,
		artifact_rev,
		updated_at,
		updated_by,
		entry_points
	});

	/** Serves `artifacts` as project `p`'s payloads; each request's ids are recorded, `null` for all. */
	function servePayloads(artifacts: Map<string, ReturnType<typeof nav>>, gate?: Promise<void>) {
		const requests: (string[] | null)[] = [];
		server.use(
			http.get(`${PAGE_ORIGIN}/api/v1/projects/p/artifacts/payloads`, async ({ request }) => {
				const ids = new URL(request.url).searchParams.getAll('id');
				requests.push(ids.length === 0 ? null : ids);
				if (gate !== undefined) await gate;
				const items = [...artifacts.values()].filter(
					(artifact) => ids.length === 0 || ids.includes(artifact.id)
				);
				return HttpResponse.json({ items });
			})
		);
		return requests;
	}

	afterEach(() => {
		resetArtifactEdits();
	});

	it('the feed, a commit and a staged change reach it', async () => {
		const sync = spySync();
		configureReplica({ sync });
		const artifacts = new Map([['n1', nav('n1', 1, 'Organization')]]);
		const requests = servePayloads(artifacts);
		setActiveProject('p');

		startReplica();
		await vi.waitFor(() => expect(sync.setArtifacts).toHaveBeenCalledOnce());
		expect(sync.setArtifacts).toHaveBeenCalledWith([wire(nav('n1', 1, 'Organization'))]);
		expect(requests).toEqual([null]);

		artifacts.set('n1', nav('n1', 2, 'Project'));
		handReplicaFeed(
			{ type: 'artifact', action: 'updated', artifact: header(artifacts.get('n1')!) },
			'{}'
		);
		await vi.waitFor(() => expect(sync.putArtifacts).toHaveBeenCalledOnce());
		expect(sync.putArtifacts).toHaveBeenCalledWith([wire(nav('n1', 2, 'Project'))], []);
		expect(requests).toEqual([null, ['n1']]);

		handReplicaFeed(
			{ type: 'artifact', action: 'deleted', artifact: header(artifacts.get('n1')!) },
			'{}'
		);
		await vi.waitFor(() => expect(sync.putArtifacts).toHaveBeenCalledTimes(2));
		expect(sync.putArtifacts).toHaveBeenLastCalledWith([], ['n1']);

		// A snapshot event loads everything again.
		artifacts.set('n1', nav('n1', 3, 'Organization'));
		handReplicaFeed({ type: 'snapshot', model_rev: 0, locks: [], connected: [] }, '{}');
		expect(sync.feedSnapshot).toHaveBeenCalledWith(0);
		await vi.waitFor(() => expect(sync.setArtifacts).toHaveBeenCalledTimes(2));
		expect(sync.setArtifacts).toHaveBeenLastCalledWith([wire(nav('n1', 3, 'Organization'))]);

		const tempId = stageArtifactCreate('navigation', 'b', scope('Project'), null);
		await vi.waitFor(() => expect(sync.setStagedArtifacts).toHaveBeenCalledOnce());
		expect(sync.setStagedArtifacts).toHaveBeenCalledWith([
			{ op: 'create', id: tempId, kind: 'navigation', name: 'b', payload: scope('Project') }
		]);

		// The commit clears the buffer and is announced in one run: the created
		// artifact goes under its real id at once, and one put carries both.
		artifacts.set('n2', nav('n2', 1, 'Project'));
		clearStagedArtifacts();
		notifyArtifactCommit({
			idMap: { [tempId]: 'n2' },
			changed: [header(artifacts.get('n2')!)],
			deletedIds: []
		});
		const create = {
			op: 'create',
			id: tempId,
			kind: 'navigation',
			name: 'b',
			payload: scope('Project')
		};
		expect(sync.setStagedArtifacts).toHaveBeenCalledTimes(2);
		expect(sync.setStagedArtifacts).toHaveBeenLastCalledWith([create, { ...create, id: 'n2' }]);
		await vi.waitFor(() => expect(sync.putArtifacts).toHaveBeenCalledTimes(3));
		expect(sync.putArtifacts).toHaveBeenLastCalledWith([wire(nav('n2', 1, 'Project'))], [], []);
		await macrotask();
		expect(sync.setStagedArtifacts).toHaveBeenCalledTimes(2);
	});

	it("a restart of the same project's replica mirrors the buffer kept since", async () => {
		const sync = spySync();
		configureReplica({ sync });
		servePayloads(new Map());
		setActiveProject('p');
		startReplica();
		const tempId = stageArtifactCreate('navigation', 'b', scope('Project'), null);
		const entries = [
			{ op: 'create', id: tempId, kind: 'navigation', name: 'b', payload: scope('Project') }
		];
		await vi.waitFor(() => expect(sync.setStagedArtifacts).toHaveBeenCalledOnce());

		stopReplica();
		startReplica();

		await vi.waitFor(() => expect(sync.setStagedArtifacts).toHaveBeenCalledTimes(2));
		expect(sync.setStagedArtifacts).toHaveBeenLastCalledWith(entries);
		expect(getStagedArtifactDepth()).toBe(1);
	});

	it("another project's replica gets none of the buffer, and the buffer is emptied", async () => {
		const first = fakeProject({ projectId: 'a' });
		const second = fakeProject({ projectId: 'b' });
		server.use(...first.handlers(), ...second.handlers());
		realReplica();
		setActiveProject('a');
		startReplica();
		await vi.waitFor(() => expect(getReplicaStatus().phase).toBe('ready'));
		const tempId = stageArtifactCreate('navigation', 'x', scope('Organization'), null);
		const inA = links[0]!.client;
		await vi.waitFor(async () =>
			expect(
				(await inA.call<{ total: number }>('evaluateNavigation', { artifact_id: tempId })).total
			).toBeGreaterThan(0)
		);

		stopReplica();
		setActiveProject('b');
		startReplica();
		await vi.waitFor(() => expect(getReplicaStatus().phase).toBe('ready'));
		await macrotask();

		expect(getStagedArtifactDepth()).toBe(0);
		expect(links).toHaveLength(2);
		await expect(
			links[1]!.client.call('evaluateNavigation', { artifact_id: tempId })
		).rejects.toThrow(`unknown navigation artifact ${tempId}`);
	});

	it('stopReplica drops a payload answer that comes after it', async () => {
		const sync = spySync();
		configureReplica({ sync });
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const requests = servePayloads(new Map([['n1', nav('n1', 1, 'Organization')]]), gate);
		setActiveProject('p');
		startReplica();
		await vi.waitFor(() => expect(requests).toEqual([null]));

		stopReplica();
		release();
		await macrotask();
		await macrotask();

		expect(sync.setArtifacts).not.toHaveBeenCalled();
		stageArtifactCreate('navigation', 'b', scope('Project'), null);
		await macrotask();
		expect(sync.setStagedArtifacts).not.toHaveBeenCalled();
	});

	describe('the navigation surface waits for the artifacts', () => {
		const refUnion = (id: string) => ({
			kind: 'set_op',
			op: 'union',
			operands: [{ ref: id, step_index: null }]
		});
		const inlineUnion = (type: string) => ({
			kind: 'set_op',
			op: 'union',
			operands: [{ definition: scope(type), step_index: null }]
		});

		/**
		 * The project's payloads, whole loads answered through `loads` in turn
		 * (a status, or a promise to wait for first; past the list, at once) and
		 * named fetches held while `named` is set. The navigation route answers
		 * `answer()`, each call counted in `served`.
		 */
		function serve(
			project: ReturnType<typeof fakeProject>,
			loads: (number | Promise<void>)[],
			answer: () => Promise<object>
		) {
			const state = { served: 0, named: null as Promise<void> | null };
			server.use(
				http.get(`${PAGE_ORIGIN}/api/v1/projects/p/artifacts/payloads`, async ({ request }) => {
					const ids = new URL(request.url).searchParams.getAll('id');
					if (ids.length === 0) {
						const next = loads.shift();
						if (typeof next === 'number') return new HttpResponse(null, { status: next });
						if (next !== undefined) await next;
					} else if (state.named !== null) {
						await state.named;
					}
					const items = [...project.artifacts.values()].filter(
						(artifact) => ids.length === 0 || ids.includes(artifact.id)
					);
					return HttpResponse.json({ items });
				}),
				...project.handlers(),
				http.post('*/navigations/evaluate', async () => {
					state.served += 1;
					return HttpResponse.json(await answer());
				})
			);
			return state;
		}

		it('a navigation evaluated before the first load waits for the artifacts and answers from the engine', async () => {
			const project = fakeProject();
			project.artifacts.set('n1', nav('n1', 1, 'Organization'));
			let release!: () => void;
			const first = new Promise<void>((resolve) => (release = resolve));
			const served = serve(project, [first], () => Promise.reject(new Error('not asked')));
			const replica = realReplica();
			setActiveProject('p');
			startReplica();
			await replica.until((s) => s.phase === 'ready');
			await macrotask();
			const organizations = (
				await links[0]!.client.call<{ total: number }>('evaluateNavigation', {
					definition: inlineUnion('Organization')
				})
			).total;

			let answered = false;
			let pending: Promise<{ total: number }>;
			try {
				pending = evaluateNavigation({ definition: refUnion('n1') as never }).then((page) => {
					answered = true;
					return page;
				});
				await macrotask();
				// The artifacts are not held yet: the engine does not know the reference.
				expect(answered).toBe(false);
			} finally {
				release();
			}

			expect((await pending).total).toBe(organizations);
			expect(served.served).toBe(0);
		});

		it('the exports staged note follows what is staged, until the replica stops', async () => {
			const project = fakeProject();
			serve(project, [], () => Promise.reject(new Error('not asked')));
			const replica = realReplica();
			let note: (() => boolean) | undefined;
			const dispose = $effect.root(() => {
				const derived = $derived(exportsIncludeStaged());
				note = () => derived;
			});
			setActiveProject('p');
			startReplica();
			await replica.until((s) => s.phase === 'ready');
			flushSync();
			expect(note!()).toBe(false);

			stageArtifactCreate('navigation', 'Staged', scope('Project'), null);
			flushSync();
			expect(note!()).toBe(true);
			clearStagedArtifacts();
			flushSync();
			expect(note!()).toBe(false);
			emit(rename('e_000001', 'staged name'));
			await stagedSettled();
			flushSync();
			expect(note!()).toBe(true);
			revertAllStaged();
			await stagedSettled();
			flushSync();
			expect(note!()).toBe(false);
			dispose();
		});

		it("the metamodel's staged note follows what is staged", async () => {
			const project = fakeProject();
			serve(project, [], () => Promise.reject(new Error('not asked')));
			const replica = realReplica();
			let note: (() => boolean) | undefined;
			const dispose = $effect.root(() => {
				const derived = $derived(metamodelIncludesStaged());
				note = () => derived;
			});
			setActiveProject('p');
			startReplica();
			await replica.until((s) => s.seeded);
			flushSync();
			expect(note!()).toBe(false);

			stageArtifactCreate('navigation', 'Staged', scope('Project'), null);
			flushSync();
			expect(note!()).toBe(true);
			clearStagedArtifacts();
			flushSync();
			expect(note!()).toBe(false);
			emit(rename('e_000001', 'staged name'));
			await stagedSettled();
			flushSync();
			expect(note!()).toBe(true);
			revertAllStaged();
			await stagedSettled();
			flushSync();
			expect(note!()).toBe(false);
			dispose();
		});

		it('a failed first load is asked once more, then the engine answers', async () => {
			const project = fakeProject();
			project.artifacts.set('n1', nav('n1', 1, 'Organization'));
			const served = serve(project, [503], () => Promise.reject(new Error('not asked')));
			const replica = realReplica();
			setActiveProject('p');
			startReplica();
			await replica.until((s) => s.phase === 'ready');

			expect((await evaluateNavigation({ definition: refUnion('n1') as never })).total).toBe(
				(
					await links[0]!.client.call<{ total: number }>('evaluateNavigation', {
						definition: inlineUnion('Organization')
					})
				).total
			);
			expect(served.served).toBe(0);
		});

		it("a restarted replica's new follower waits for its own load", async () => {
			const project = fakeProject();
			let release!: () => void;
			const second = new Promise<void>((resolve) => (release = resolve));
			serve(project, [Promise.resolve(), second], () => Promise.reject(new Error('not asked')));
			const replica = realReplica();
			setActiveProject('p');
			startReplica();
			await replica.until((s) => s.phase === 'ready');
			await getElementsBatch(['e_000001']);

			stopReplica();
			startReplica();
			await replica.until((s) => s.phase === 'ready');
			let answered = false;
			const read = getElementsBatch(['e_000001']).then((items) => {
				answered = true;
				return items;
			});
			try {
				await macrotask();
				expect(answered).toBe(false);
			} finally {
				release();
			}
			expect((await read).map((item) => item.id)).toEqual(['e_000001']);
		});
	});

	it('a staged payload held in $state reaches the engine as a plain copy', async () => {
		const project = fakeProject();
		project.artifacts.set('n1', nav('n1', 1, 'Organization'));
		server.use(...project.handlers());
		realReplica();
		setActiveProject('p');
		startReplica();
		await vi.waitFor(() => expect(getReplicaStatus().phase).toBe('ready'));
		const client = links[0]!.client;
		const totalOf = async (params: object) =>
			(await client.call<{ total: number }>('evaluateNavigation', params)).total;
		const organizations = await totalOf({ definition: scope('Organization') });
		const projects = await totalOf({ definition: scope('Project') });
		expect(organizations).not.toBe(projects);
		await vi.waitFor(async () => expect(await totalOf({ artifact_id: 'n1' })).toBe(organizations));

		const draft = $state(scope('Project'));
		const tempId = stageArtifactCreate('navigation', 'b', draft, null);
		stageArtifactUpdate('n1', { payload: draft });

		await vi.waitFor(async () => expect(await totalOf({ artifact_id: tempId })).toBe(projects));
		expect(await totalOf({ artifact_id: 'n1' })).toBe(projects);
	});
});

describe('the issues', () => {
	const API = `${PAGE_ORIGIN}/api/v1/projects/p`;
	const TOO_LONG = 'x'.repeat(201);
	const tooLong = {
		severity: 'error',
		message: 'name: length 201 exceeds max_length 200',
		target_ids: ['e_000001'],
		check: 'facets',
		origin: 'uncommitted'
	};
	let store: EngineStore | null = null;

	afterEach(() => {
		store?.dispose();
		store = null;
		cancelIssuesRefetch();
	});

	/**
	 * The engine store. Every `getModelIssues`
	 * answer is recorded with the replica's `seeded` when it came.
	 */
	async function issuesStore(project = fakeProject()) {
		const real = validationApi.getModelIssues;
		const answers: { seeded: boolean; issues: unknown[] }[] = [];
		const spy = vi.spyOn(validationApi, 'getModelIssues').mockImplementation(async () => {
			const list = await real();
			answers.push({ seeded: getReplicaStatus().seeded, issues: list.issues });
			return list;
		});
		store = await engineStore({ project });
		return { s: store, spy, real, answers };
	}

	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	it('the gate opening at the end of the first sweep schedules one refetch, from the engine', async () => {
		const { s, spy, answers } = await issuesStore();
		if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);

		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		await sleep(350);
		expect(spy).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(answers).toHaveLength(1));
		expect(answers[0]).toEqual({ seeded: true, issues: [] });
	});

	it('a changed with a new issues_version schedules ONE refetch after 300 ms; one with the same version none', async () => {
		const { s, spy, real } = await issuesStore();
		if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		await sleep(350);
		spy.mockClear();
		await ensureElements(['e_000001', 'e_000002']);

		const moved: number[] = [];
		const off = s.sync.on('changed', () => void moved.push(Date.now()));
		spy.mockImplementation(() => {
			moved.push(-Date.now());
			return real();
		});
		emit(rename('e_000001', TOO_LONG));
		await settled(s);
		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		off();
		const heard = moved.filter((at) => at > 0);
		const asked = -moved.find((at) => at < 0)!;
		expect(asked - heard.at(-1)!).toBeGreaterThanOrEqual(299);
		await vi.waitFor(() => expect(getLiveIssues()).toEqual([tooLong]));
		await sleep(350);
		expect(spy).toHaveBeenCalledOnce();

		spy.mockClear();
		emit(rename('e_000002', 'still fine'));
		await settled(s);
		await sleep(350);
		expect(spy).not.toHaveBeenCalled();
		expect(getLiveIssues()).toEqual([tooLong]);
	});

	it('a worker that dies closes the gate: a refetch waits for the new replica to be swept, and no unswept list is adopted', async () => {
		const { s, answers } = await issuesStore();
		if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
		await ensureElements(['e_000001']);
		emit(rename('e_000001', TOO_LONG));
		await settled(s);
		await vi.waitFor(() => expect(getLiveIssues()).toEqual([tooLong]));
		const from = answers.length;

		s.link.dispose();
		const reseeded = s.until((status) => status.phase === 'ready' && status.seeded);
		// The engine is found gone under this call: the list is kept as it was.
		await refetchIssues();
		expect(getReplicaStatus()).toMatchObject({ phase: 'resyncing', seeded: false });
		expect(getLiveIssues()).toEqual([tooLong]);
		// While the new replica opens, its gate is closed: a refetch waits.
		let adopted = false;
		const waiting = refetchIssues().then(() => (adopted = true));
		await macrotask();
		expect(adopted).toBe(false);
		expect(answers).toHaveLength(from);

		await reseeded;
		await waiting;
		expect(getLiveIssues()).toEqual([tooLong]);
		expect(answers.slice(from).every((answer) => answer.seeded)).toBe(true);
		expect(answers.at(-1)).toEqual({ seeded: true, issues: [tooLong] });
	});

	describe('and the artifact follower', () => {
		const A = yamlOf(DE_ONLY);
		const rules = ruleSet('r1', 'Rules', A, parsed(DE_ONLY));
		const headerOf = ({
			id,
			kind,
			name,
			artifact_rev,
			updated_at,
			updated_by,
			entry_points
		}: ArtifactPayload) => ({
			id,
			kind,
			name,
			artifact_rev,
			updated_at,
			updated_by,
			entry_points
		});
		const byKey = (issues: unknown[]) => issues.map((issue) => JSON.stringify(issue)).sort();

		/** `project` whose payload fetches wait for `held.whole` (a whole load) or `held.named`. */
		function holdPayloads(held: { whole?: Promise<void>; named?: Promise<void> }) {
			const project = fakeProject();
			const handlers = project.handlers.bind(project);
			project.handlers = (options) => [
				http.get(`${API}/artifacts/payloads`, async ({ request }) => {
					const ids = new URL(request.url).searchParams.getAll('id');
					await (ids.length === 0 ? held.whole : held.named);
					const items = [...project.artifacts.values()].filter(
						(artifact) => ids.length === 0 || ids.includes(artifact.id)
					);
					return HttpResponse.json({ items });
				}),
				...handlers(options)
			];
			return project;
		}

		it('a rules artifact whose load is slow: the gate stays closed until the follower has loaded, then the engine answers with its rule issues', async () => {
			const load = hold();
			const project = holdPayloads({ whole: load.arrive() });
			project.artifacts.set('r1', rules);
			const { s, answers } = await issuesStore(project);
			if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
			await load.reached;

			// Swept, but the engine does not yet hold the rule set its list must carry.
			let adopted = false;
			const waiting = refetchIssues().then(() => (adopted = true));
			await macrotask();
			expect(adopted).toBe(false);
			expect(answers).toEqual([]);

			load.release();
			await waiting;
			const listed = ruleIssues('de-only', NOT_DE, 'on_server');
			expect(getLiveIssues()).toEqual(listed);
			// No list was answered without the rules it must carry.
			expect(answers.every((answer) => answer.seeded)).toBe(true);
			expect(answers[0]).toEqual({ seeded: true, issues: listed });
			expect(s.project.rulesParsed).toEqual([]);
		});

		it('no rules artifact, a slow load: a refetch waits for it, then the engine answers', async () => {
			const load = hold();
			const { s, answers } = await issuesStore(holdPayloads({ whole: load.arrive() }));
			if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
			await load.reached;
			let adopted = false;
			const waiting = refetchIssues().then(() => (adopted = true));
			await macrotask();
			expect(adopted).toBe(false);
			expect(answers).toEqual([]);

			load.release();
			await waiting;
			expect(answers[0]).toEqual({ seeded: true, issues: [] });
		});

		it("a rules artifact a peer commits while the engine's list is shown: the engine's list takes its rules", async () => {
			const held: { named?: Promise<void> } = {};
			const { s, answers } = await issuesStore(holdPayloads(held));
			if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
			await vi.waitFor(() => expect(answers).toHaveLength(1));
			expect(answers[0]).toMatchObject({ seeded: true });
			await ensureElements(['e_000001']);

			const fetched = hold();
			held.named = fetched.arrive();
			s.project.artifacts.set('r1', rules);
			handReplicaFeed({ type: 'artifact', action: 'created', artifact: headerOf(rules) }, '{}');
			await fetched.reached;
			// A refetch that beats the payload fetch reads the engine, which does not know of the rules yet.
			emit(rename('e_000001', TOO_LONG));
			await settled(s);
			await vi.waitFor(() => expect(getLiveIssues()).toEqual([tooLong]));
			expect(answers.at(-1)).toMatchObject({ seeded: true });

			fetched.release();
			const listed = [tooLong, ...ruleIssues('de-only', NOT_DE, 'on_server')];
			await vi.waitFor(() => expect(byKey(getLiveIssues())).toEqual(byKey(listed)));
		});

		describe('and the user commits a staged rules create', () => {
			const listed = ruleIssues('de-only', NOT_DE, 'on_server');

			afterEach(() => {
				resetCheckout();
				resetArtifactEdits();
			});

			/**
			 * A swept store with a rule set staged as a create, its issues listed
			 * `uncommitted`; `named` answers the commit's payload refresh, `whole`
			 * a load. `commit()` goes through `commitStaged`, whose answer lands the
			 * rule set as `r9` and carries the server's copy of its issues.
			 */
			async function stagedCreate() {
				/** Answers the next payload fetch of its sort in place of the project, when set. */
				const routes: {
					named?: () => Promise<Response | undefined>;
					whole?: () => Promise<Response | undefined>;
				} = {};
				const project = fakeProject();
				project.rulesParses.set(A, parsed(DE_ONLY));
				const handlers = project.handlers.bind(project);
				project.handlers = (options) => [
					http.get(`${API}/artifacts/payloads`, async ({ request }) => {
						const ids = new URL(request.url).searchParams.getAll('id');
						const answered = await (ids.length === 0 ? routes.whole : routes.named)?.();
						if (answered !== undefined) return answered;
						const items = [...project.artifacts.values()].filter(
							(artifact) => ids.length === 0 || ids.includes(artifact.id)
						);
						return HttpResponse.json({ items });
					}),
					...handlers(options)
				];
				const { s, answers } = await issuesStore(project);
				if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
				await vi.waitFor(() => expect(answers).toHaveLength(1));
				setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });

				const tempId = stageArtifactCreate('validation_rules', 'R', rulesPayload(A), null);
				await vi.waitFor(() =>
					expect(getLiveIssues()).toEqual(ruleIssues('de-only', NOT_DE, 'uncommitted'))
				);
				// Past the debounce: no refetch the staging scheduled is still to come.
				await sleep(350);
				const committed = ruleSet('r9', 'R', A, parsed(DE_ONLY));
				server.use(
					http.post(`${API}/commits`, () => {
						project.artifacts.set('r9', committed);
						const landed = project.commit([]);
						const body = {
							...(JSON.parse(landed.responseText) as object),
							id_map: { [tempId]: 'r9' },
							// Each owner of the rule's issues had none on the server before.
							issues_removed_owner_ids: [],
							issues_added: listed,
							issue_counts: { error: listed.length },
							commit_id: `c-${String(landed.delta['rev'])}`,
							message: 'm',
							changed_artifacts: [headerOf(committed)],
							deleted_artifact_ids: []
						};
						return HttpResponse.json(body);
					})
				);
				return { answers, routes, commit: () => commitStaged('m', false) };
			}

			it('each rule issue is listed once, on_server, from the splice on, while the refresh is out and after it lands', async () => {
				const { answers, routes, commit } = await stagedCreate();
				const refresh = hold();
				routes.named = () => refresh.arrive().then(() => undefined);
				const from = answers.length;

				await commit();
				expect(getLiveIssues()).toEqual(listed);

				// A refetch answered while the refresh is out, past the debounce.
				await refresh.reached;
				await sleep(350);
				await refetchIssues();
				expect(answers.length).toBeGreaterThan(from);
				expect(getLiveIssues()).toEqual(listed);

				refresh.release();
				await sleep(350);
				await refetchIssues();
				expect(getLiveIssues()).toEqual(listed);
				const after = answers.slice(from);
				expect(after.every((answer) => byKey(answer.issues).join() === byKey(listed).join())).toBe(
					true
				);
			});

			it('a failed refresh keeps them on_server while its reload is out and after it lands', async () => {
				const { answers, routes, commit } = await stagedCreate();
				const reload = hold();
				routes.named = () =>
					Promise.resolve(HttpResponse.json({ detail: 'down' }, { status: 503 }));
				routes.whole = () => reload.arrive().then(() => undefined);
				const from = answers.length;

				await commit();
				expect(getLiveIssues()).toEqual(listed);

				await reload.reached;
				await sleep(350);
				await refetchIssues();
				expect(answers.length).toBeGreaterThan(from);
				expect(getLiveIssues()).toEqual(listed);

				reload.release();
				await sleep(350);
				await refetchIssues();
				expect(getLiveIssues()).toEqual(listed);
				const after = answers.slice(from);
				expect(after.every((answer) => byKey(answer.issues).join() === byKey(listed).join())).toBe(
					true
				);
			});
		});
	});
});
