/**
 * The tab's replica: one `ReplicaSync` (lib/engine/sync.ts), its status as
 * state. The workspace page starts and stops it, the feed hands it commit,
 * rebind, snapshot and reset events, the two commit paths bracket their POST
 * with a flight, the two metamodel-adoption paths tell it the UI moved on,
 * and the view store registers what the committed view places. While it
 * runs, the engine seam is installed: each read surface is answered by the
 * replica or the server, as `dr.surfaces` says (read once per page load).
 */

import { installEngineSeam, type Side, type Surface } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import { createSnapshotCache } from '$lib/engine/cache';
import { connectFrame } from '$lib/engine/frame';
import { addQuietProbe, quiet } from '$lib/engine/quiet';
import { createEngineSeam } from '$lib/engine/seam';
import { anyEngineSurface, readSurfaces } from '$lib/engine/surfaces';
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
/** The switches, read at the first start and kept until `resetReplica()`. */
let _surfaces: Record<Surface, Side> | null = null;
/** Moves at every install and uninstall: a shadow that loads late lands only on its own seam. */
let _seamToken = 0;
let _removeQuietProbe: (() => void) | null = null;
/** The views whose placements were handed to the sync; the sync keeps the lists. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _placedViews = new Set<string>();

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

/**
 * Routes the read surfaces through `sync`. In dev, with `dr.shadow` set, the
 * seam is installed again with a shadow once that module has loaded; a build
 * holds none of it.
 */
function installSeam(sync: ReplicaSync): void {
	uninstallSeam();
	const surfaces = (_surfaces ??= readSurfaces());
	const token = _seamToken;
	installEngineSeam(createEngineSeam(sync, surfaces));
	_removeQuietProbe = addQuietProbe(() => sync.settled());
	if (import.meta.env.DEV && anyEngineSurface(surfaces)) {
		void import('../engine/shadow')
			.then(({ createShadow, shadowEnabled }) => {
				if (token !== _seamToken || !shadowEnabled()) return;
				const shadow = createShadow({
					rev: () => sync.status().rev,
					quiet,
					report: (line) => console.error(line)
				});
				installEngineSeam(createEngineSeam(sync, surfaces, shadow));
			})
			.catch(() => {});
	}
}

function uninstallSeam(): void {
	_seamToken += 1;
	installEngineSeam(null);
	_removeQuietProbe?.();
	_removeQuietProbe = null;
}

/** The replica's status; reactive. */
export function getReplicaStatus(): ReplicaStatus {
	return _status;
}

/** Opens the active project's replica and installs the seam; nothing without an active project. */
export function startReplica(): void {
	const projectId = getActiveProjectId();
	if (!projectId) return;
	const sync = (_sync ??= build(_deps));
	installSeam(sync);
	sync.open(projectId);
}

/** Every read goes to the server again; the sync forgets the placements. */
export function stopReplica(): void {
	uninstallSeam();
	_placedViews.clear();
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
		case 'reset':
			sync.feedReset(event.model_rev);
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
 * The element ids a view places, as the excluded-roots read leaves them out.
 * Without a sync nothing is kept: the page starts the replica before the view
 * store's first refresh.
 */
export function registerViewPlacement(viewId: string, elementIds: readonly string[]): void {
	if (_sync === null) return;
	_placedViews.add(viewId);
	_sync.setViewPlacement(viewId, elementIds);
}

export function forgetViewPlacement(viewId: string): void {
	_placedViews.delete(viewId);
	_sync?.dropViewPlacement(viewId);
}

export function forgetViewPlacements(): void {
	for (const viewId of _placedViews) _sync?.dropViewPlacement(viewId);
	_placedViews.clear();
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

/** Test isolation; the next start reads the switches again. */
export function resetReplica(): void {
	const sync = _sync;
	_sync = null;
	_deps = undefined;
	uninstallSeam();
	_surfaces = null;
	_placedViews.clear();
	sync?.stop();
	_status = OFF;
}
