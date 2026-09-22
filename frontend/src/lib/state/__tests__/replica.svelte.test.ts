import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { IDBFactory } from 'fake-indexeddb';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import { engineSide } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import { getElementsBatch } from '$lib/api/model-read';
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
import { BASE, fakeProject, hold } from '$lib/engine/__tests__/support/project-server';
import * as openJourney from '../open-journey';
import { clearActiveProject, setActiveProject } from '../active-project.svelte';
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
	stopReplica
} from '../replica.svelte';

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
 * the first status, from now on, that passes its test.
 */
function realReplica(overrides: Partial<SyncDeps> = {}) {
	const statuses: ReplicaStatus[] = [];
	const watchers: { test: (s: ReplicaStatus) => boolean; resolve(): void }[] = [];
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
		until: (test: (s: ReplicaStatus) => boolean) =>
			new Promise<void>((resolve) => watchers.push({ test, resolve }))
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
		dropViewPlacement: vi.fn()
	} satisfies ReplicaSync;
}

const runs = <T>(values: T[]): T[] =>
	values.filter((value, i) => i === 0 || values[i - 1] !== value);

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The feed frame of `committed`, its state digest flipped: the replica diverges on it. */
function withWrongDigest(committed: { delta: Record<string, unknown>; eventText: string }): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	return committed.eventText.replace(`"state_digest":"${digest}"`, `"state_digest":"${wrong}"`);
}

/** Ready, then a divergence whose re-bootstrap cannot download: `failed`. */
async function failReplica(
	project: ReturnType<typeof fakeProject>,
	replica: ReturnType<typeof realReplica>
): Promise<void> {
	await replica.until((s) => s.phase === 'ready');
	project.fail('snapshot', 503, 99);
	const committed = project.commit([
		{ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'peer' } }
	]);
	handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, withWrongDigest(committed));
	await replica.until((s) => s.phase === 'failed');
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
	const onEngine = (surfaces: Record<string, string>) =>
		localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));

	it('startReplica installs a seam whose sides follow dr.surfaces and the phase', async () => {
		onEngine({ search: 'server' });
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
		onEngine({ search: 'server' });
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
	const READY: ReplicaStatus = { ...OFF, phase: 'ready', rev: 0 };
	const onStaging = (staging: string) =>
		localStorage.setItem('dr.surfaces', JSON.stringify({ staging }));

	it('is legacy without a sync', () => {
		expect(getStagingSide()).toBe('legacy');
	});

	it("is legacy with dr.surfaces {staging: 'legacy'}, even at ready", () => {
		onStaging('legacy');
		const status = { current: READY };
		configureReplica({ sync: spySync(undefined, status) });
		setActiveProject('p');
		startReplica();

		expect(getStagingSide()).toBe('legacy');
	});

	it("is engine with {staging: 'engine'} at ready", () => {
		onStaging('engine');
		const status = { current: READY };
		configureReplica({ sync: spySync(undefined, status) });
		setActiveProject('p');
		startReplica();

		expect(getStagingSide()).toBe('engine');
	});

	it('is legacy at server and at off, staging on the engine', () => {
		onStaging('engine');
		const status = { current: READY };
		configureReplica({ sync: spySync(undefined, status) });
		setActiveProject('p');
		startReplica();

		status.current = { ...OFF, phase: 'server' };
		expect(getStagingSide()).toBe('legacy');

		status.current = OFF;
		expect(getStagingSide()).toBe('legacy');
	});

	it('is engine at failed and frozen, staging on the engine', () => {
		onStaging('engine');
		const status = { current: READY };
		configureReplica({ sync: spySync(undefined, status) });
		setActiveProject('p');
		startReplica();

		status.current = { ...OFF, phase: 'failed' };
		expect(getStagingSide()).toBe('engine');

		status.current = { ...OFF, phase: 'frozen' };
		expect(getStagingSide()).toBe('engine');
	});
});

describe('replicaGate', () => {
	const onEngine = (surfaces: Record<string, string>) =>
		localStorage.setItem('dr.surfaces', JSON.stringify(surfaces));
	// A default may put a surface on the engine (see `lib/engine/surfaces.ts`);
	// force every one to `server` for a test about there being none on it.
	const onServer = () => onEngine(Object.fromEntries(SURFACES.map((s) => [s, 'server'])));

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
	// force every one to `server` for a test about there being none on it.
	const onServer = () => onEngine(Object.fromEntries(SURFACES.map((s) => [s, 'server'])));

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
