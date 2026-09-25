import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { IDBFactory } from 'fake-indexeddb';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import { engineSide } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import { evaluateNavigation } from '$lib/api/artifacts';
import { getElementsBatch } from '$lib/api/model-read';
import * as validationApi from '$lib/api/validation';
import { createSnapshotCache } from '$lib/engine/cache';
import { SURFACES } from '$lib/engine/surfaces';
import type { EngineLink } from '$lib/engine/client';
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
	dismissReplicaNotice,
	forgetViewPlacement,
	forgetViewPlacements,
	getReplicaNotice,
	getReplicaStatus,
	getStagingSide,
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
	subscribeReplicaStatus
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
	localStorage.removeItem('dr.surfaces');
	localStorage.removeItem('dr.shadow');
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
	const onEngine = (surfaces: Record<string, string>) =>
		localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));

	it('startReplica installs a seam whose sides follow dr.surfaces and the phase', async () => {
		onEngine({ staging: 'legacy', search: 'server' });
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		expect(engineSide('elements')).toBe('server');

		startReplica();
		expect(getReplicaStatus().phase).toBe('opening');
		expect(engineSide('elements')).toBe('engine');
		expect(engineSide('search')).toBe('server');
		await replica.until((s) => s.phase === 'ready');

		expect(engineSide('elements')).toBe('engine');
		expect(engineSide('search')).toBe('server');
	});

	it("a phase of off or server is the server's", () => {
		onEngine({ summary: 'engine' });
		const status = { current: OFF };
		configureReplica({ sync: spySync(undefined, status) });
		setActiveProject('p');
		startReplica();

		expect(engineSide('summary')).toBe('server');
		status.current = READY;
		expect(engineSide('summary')).toBe('engine');
		status.current = { ...OFF, phase: 'server', reason: 'engine unreachable' };
		expect(engineSide('summary')).toBe('server');
	});

	it('reads the switches once; resetReplica makes the next start read them again', () => {
		onEngine({ staging: 'legacy', search: 'server' });
		configureReplica({ sync: spySync(undefined, { current: READY }) });
		setActiveProject('p');
		startReplica();
		expect(engineSide('search')).toBe('server');

		localStorage.removeItem('dr.surfaces');
		stopReplica();
		startReplica();
		expect(engineSide('search')).toBe('server');

		resetReplica();
		configureReplica({ sync: spySync(undefined, { current: READY }) });
		startReplica();
		expect(engineSide('search')).toBe('engine');
	});

	it('stopReplica and resetReplica uninstall it', () => {
		onEngine({ elements: 'engine' });
		configureReplica({ sync: spySync(undefined, { current: READY }) });
		setActiveProject('p');

		startReplica();
		expect(engineSide('elements')).toBe('engine');
		stopReplica();
		expect(engineSide('elements')).toBe('server');

		startReplica();
		expect(engineSide('elements')).toBe('engine');
		resetReplica();
		expect(engineSide('elements')).toBe('server');
	});

	it('a read of a surface on the engine is answered by the replica', async () => {
		onEngine({ elements: 'engine' });
		const project = fakeProject();
		server.use(...project.handlers());
		realReplica();
		setActiveProject('p');
		startReplica();

		// No read route is served: the answer can only be the engine's.
		const items = await getElementsBatch(['e_000001', 'missing']);

		expect(items.map((item) => item.id)).toEqual(['e_000001']);
		expect(getReplicaStatus().phase).toBe('ready');
	});

	it('with dr.shadow, a server answer that differs is reported once', async () => {
		onEngine({ elements: 'engine' });
		localStorage.setItem('dr.shadow', '1');
		const project = fakeProject();
		let served = 0;
		server.use(
			...project.handlers(),
			http.post('*/model/elements/batch', () => {
				served += 1;
				return HttpResponse.json({ items: [] });
			})
		);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		await macrotask();

		const items = await getElementsBatch(['e_000001']);
		await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
		await macrotask();

		expect(items.map((item) => item.id)).toEqual(['e_000001']);
		expect(served).toBe(2);
		expect(errors).toHaveBeenCalledOnce();
		expect(String(errors.mock.calls[0][0])).toMatch(
			/^\[shadow\] elements getElementsBatch \{"ids":\["e_000001"\]\}: engine /
		);
	});

	it('without dr.shadow, the server is never asked', async () => {
		onEngine({ elements: 'engine' });
		const project = fakeProject();
		let served = 0;
		server.use(
			...project.handlers(),
			http.post('*/model/elements/batch', () => {
				served += 1;
				return HttpResponse.json({ items: [] });
			})
		);
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		await macrotask();

		await getElementsBatch(['e_000001']);
		await macrotask();
		await macrotask();

		expect(served).toBe(0);
	});
});

