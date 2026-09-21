import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import { IDBFactory } from 'fake-indexeddb';
import { server } from '$lib/api/__tests__/server';
import type { FeedEvent } from '$lib/api/feed';
import { createSnapshotCache } from '$lib/engine/cache';
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
import { BASE, fakeProject } from '$lib/engine/__tests__/support/project-server';
import { clearActiveProject, setActiveProject } from '../active-project.svelte';
import {
	beginReplicaCommit,
	configureReplica,
	getReplicaStatus,
	handReplicaFeed,
	replicaMetamodelAdopted,
	resetReplica,
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

/** A sync that records what it is told and does nothing. */
function spySync(flight: CommitFlight = { settle: vi.fn(), abandon: vi.fn() }) {
	return {
		open: vi.fn(),
		stop: vi.fn(),
		status: vi.fn(() => OFF),
		settled: vi.fn(() => Promise.resolve()),
		feedCommit: vi.fn(),
		feedRebind: vi.fn(),
		feedSnapshot: vi.fn(),
		beginCommit: vi.fn(() => flight),
		metamodelAdopted: vi.fn()
	} satisfies ReplicaSync;
}

const runs = <T>(values: T[]): T[] =>
	values.filter((value, i) => i === 0 || values[i - 1] !== value);

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
