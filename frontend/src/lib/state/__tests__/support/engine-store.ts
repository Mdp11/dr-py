// The model store with staging on the engine: the replica store over a fake
// project, the real engine behind it, and no model read route on the server.
import { vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { server } from '$lib/api/__tests__/server';
import type { FeedEvent } from '$lib/api/feed';
import type { OpsResponse } from '$lib/api/types';
import { createSnapshotCache } from '$lib/engine/cache';
import type { EngineLink } from '$lib/engine/client';
import * as syncModule from '$lib/engine/sync';
import { replicaApi, type ReplicaStatus, type ReplicaSync } from '$lib/engine/sync';
import { connectInProcess } from '$lib/engine/testing';
import {
	BASE,
	fakeProject,
	type Committed,
	type FakeProject
} from '$lib/engine/__tests__/support/project-server';
import { clearActiveProject, setActiveProject } from '../../active-project.svelte';
import { getCachedElements, resetModelStore, stagedSettled } from '../../model.svelte';
import type { ModelOp } from '../../ops';
import {
	configureReplica,
	handReplicaFeed,
	resetReplica,
	startReplica
} from '../../replica.svelte';

export type UntilFn = (test: (status: ReplicaStatus) => boolean, from?: number) => Promise<void>;

export type EngineStore = {
	project: FakeProject;
	/** The sync the replica store built. */
	sync: ReplicaSync;
	/** The link made last: `link.client` reaches the engine behind the sync directly. */
	readonly link: EngineLink;
	statuses: ReplicaStatus[];
	/** Resolves on the first status, from now on, that passes `test`. */
	until: UntilFn;
	dispose(): void;
};

/**
 * `dr.surfaces` = `{staging: 'engine'}`, the project's four replica routes on
 * MSW, the replica store started on it; resolves once the replica is ready.
 * Nothing serves a model read: one that strays to the server fails the test.
 */
export async function engineStore(options: { project?: FakeProject } = {}): Promise<EngineStore> {
	const project = options.project ?? fakeProject();
	server.use(...project.handlers());
	localStorage.setItem('dr.surfaces', JSON.stringify({ staging: 'engine' }));
	const links: EngineLink[] = [];
	const statuses: ReplicaStatus[] = [];
	const watchers: { test: (s: ReplicaStatus) => boolean; resolve(): void }[] = [];
	const until = (test: (s: ReplicaStatus) => boolean) =>
		new Promise<void>((resolve) => watchers.push({ test, resolve }));
	configureReplica({
		deps: {
			connect: () => {
				const link = connectInProcess();
				links.push(link);
				return Promise.resolve(link);
			},
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
			}
		}
	});
	setActiveProject(project.projectId);
	// The replica store keeps its sync to itself; the one it builds is caught here.
	const built = vi.spyOn(syncModule, 'createReplicaSync');
	const ready = until((s) => s.phase === 'ready');
	startReplica();
	const sync = built.mock.results[0]?.value as ReplicaSync | undefined;
	built.mockRestore();
	if (sync === undefined) throw new Error('startReplica built no sync');
	await ready;
	return {
		project,
		sync,
		get link(): EngineLink {
			const link = links.at(-1);
			if (link === undefined) throw new Error('no link was made');
			return link;
		},
		statuses,
		until,
		dispose() {
			resetReplica();
			resetModelStore();
			for (const link of links.splice(0)) link.dispose();
			clearActiveProject();
			server.resetHandlers();
			localStorage.removeItem('dr.surfaces');
		}
	};
}

/** The `OpsResponse` the realtime store makes of a peer's commit frame. */
export function peerDelta(committed: Committed): OpsResponse {
	const event = JSON.parse(committed.eventText) as {
		rev: number;
		changed_elements: OpsResponse['changed_elements'];
		changed_relationships: OpsResponse['changed_relationships'];
		deleted_element_ids: string[];
		deleted_relationship_ids: string[];
	};
	return {
		model_rev: event.rev,
		id_map: {},
		changed_elements: event.changed_elements,
		changed_relationships: event.changed_relationships,
		deleted_element_ids: event.deleted_element_ids,
		deleted_relationship_ids: event.deleted_relationship_ids,
		issues_removed_owner_ids: [],
		issues_added: [],
		issue_counts: {}
	};
}

export const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

export const create = (tempId: string, name: string): ModelOp => ({
	kind: 'create_element',
	temp_id: tempId,
	type_name: 'Organization',
	properties: { name }
});

/** The cached name of `id`, or `undefined` if it is not cached. */
export function nameOf(id: string): unknown {
	return getCachedElements().get(id)?.properties['name'];
}

/** Everything the engine said has reached the store. */
export async function settled(s: EngineStore): Promise<void> {
	await s.sync.settled();
	await stagedSettled();
}

/** The feed frame of `committed`, its state digest flipped: the replica diverges on it. */
export function withWrongDigest(committed: Committed): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	return committed.eventText.replace(`"state_digest":"${digest}"`, `"state_digest":"${wrong}"`);
}

/**
 * Forces `failed`: a peer's commit whose feed frame carries the wrong state
 * digest, with the snapshot route down so the re-bootstrap it triggers
 * cannot download. `waitForReady` (default true) awaits `ready` first; skip
 * it when the caller already knows the replica is there — a plain status
 * list (`engineStore()`'s `until`) has no history to check, unlike
 * `realReplica()`'s, which also matches a status already recorded.
 */
export async function forceFailed(
	s: { project: FakeProject; until: UntilFn },
	options: { waitForReady?: boolean } = {}
): Promise<Committed> {
	if (options.waitForReady ?? true) await s.until((status) => status.phase === 'ready');
	s.project.fail('snapshot', 503, 99);
	const committed = s.project.commit([
		{ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'peer' } }
	]);
	const failed = s.until((status) => status.phase === 'failed');
	handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, withWrongDigest(committed));
	await failed;
	return committed;
}
