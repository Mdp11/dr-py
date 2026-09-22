// The model store with staging on the engine: the replica store over a fake
// project, the real engine behind it, and no model read route on the server.
import { vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { server } from '$lib/api/__tests__/server';
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
import { resetModelStore } from '../../model.svelte';
import { configureReplica, resetReplica, startReplica } from '../../replica.svelte';

export type EngineStore = {
	project: FakeProject;
	/** The sync the replica store built. */
	sync: ReplicaSync;
	/** The link made last: `link.client` reaches the engine behind the sync directly. */
	readonly link: EngineLink;
	statuses: ReplicaStatus[];
	/** Resolves on the first status, from now on, that passes `test`. */
	until(test: (status: ReplicaStatus) => boolean): Promise<void>;
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