describe('getStagingSide', () => {
	const onStaging = (staging: string) =>
		localStorage.setItem('dr.surfaces', JSON.stringify({ staging }));

	// Driven through a REAL sync (`realReplica()`/`fakeProject()`), not a spy:
	// `getStagingSide()` reads the reactive `_status`, which only a sync wired
	// through `build()`'s `onStatus` (spySync bypasses it) ever updates.

	it('is legacy without a sync', () => {
		expect(getStagingSide()).toBe('legacy');
	});

	it("is legacy with dr.surfaces {staging: 'legacy'}, even at ready", async () => {
		onStaging('legacy');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');

		expect(getStagingSide()).toBe('legacy');
	});

	it("is engine with {staging: 'engine'} at ready", async () => {
		onStaging('engine');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');

		expect(getStagingSide()).toBe('engine');
	});

	it('is legacy at server, staging on the engine', async () => {
		onStaging('engine');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'server');

		expect(getStagingSide()).toBe('legacy');
	});

	it('is legacy at off, staging on the engine', async () => {
		onStaging('engine');
		const project = fakeProject();
		project.fail('descriptor', 404, 1);
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'off');

		expect(getStagingSide()).toBe('legacy');
	});

	it('is engine at failed, staging on the engine', async () => {
		onStaging('engine');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await failReplica(project, replica);

		expect(getStagingSide()).toBe('engine');
	});

	it('is engine at frozen, staging on the engine', async () => {
		onStaging('engine');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');

		// The freeze is synchronous (no queued delta), so the watcher must be
		// registered BEFORE the event fires, or the one push it waits for is
		// already past by the time `until` starts watching.
		const frozen = replica.until((s) => s.phase === 'frozen');
		handReplicaFeed(
			{
				type: 'rebind',
				rev: 1,
				from_metamodel_id: 'a',
				to_metamodel_id: 'b',
				validation_error_count: 0
			},
			'{}'
		);
		await frozen;

		expect(getStagingSide()).toBe('engine');
	});

	it('reacts through $derived when the phase moves to server', async () => {
		onStaging('engine');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });

		let side: (() => string) | undefined;
		const dispose = $effect.root(() => {
			const s = $derived(getStagingSide());
			side = () => s;
		});
		flushSync();
		expect(side!()).toBe('legacy'); // no sync yet

		setActiveProject('p');
		startReplica();
		flushSync();
		expect(side!()).toBe('engine'); // opening: staging on the engine, phase not off/server

		await replica.until((s) => s.phase === 'server');
		flushSync();

		expect(side!()).toBe('legacy'); // the derived re-ran on its own, without a fresh read
		dispose();
	});
});

