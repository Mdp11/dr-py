/**
 * The tab's replica: one `ReplicaSync` (lib/engine/sync.ts), its status as
 * state. The workspace page starts and stops it, the feed hands it commit,
 * rebind and snapshot events, the two commit paths bracket their POST with a
 * flight, and the two metamodel-adoption paths tell it the UI moved on. The
 * status bar's indicator is the only thing that reads it.
 */

import type { FeedEvent } from '$lib/api/feed';
import { createSnapshotCache } from '$lib/engine/cache';
import { connectFrame } from '$lib/engine/frame';
import {
	createReplicaSync,
	OFF,
	replicaApi,
	type CommitFlight,
	type ReplicaStatus,
	type ReplicaSync,
	type SyncDeps
} from '$lib/engine/sync';
import { getActiveProjectId } from './active-project.svelte';

let _status = $state.raw<ReplicaStatus>(OFF);
let _sync: ReplicaSync | null = null;
let _deps: Partial<SyncDeps> | undefined;

const NO_FLIGHT: CommitFlight = { settle() {}, abandon() {} };

function build(overrides: Partial<SyncDeps> = {}): ReplicaSync {
	const observe = overrides.onStatus;
	const made: ReplicaSync = createReplicaSync({
		connect: overrides.connect ?? (() => connectFrame()),
		api: overrides.api ?? replicaApi(),
		cache: overrides.cache ?? createSnapshotCache(),
		sleep: overrides.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		onStatus: (status) => {
			// A sync that was replaced speaks for nothing the UI shows.
			if (_sync !== made) return;
			_status = status;
			observe?.(status);
		}
	});
	return made;
}

/** The replica's status; reactive. */
export function getReplicaStatus(): ReplicaStatus {
	return _status;
}

/** Opens the active project's replica; nothing without an active project. */
export function startReplica(): void {
	const projectId = getActiveProjectId();
	if (!projectId) return;
	_sync ??= build(_deps);
	_sync.open(projectId);
}

export function stopReplica(): void {
	_sync?.stop();
}

/**
 * Called first for every feed event. A commit is handed over only with the
 * frame's own text: a re-serialized event would have lost what the replica's
 * digest sees (`1.0`, integers past 2^53).
 */
export function handReplicaFeed(event: FeedEvent, raw: string | undefined): void {
	const sync = _sync;
	if (sync === null) return;
	switch (event.type) {
		case 'commit':
			if (raw !== undefined) sync.feedCommit(raw, event.rev);
			break;
		case 'rebind':
			sync.feedRebind(event.rev);
			break;
		case 'snapshot':
			sync.feedSnapshot(event.model_rev);
			break;
	}
}

/**
 * Called BEFORE the user's own commit is posted: the replica holds its feed
 * until the flight is settled with the response or abandoned.
 */
export function beginReplicaCommit(): CommitFlight {
	return _sync?.beginCommit() ?? NO_FLIGHT;
}

/** The UI adopted the metamodel the server serves now; a frozen replica follows it. */
export function replicaMetamodelAdopted(): void {
	_sync?.metamodelAdopted();
}

/**
 * Tests: `deps` replaces single dependencies of the sync built next (its
 * `onStatus` observes the status after the store has taken it); `sync`
 * replaces the whole sync. `null` returns to the production dependencies.
 * The current sync is stopped and dropped either way.
 */
export function configureReplica(
	options: { deps?: Partial<SyncDeps>; sync?: ReplicaSync } | null
): void {
	resetReplica();
	_deps = options?.deps;
	_sync = options?.sync ?? null;
}

/** Test isolation. */
export function resetReplica(): void {
	const sync = _sync;
	_sync = null;
	_deps = undefined;
	sync?.stop();
	_status = OFF;
}