describe('the status listeners and the engine handle', () => {
	const onStaging = (staging: string) =>
		localStorage.setItem('dr.surfaces', JSON.stringify({ staging }));

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

	it('startReplica attaches the engine half with staging on the engine; stopReplica detaches it', async () => {
		onStaging('engine');
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

	it('the shadow compares nothing while the engine half has an edit staged', async () => {
		onStaging('engine');
		localStorage.setItem('dr.shadow', '1');
		const project = fakeProject();
		let served = 0;
		server.use(
			...project.handlers(),
			http.post('*/model/elements/batch', () => {
				served += 1;
				return HttpResponse.json({ items: [] });
			})
		);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		await macrotask();
		const shadowLines = () =>
			errors.mock.calls.filter(([line]) =>
				String(line).startsWith('[shadow] elements getElementsBatch {"ids":["e_000001"]}')
			);

		emit({ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'staged' } });
		await stagedSettled();
		await getElementsBatch(['e_000001']);
		await macrotask();
		await macrotask();
		expect(served).toBe(0);
		expect(shadowLines()).toEqual([]);

		revertAllStaged();
		await stagedSettled();
		await getElementsBatch(['e_000001']);
		await vi.waitFor(() => expect(shadowLines()).toHaveLength(1));
		expect(served).toBe(2);
	});

	it('the shadow compares nothing while an artifact entry is staged', async () => {
		onStaging('engine');
		localStorage.setItem('dr.shadow', '1');
		const project = fakeProject();
		let served = 0;
		server.use(
			...project.handlers(),
			http.post('*/model/elements/batch', () => {
				served += 1;
				return HttpResponse.json({ items: [] });
			})
		);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		await macrotask();
		const shadowLines = () =>
			errors.mock.calls.filter(([line]) =>
				String(line).startsWith('[shadow] elements getElementsBatch {"ids":["e_000001"]}')
			);

		try {
			stageArtifactCreate('navigation', 'Staged', { kind: 'path' }, null);
			expect(getStagedArtifactDepth()).toBe(1);
			await getElementsBatch(['e_000001']);
			await macrotask();
			await macrotask();
			expect(served).toBe(0);
			expect(shadowLines()).toEqual([]);

			clearStagedArtifacts();
			await getElementsBatch(['e_000001']);
			await vi.waitFor(() => expect(shadowLines()).toHaveLength(1));
			expect(served).toBe(2);
		} finally {
			resetArtifactEdits();
		}
	});

	it('with staging on legacy, the engine half is never attached', async () => {
		onStaging('legacy');
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		const attach = vi.spyOn(modelEngine, 'attachEngine');
		setActiveProject('p');

		startReplica();
		await replica.until((s) => s.phase === 'ready');

		expect(attach).not.toHaveBeenCalled();
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
	const onEngine = (surfaces: Record<string, string>) =>
		localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));
	// A default may put a surface on the engine (see `lib/engine/surfaces.ts`);
	// force every one to `server` for a test about there being none on it — and
	// pin staging to 'legacy' too, since staging on the engine (the default)
	// forces every surface back to it whatever this object says of them.
	const onServer = () =>
		onEngine({
			staging: 'legacy',
			...Object.fromEntries(SURFACES.map((s) => [s, 'server']))
		});

	it('resolves at once with every surface on server, even while genuinely opening', async () => {
		onServer();
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

		expect(resolved).toBe(true);
		held.release();
		await replica.until((s) => s.phase === 'ready');
	});

	it('with a surface on the engine, waits for opening to end, resolving at ready', async () => {
		onEngine({ elements: 'engine' });
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

	it('resolves at server (a rejected connect)', async () => {
		onEngine({ elements: 'engine' });
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'server');

		let resolved = false;
		void replicaGate().then(() => {
			resolved = true;
		});
		await macrotask();

		expect(resolved).toBe(true);
	});

	it('resolves at off (no model)', async () => {
		onEngine({ elements: 'engine' });
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
		onEngine({ elements: 'engine' });
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
		onEngine({ elements: 'engine' });
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

describe('the notice and the block', () => {
	const onEngine = (surfaces: Record<string, string>) =>
		localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));
	// A default may put a surface on the engine (see `lib/engine/surfaces.ts`);
	// force every one to `server` for a test about there being none on it — and
	// pin staging to 'legacy' too, since staging on the engine (the default)
	// forces every surface back to it whatever this object says of them.
	const onServer = () =>
		onEngine({
			staging: 'legacy',
			...Object.fromEntries(SURFACES.map((s) => [s, 'server']))
		});

	it('the notice shows at server with a surface on the engine, not after dismiss, again after startReplica', async () => {
		onEngine({ elements: 'engine' });
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'server');

		expect(getReplicaNotice()).toBe(true);

		dismissReplicaNotice();
		expect(getReplicaNotice()).toBe(false);

		startReplica();
		expect(getReplicaNotice()).toBe(true);
	});

	it('the notice never shows with no surface on the engine', async () => {
		onServer();
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'server');

		expect(getReplicaNotice()).toBe(false);
	});

	it("isReplicaBlocked is true at failed, stays true through the retry's resyncing, false at ready", async () => {
		onEngine({ elements: 'engine' });
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
		onEngine({ elements: 'engine' });
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

	it('with every surface on server, a failed replica blocks nothing', async () => {
		onServer();
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await failReplica(project, replica);

		expect(isReplicaBlocked()).toBe(false);
	});

	it('an opt-out stored without the issues switch, staging on legacy, waits for and blocks nothing', async () => {
		onEngine({
			staging: 'legacy',
			...Object.fromEntries(SURFACES.filter((s) => s !== 'issues').map((s) => [s, 'server']))
		});
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
		expect(resolved).toBe(true);
		held.release();

		await failReplica(project, replica);
		expect(isReplicaBlocked()).toBe(false);
		expect(engineSide('issues')).toBe('server');
	});

	it('retryReplica in ready leaves isReplicaRetrying false', async () => {
		onEngine({ elements: 'engine' });
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

describe('the notice and the block react through $derived', () => {
	const onEngine = (surfaces: Record<string, string>) =>
		localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));

	/**
	 * `getReplicaNotice()`/`isReplicaBlocked()` short-circuit on whether some
	 * surface is on the engine before ever reading the phase; created here,
	 * BEFORE `startReplica()`, that first (false) answer is all a plain
	 * variable would ever see — this is `+page.svelte`'s own shape, so a
	 * regression there (e.g. a tracked value going back to a plain `let`)
	 * shows up here exactly as it would in the app.
	 */
	function deriveBoth(): { notice(): boolean; blocked(): boolean; dispose(): void } {
		let notice: (() => boolean) | undefined;
		let blocked: (() => boolean) | undefined;
		const dispose = $effect.root(() => {
			const n = $derived(getReplicaNotice());
			const b = $derived(isReplicaBlocked());
			notice = () => n;
			blocked = () => b;
		});
		return { notice: notice!, blocked: blocked!, dispose };
	}

	it('getReplicaNotice, derived before startReplica() and read once, still flips when the phase reaches server', async () => {
		onEngine({ elements: 'engine' });
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica({ connect: () => Promise.reject(new Error('no frame')) });

		const derived = deriveBoth();
		flushSync();
		expect(derived.notice()).toBe(false);
		expect(derived.blocked()).toBe(false);

		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'server');
		flushSync();

		expect(derived.notice()).toBe(true);
		derived.dispose();
	});

	it('isReplicaBlocked, derived before startReplica() and read once, still flips when the phase reaches failed', async () => {
		onEngine({ elements: 'engine' });
		const project = fakeProject();
		server.use(...project.handlers());
		const replica = realReplica();

		const derived = deriveBoth();
		flushSync();
		expect(derived.notice()).toBe(false);
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
		expect(getReplicaNotice()).toBe(false);

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
		expect(getStagingSide()).toBe('engine');
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
		const gaveUp = s.until((status) => status.phase === 'failed' || status.phase === 'server');
		feedPeer(s);
		await gaveUp;

		expect(getReplicaStatus().phase).toBe('failed');
		expect(isReplicaBlocked()).toBe(true);
		expect(getStagingSide()).toBe('engine');
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

	it("the shadow compares nothing while a commit's refresh is out, and again once it lands", async () => {
		localStorage.setItem('dr.shadow', '1');
		const project = fakeProject();
		let served = 0;
		let release!: () => void;
		const refresh = new Promise<void>((resolve) => (release = resolve));
		server.use(
			// Ahead of the project's own: the first handler that matches answers.
			http.get(`${PAGE_ORIGIN}/api/v1/projects/p/artifacts/payloads`, async ({ request }) => {
				const ids = new URL(request.url).searchParams.getAll('id');
				if (ids.length > 0) await refresh;
				const items = [...project.artifacts.values()].filter(
					(artifact) => ids.length === 0 || ids.includes(artifact.id)
				);
				return HttpResponse.json({ items });
			}),
			...project.handlers(),
			http.post('*/model/elements/batch', () => {
				served += 1;
				return HttpResponse.json({ items: [] });
			})
		);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const replica = realReplica();
		setActiveProject('p');
		startReplica();
		await replica.until((s) => s.phase === 'ready');
		await macrotask();
		const shadowLines = () =>
			errors.mock.calls.filter(([line]) =>
				String(line).startsWith('[shadow] elements getElementsBatch {"ids":["e_000001"]}')
			);
		const client = links[0]!.client;

		try {
			const tempId = stageArtifactCreate('navigation', 'b', scope('Project'), null);
			await vi.waitFor(async () =>
				expect(
					(await client.call<{ total: number }>('evaluateNavigation', { artifact_id: tempId }))
						.total
				).toBeGreaterThan(0)
			);

			// The commit clears the buffer and is announced in one run; its payloads are held.
			project.artifacts.set('n2', nav('n2', 1, 'Project'));
			clearStagedArtifacts();
			notifyArtifactCommit({
				idMap: { [tempId]: 'n2' },
				changed: [header(project.artifacts.get('n2') as ReturnType<typeof nav>)],
				deletedIds: []
			});
			expect(getStagedArtifactDepth()).toBe(0);
			await getElementsBatch(['e_000001']);
			await macrotask();
			await macrotask();
			expect(served).toBe(0);
			expect(shadowLines()).toEqual([]);

			release();
			await vi.waitFor(() =>
				expect(client.call('evaluateNavigation', { artifact_id: tempId })).rejects.toThrow(
					`unknown navigation artifact ${tempId}`
				)
			);
			await getElementsBatch(['e_000001']);
			await vi.waitFor(() => expect(shadowLines()).toHaveLength(1));
			expect(served).toBe(2);
		} finally {
			release();
		}
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

		it("is the server's until the first load lands, then the engine's; criteria never wait", async () => {
			const project = fakeProject();
			project.artifacts.set('n1', nav('n1', 1, 'Organization'));
			let release!: () => void;
			const first = new Promise<void>((resolve) => (release = resolve));
			const served = serve(project, [first], async () => ({
				step_types: [],
				chains: [],
				total: 999,
				truncated: false,
				warnings: []
			}));
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

			try {
				expect(engineSide('navigation')).toBe('server');
				expect(engineSide('criteria')).toBe('engine');
				const early = await evaluateNavigation({ definition: refUnion('n1') as never });
				expect(early.total).toBe(999);
				expect(served.served).toBe(1);
			} finally {
				release();
			}

			await vi.waitFor(() => expect(engineSide('navigation')).toBe('engine'));
			const late = await evaluateNavigation({ definition: refUnion('n1') as never });
			expect(late.total).toBe(organizations);
			expect(served.served).toBe(1);
		});

		it('a failed first load is asked once more, then the engine answers', async () => {
			const project = fakeProject();
			project.artifacts.set('n1', nav('n1', 1, 'Organization'));
			const served = serve(project, [503], () => Promise.reject(new Error('not asked')));
			const replica = realReplica();
			setActiveProject('p');
			startReplica();
			await replica.until((s) => s.phase === 'ready');

			await vi.waitFor(() => expect(engineSide('navigation')).toBe('engine'), { timeout: 5_000 });
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
			await vi.waitFor(() => expect(engineSide('navigation')).toBe('engine'));

			stopReplica();
			startReplica();
			await replica.until((s) => s.phase === 'ready');
			try {
				expect(engineSide('elements')).toBe('engine');
				expect(engineSide('navigation')).toBe('server');
			} finally {
				release();
			}
			await vi.waitFor(() => expect(engineSide('navigation')).toBe('engine'));
		});

		it('a shadow re-test waits for a payload fetch in flight', async () => {
			localStorage.setItem('dr.shadow', '1');
			const project = fakeProject();
			// The server holds n2 all along: it answers as the inlined definition does.
			const served = serve(project, [], () =>
				links[0]!.client.call<object>('evaluateNavigation', { definition: inlineUnion('Project') })
			);
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
			const replica = realReplica();
			setActiveProject('p');
			startReplica();
			await replica.until((s) => s.phase === 'ready');
			await vi.waitFor(() => expect(engineSide('navigation')).toBe('engine'));
			await macrotask();

			// A peer's navigation is announced; its payload is held on the way.
			let release!: () => void;
			served.named = new Promise<void>((resolve) => (release = resolve));
			project.artifacts.set('n2', nav('n2', 1, 'Project'));
			handReplicaFeed(
				{
					type: 'artifact',
					action: 'created',
					artifact: header(project.artifacts.get('n2') as ReturnType<typeof nav>)
				},
				'{}'
			);

			try {
				// The engine does not hold n2 yet; the server does.
				await expect(evaluateNavigation({ definition: refUnion('n2') as never })).rejects.toThrow(
					"unknown navigation artifact 'n2'"
				);
				await vi.waitFor(() => expect(served.served).toBe(1));
				await macrotask();
				await macrotask();
				expect(served.served).toBe(1);
			} finally {
				release();
			}

			await vi.waitFor(() => expect(served.served).toBe(2));
			await macrotask();
			await macrotask();
			expect(errors.mock.calls.filter(([line]) => String(line).startsWith('[shadow]'))).toEqual([]);
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

describe('the issues on the engine', () => {
	const API = `${PAGE_ORIGIN}/api/v1/projects/p`;
	const TOO_LONG = 'x'.repeat(201);
	const FROM_SERVER = {
		severity: 'error',
		message: 'from server',
		target_ids: ['e_000009'],
		check: 'facets',
		origin: 'on_server'
	};
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
	 * The engine store with the issues on the engine; the server's issue route
	 * answers FROM_SERVER. Every `getModelIssues` answer is recorded with the
	 * replica's `seeded` when it came and whether the server answered it.
	 */
	async function issuesStore(project = fakeProject()) {
		let serverHits = 0;
		server.use(
			http.get(`${API}/model/issues`, () => {
				serverHits += 1;
				return HttpResponse.json({ model_rev: 0, issues: [FROM_SERVER], counts: { error: 1 } });
			})
		);
		const real = validationApi.getModelIssues;
		const answers: { seeded: boolean; server: boolean; issues: unknown[] }[] = [];
		const spy = vi.spyOn(validationApi, 'getModelIssues').mockImplementation(async (cfg) => {
			const before = serverHits;
			const list = await real(cfg);
			answers.push({
				seeded: getReplicaStatus().seeded,
				server: serverHits > before,
				issues: list.issues
			});
			return list;
		});
		store = await engineStore({ project, surfaces: { issues: 'engine' } });
		return { s: store, spy, real, answers };
	}

	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	it('the gate opening at the end of the first sweep schedules one refetch, from the engine', async () => {
		const { s, spy, answers } = await issuesStore();
		if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
		expect(engineSide('issues')).toBe('engine');

		await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
		await sleep(350);
		expect(spy).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(answers).toHaveLength(1));
		expect(answers[0]).toEqual({ seeded: true, server: false, issues: [] });
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
		spy.mockImplementation((cfg) => {
			moved.push(-Date.now());
			return real(cfg);
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

	it('with the issues on the server, a changed schedules nothing', async () => {
		server.use(
			http.get(`${API}/model/issues`, () => HttpResponse.json({ model_rev: 0, issues: [] }))
		);
		const spy = vi.spyOn(validationApi, 'getModelIssues');
		store = await engineStore({ surfaces: { issues: 'server' } });
		const s = store;
		if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
		await ensureElements(['e_000001']);

		emit(rename('e_000001', TOO_LONG));
		await settled(s);
		await sleep(350);

		expect(engineSide('issues')).toBe('server');
		expect(spy).not.toHaveBeenCalled();
	});

	it('a worker that dies closes the gate: the server answers until the new replica is swept, then the engine, and no unswept list is adopted', async () => {
		const { s, answers } = await issuesStore();
		if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
		await ensureElements(['e_000001']);
		emit(rename('e_000001', TOO_LONG));
		await settled(s);
		await vi.waitFor(() => expect(getLiveIssues()).toEqual([tooLong]));
		const from = answers.length;

		s.link.dispose();
		const reseeded = s.until((status) => status.phase === 'ready' && status.seeded);
		// The engine is found gone under this call: the server answers it.
		await refetchIssues();
		expect(getReplicaStatus()).toMatchObject({ phase: 'resyncing', seeded: false });
		expect(getLiveIssues()).toEqual([FROM_SERVER]);
		// While the new replica opens, its gate is closed.
		await refetchIssues();
		expect(getLiveIssues()).toEqual([FROM_SERVER]);

		await reseeded;
		await vi.waitFor(() => expect(getLiveIssues()).toEqual([tooLong]));
		const later = answers.slice(from);
		expect(later.filter((answer) => !answer.seeded).every((answer) => answer.server)).toBe(true);
		expect(later.filter((answer) => answer.server)).toHaveLength(2);
		expect(later.at(-1)).toEqual({ seeded: true, server: false, issues: [tooLong] });
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

		it('a rules artifact whose load is slow: the gate stays closed until the follower has loaded, then the engine answers with its rule issues after one refetch', async () => {
			const load = hold();
			const project = holdPayloads({ whole: load.arrive() });
			project.artifacts.set('r1', rules);
			const { s, answers } = await issuesStore(project);
			if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
			await load.reached;

			// Swept, but the engine does not yet hold the rule set its list must carry.
			expect(engineSide('issues')).toBe('server');
			await vi.waitFor(() => expect(answers).toHaveLength(1));
			await refetchIssues();
			expect(answers.map((answer) => answer.server)).toEqual([true, true]);
			expect(getLiveIssues()).toEqual([FROM_SERVER]);

			load.release();
			await vi.waitFor(() => expect(engineSide('issues')).toBe('engine'));
			const listed = ruleIssues('de-only', NOT_DE, 'on_server');
			await vi.waitFor(() => expect(getLiveIssues()).toEqual(listed));
			await sleep(350);
			// The load and the rules it brings share one refetch, answered after the rescan.
			expect(answers.slice(2)).toEqual([{ seeded: true, server: false, issues: listed }]);
			expect(s.project.rulesParsed).toEqual([]);
		});

		it("no rules artifact, a slow load: the server's list until it lands, then the engine's", async () => {
			const load = hold();
			const { s, answers } = await issuesStore(holdPayloads({ whole: load.arrive() }));
			if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
			await load.reached;
			await vi.waitFor(() => expect(answers).toHaveLength(1));
			await ensureElements(['e_000001']);
			emit(rename('e_000001', TOO_LONG));
			await settled(s);
			await vi.waitFor(() => expect(answers).toHaveLength(2));
			expect(answers.every((answer) => answer.server)).toBe(true);
			expect(getLiveIssues()).toEqual([FROM_SERVER]);

			load.release();
			await vi.waitFor(() => expect(getLiveIssues()).toEqual([tooLong]));
			expect(answers.at(-1)).toMatchObject({ seeded: true, server: false });
		});

		it("a rules artifact a peer commits while the engine's list is shown: the engine's list takes its rules", async () => {
			const held: { named?: Promise<void> } = {};
			const { s, answers } = await issuesStore(holdPayloads(held));
			if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
			await vi.waitFor(() => expect(answers).toHaveLength(1));
			expect(answers[0]).toMatchObject({ server: false });
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
			expect(answers.at(-1)).toMatchObject({ server: false });

			fetched.release();
			const listed = [tooLong, ...ruleIssues('de-only', NOT_DE, 'on_server')];
			await vi.waitFor(() => expect(byKey(getLiveIssues())).toEqual(byKey(listed)));
			expect(answers.every((answer) => !answer.server)).toBe(true);
		});

		it('the user commits a staged rules create: each rule issue is listed once, uncommitted until the refresh lands, then on_server', async () => {
			const held: { named?: Promise<void> } = {};
			const project = holdPayloads(held);
			project.rulesParses.set(A, parsed(DE_ONLY));
			const { s, answers } = await issuesStore(project);
			if (!getReplicaStatus().seeded) await s.until((status) => status.seeded);
			await vi.waitFor(() => expect(engineSide('issues')).toBe('engine'));
			await vi.waitFor(() => expect(answers).toHaveLength(1));

			const tempId = stageArtifactCreate('validation_rules', 'R', rulesPayload(A), null);
			const staged = ruleIssues('de-only', NOT_DE, 'uncommitted');
			await vi.waitFor(() => expect(getLiveIssues()).toEqual(staged));
			expect(project.rulesParsed).toEqual([A]);
			const from = answers.length;

			// The commit: the buffer is cleared and the commit announced in one run.
			const fetched = hold();
			held.named = fetched.arrive();
			const committed = ruleSet('r9', 'R', A, parsed(DE_ONLY));
			project.artifacts.set('r9', committed);
			clearStagedArtifacts();
			notifyArtifactCommit({
				idMap: { [tempId]: 'r9' },
				changed: [headerOf(committed)],
				deletedIds: []
			});
			await fetched.reached;
			// While the refresh is out, the rule set stands under its real id alone, still staged.
			await refetchIssues();
			expect(getLiveIssues()).toEqual(staged);

			fetched.release();
			const listed = ruleIssues('de-only', NOT_DE, 'on_server');
			await vi.waitFor(() => expect(getLiveIssues()).toEqual(listed));
			await sleep(350);
			expect(getLiveIssues()).toEqual(listed);
			const after = answers.slice(from);
			expect(after.every((answer) => !answer.server)).toBe(true);
			const firstLanded = after.findIndex(
				(answer) => byKey(answer.issues).join() === byKey(listed).join()
			);
			expect(firstLanded).toBeGreaterThanOrEqual(0);
			expect(
				after.slice(0, firstLanded).every((a) => byKey(a.issues).join() === byKey(staged).join())
			).toBe(true);
			expect(
				after.slice(firstLanded).every((a) => byKey(a.issues).join() === byKey(listed).join())
			).toBe(true);
			expect(project.rulesParsed).toEqual([A]);
		});
	});
});
