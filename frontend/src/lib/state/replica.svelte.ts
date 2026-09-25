/**
 * The tab's replica: one `ReplicaSync` (lib/engine/sync.ts), its status as
 * state. The workspace page starts and stops it, the feed hands it commit,
 * rebind, snapshot and reset events, the two commit paths bracket their POST
 * with a flight, the two metamodel-adoption paths tell it the UI moved on,
 * and the view store registers what the committed view places. While it
 * runs, the engine seam is installed: each read surface is answered by the
 * replica or the server, as `dr.surfaces` says (read once per page load);
 * with staging on the engine, the model store's engine half follows it
 * through a handle (`attachEngine`). An artifact follower keeps the project's
 * artifacts, committed and staged, in the sync's context, each staged rule
 * set with the server's parse of its YAML. With the issues on
 * the engine, the live issue list is refetched whenever the replica's issue
 * store moves; with the tables on the engine, the open tables re-page
 * whenever what they read moves.
 */

import type { WireBatch } from '$engine';
import { listArtifactPayloads } from '$lib/api/artifacts';
import { engineSide, installEngineSeam } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import { parseRules } from '$lib/api/rules';
import { createArtifactFollower, type ArtifactFollower } from '$lib/engine/artifacts';
import { createSnapshotCache } from '$lib/engine/cache';
import { connectFrame } from '$lib/engine/frame';
import { addQuietProbe, quiet } from '$lib/engine/quiet';
import { createRulesParser } from '$lib/engine/rules-parse';
import { createEngineSeam, type SurfaceGates } from '$lib/engine/seam';
import { anyStaged } from '$lib/engine/staged-probe';
import {
	anyEngineSurface,
	readSwitches,
	type StagingSide,
	type Switches
} from '$lib/engine/surfaces';
import {
	createReplicaSync,
	OFF,
	replicaApi,
	type CallOptions,
	type CommitFlight,
	type ReplicaStatus,
	type ReplicaSync,
	type SyncDeps
} from '$lib/engine/sync';
import { getActiveProjectId } from './active-project.svelte';
import {
	bindStagedArtifacts,
	getStagedArtifactDepth,
	onArtifactCommit,
	onStagedArtifactsChanged,
	stagedArtifactsForEngine
} from './artifact-edits.svelte';
import {
	attachEngine,
	detachEngine,
	forgetBatches,
	handOverStaged,
	type EngineHandle,
	type StatusListener
} from './model-engine.svelte';
import { markStructureChanged, scheduleIssuesRefetch } from './model-shared.svelte';
import { journeyReplica } from './open-journey';

let _status = $state.raw<ReplicaStatus>(OFF);
let _sync: ReplicaSync | null = null;
let _deps: Partial<SyncDeps> | undefined;
/** The switches, read at the first start and kept until `resetReplica()`; tracked so a `$derived` reading it stays live. */
let _switches = $state.raw<Switches | null>(null);
/** Moves at every install and uninstall: a shadow that loads late lands only on its own seam. */
let _seamToken = 0;
let _removeQuietProbe: (() => void) | null = null;
/** `replicaGate()` waiters, released once the phase leaves `opening`. */
let _gateWaiters: Array<() => void> = [];
/** The views whose placements were handed to the sync; the sync keeps the lists. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _placedViews = new Set<string>();
/** Cleared on every `startReplica()`. */
let _noticeDismissed = $state(false);
/** Set by `retryReplica()`, cleared once the retry lands at `ready`, `failed`, `off` or `server`. */
let _retrying = $state(false);
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _statusListeners = new Set<StatusListener>();
/** Unsubscribes the issues refetch from the sync's `changed` events. */
let _offChanged: (() => void) | null = null;
/** Unsubscribes the tables' re-page from the sync's `changed` events. */
let _offTablesChanged: (() => void) | null = null;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _tablesListeners = new Set<() => void>();
/** The last `changed` tuple the tables followed, on the engine side. */
let _tablesSeen: string | null = null;
/** The sync reported `off` since its last `ready`: the tables went to the server meanwhile. */
let _offSinceReady = false;
/** The started replica's artifact follower, the project it follows, and its quiet probe's remover. */
let _follower: {
	projectId: string;
	follower: ArtifactFollower;
	removeQuiet: () => void;
} | null = null;

onArtifactCommit(({ idMap, changed, deletedIds }) =>
	_follower?.follower.onCommit({ idMap, changed, deletedIds })
);
onStagedArtifactsChanged(() => _follower?.follower.stagedChanged());

const NO_FLIGHT: CommitFlight = { settle() {}, abandon() {} };

/** Before a failed artifact load's one retry. */
const LOAD_RETRY_MS = 1_000;

function build(overrides: Partial<SyncDeps> = {}): ReplicaSync {
	const observe = overrides.onStatus;
	const made: ReplicaSync = createReplicaSync({
		connect: overrides.connect ?? (() => connectFrame()),
		api: overrides.api ?? replicaApi(),
		cache: overrides.cache ?? createSnapshotCache(),
		sleep: overrides.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
		// The model store's engine half: its copy of the staged batches for a
		// worker that died (its ops are the plain objects the engine reads), and
		// the committed batches no replica will hold. Detached, it holds none.
		heldFallback: overrides.heldFallback ?? (() => handOverStaged() as unknown as WireBatch[]),
		onAbandoned: overrides.onAbandoned ?? ((batchIds) => forgetBatches(batchIds)),
		onStatus: (status) => {
			// A sync that was replaced speaks for nothing the UI shows.
			if (_sync !== made) return;
			const previousPhase = _status.phase;
			const issuesWereOpen = issuesOnEngine(_status);
			setStatus(status);
			// The live list was the server's until now: the engine's replaces it.
			if (!issuesWereOpen && issuesOnEngine(status)) scheduleIssuesRefetch();
			observe?.(status);
			// Only `opening`: `resyncing` also reports progress, but a re-bootstrap
			// is not the journey's open, and `ready`'s own `verify` progress is not
			// a phase the journey has slices for either.
			if (status.phase === 'opening' && status.progress) journeyReplica(status.progress);
			if (status.phase !== 'opening') _releaseGate();
			// A re-bootstrap (a retried `failed`, or one the replica started on its
			// own over a divergence) may have moved entities the tree and the
			// relationships list were built from; a plain first open moves
			// nothing, so it stays out of this.
			if (previousPhase === 'resyncing' && status.phase === 'ready') markStructureChanged();
			if (status.phase === 'off') _offSinceReady = true;
			if (status.phase === 'ready' && previousPhase !== 'ready') {
				// A replica built again posts no `changed` for what it now holds, and a
				// table asked meanwhile may have been the server's, over committed state.
				if (previousPhase === 'resyncing' || (previousPhase === 'opening' && _offSinceReady)) {
					_tablesSeen = null;
					tablesMoved();
				}
				_offSinceReady = false;
			}
			if (
				_retrying &&
				(status.phase === 'ready' ||
					status.phase === 'failed' ||
					status.phase === 'off' ||
					status.phase === 'server')
			) {
				_retrying = false;
			}
		}
	});
	return made;
}

/** Every status change goes through here, so each listener hears it with the one before. */
function setStatus(status: ReplicaStatus): void {
	const previous = _status;
	if (status === previous) return;
	_status = status;
	for (const listener of [..._statusListeners]) {
		if (!_statusListeners.has(listener)) continue;
		try {
			listener(status, previous);
		} catch (error) {
			// A failing listener must not break the sync that reported the status.
			queueMicrotask(() => {
				throw error;
			});
		}
	}
}

/** `listener` hears every status change, with the status before it; the returned function unsubscribes. */
export function subscribeReplicaStatus(listener: StatusListener): () => void {
	const entry: StatusListener = (status, previous) => listener(status, previous);
	_statusListeners.add(entry);
	return () => {
		_statusListeners.delete(entry);
	};
}

/** The model store's way into `sync`: its calls and `changed` events, and this store's status. */
function engineHandle(sync: ReplicaSync): EngineHandle {
	return {
		call: <T>(method: string, params?: unknown, options?: CallOptions) =>
			sync.call<T>(method, params, options),
		on: (event, listener) => sync.on(event, listener),
		status: () => _status,
		subscribe: subscribeReplicaStatus
	};
}

function _releaseGate(): void {
	if (_gateWaiters.length === 0) return;
	const waiters = _gateWaiters;
	_gateWaiters = [];
	for (const resolve of waiters) resolve();
}

/**
 * Whether the issues are the engine's at `status`: their switch says so,
 * staging is on the engine (whose working copy holds the staged edits, as
 * the legacy buffer's are not) and the replica's first sweep has ended.
 */
function issuesOnEngine(status: ReplicaStatus): boolean {
	return (
		_switches !== null &&
		_switches.surfaces.issues === 'engine' &&
		stagingOnEngine(status) &&
		status.seeded
	);
}

function stagingOnEngine(status: ReplicaStatus): boolean {
	if (_switches === null || _switches.staging !== 'engine') return false;
	return status.phase !== 'off' && status.phase !== 'server';
}

/** Whether some read surface is on the engine — the gate, the notice and the block all exist only then. */
function _anyEngine(): boolean {
	return _switches !== null && anyEngineSurface(_switches);
}

/**
 * Routes the read surfaces through `sync`; navigations, tables and issues
 * only once the follower has loaded the artifacts. In dev, with `dr.shadow` set, the
 * seam is installed again with a shadow once that module has loaded, idle
 * while the model store's engine half has an edit staged, an artifact entry
 * is staged, or the follower still lays a commit's entries over the
 * committed artifacts; a build holds none of it.
 */
function installSeam(sync: ReplicaSync): void {
	uninstallSeam();
	const switches = (_switches ??= readSwitches());
	const surfaces = switches.surfaces;
	const token = _seamToken;
	const gates: SurfaceGates = {
		// A navigation may name artifacts: the engine answers once it holds them.
		navigation: () => _follower?.follower.loaded() ?? false,
		// So may a table, by its own id or through its navigations.
		tables: () => _follower?.follower.loaded() ?? false,
		// A store swept part-way is not the model's list, and until the artifacts
		// are held the engine knows none of the rule sets its list must carry.
		issues: () =>
			getStagingSide() === 'engine' &&
			sync.status().seeded &&
			(_follower?.follower.loaded() ?? false)
	};
	installEngineSeam(createEngineSeam(sync, surfaces, undefined, gates));
	_removeQuietProbe = addQuietProbe(() => sync.settled());
	if (import.meta.env.DEV && anyEngineSurface(switches)) {
		void import('../engine/shadow')
			.then(({ createShadow, shadowEnabled }) => {
				if (token !== _seamToken || !shadowEnabled()) return;
				const shadow = createShadow({
					rev: () => sync.status().rev,
					quiet,
					staged: () =>
						anyStaged() ||
						getStagedArtifactDepth() > 0 ||
						(_follower?.follower.hasOverlay() ?? false),
					report: (line) => console.error(line)
				});
				installEngineSeam(createEngineSeam(sync, surfaces, shadow, gates));
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

/**
 * Where the user's model edits are staged. `engine` iff the `staging` switch
 * says so AND the replica is neither `off` nor `server` — `failed` and
 * `frozen` keep `engine`, since the sync holds the batches staged there
 * across a re-bootstrap (see `lib/engine/sync.ts`'s "a re-bootstrap carries
 * the batches"). `legacy` without a sync: nothing is open to stage into.
 * Reads `_status` (reactive), not `_sync.status()` — the facade's `side()`
 * calls this on every entity-half read, including from a `$derived`, and
 * `_status` is what `onStatus` keeps current for the sync in use.
 */
export function getStagingSide(): StagingSide {
	return stagingOnEngine(_status) ? 'engine' : 'legacy';
}

/**
 * Opens the active project's replica and installs the seam; with staging on
 * the engine, the model store's engine half follows it. Nothing without an
 * active project.
 */
export function startReplica(): void {
	const projectId = getActiveProjectId();
	if (!projectId) return;
	_noticeDismissed = false;
	const sync = (_sync ??= build(_deps));
	installSeam(sync);
	// Not with staging on legacy: attached, the engine half would move the
	// structure rev on every delta the replica applies, as the legacy half does.
	if (_switches?.staging === 'engine') attachEngine(engineHandle(sync));
	followIssues(sync);
	followTables(sync);
	sync.open(projectId);
	// Before the follower mirrors the buffer: one staged in another project is dropped.
	bindStagedArtifacts(projectId);
	follow(sync, projectId);
}

/**
 * With the issues on the engine, a `changed` whose `issues_version` moved
 * refetches the live list. The version is per worker, so a new worker's
 * first may repeat an old one; the gate opening after its sweep refetches.
 */
function followIssues(sync: ReplicaSync): void {
	stopFollowingIssues();
	let seen: number | null = null;
	_offChanged = sync.on('changed', (event) => {
		if (event.issues_version === seen) return;
		seen = event.issues_version;
		if (issuesOnEngine(_status)) scheduleIssuesRefetch();
	});
}

function stopFollowingIssues(): void {
	_offChanged?.();
	_offChanged = null;
}

/**
 * `listener` is called whenever what a table on the engine reads has moved:
 * the replica's committed rev, its staged edits or its artifacts. The
 * returned function unsubscribes.
 */
export function onTablesMoved(listener: () => void): () => void {
	_tablesListeners.add(listener);
	return () => {
		_tablesListeners.delete(listener);
	};
}

/**
 * With the tables on the engine, a `changed` whose `rev`, `staged_version`
 * or `artifacts_version` moved tells the `onTablesMoved` listeners; one heard
 * while the tables are the server's is not remembered, so the first after
 * they come to the engine tells them. On the server a staged change moves no
 * table; the commit feed re-pages those.
 */
function followTables(sync: ReplicaSync): void {
	stopFollowingTables();
	_tablesSeen = null;
	_offTablesChanged = sync.on('changed', (event) => {
		if (engineSide('tables') !== 'engine') return;
		const at = `${event.rev}:${event.staged_version}:${event.artifacts_version}`;
		if (at === _tablesSeen) return;
		_tablesSeen = at;
		tablesMoved();
	});
}

/** Tells the `onTablesMoved` listeners, while the tables are on the engine. */
function tablesMoved(): void {
	if (engineSide('tables') !== 'engine') return;
	for (const listener of [..._tablesListeners]) listener();
}

function stopFollowingTables(): void {
	_offTablesChanged?.();
	_offTablesChanged = null;
}

/**
 * A follower for `projectId`, unless one follows it already. Its fetches are
 * scoped to that project whatever project is active by the time they go.
 */
function follow(sync: ReplicaSync, projectId: string): void {
	if (_follower?.projectId === projectId) return;
	stopFollower();
	const cfg = { baseUrl: `/api/v1/projects/${projectId}` };
	const follower = createArtifactFollower({
		sync,
		payloads: (ids) => listArtifactPayloads(ids, cfg),
		staged: stagedArtifactsForEngine,
		parser: createRulesParser((yaml) => parseRules(yaml, cfg)),
		pause: () => new Promise<void>((resolve) => setTimeout(resolve, LOAD_RETRY_MS)),
		// The issues and tables gates open here too: the server's list and pages,
		// answered until now, hold none of the staged edits.
		onLoaded: () => {
			if (issuesOnEngine(_status)) scheduleIssuesRefetch();
			tablesMoved();
		}
	});
	// A shadow re-test waits out a payload fetch or a rules parse in flight, which may change what it reads.
	_follower = { projectId, follower, removeQuiet: addQuietProbe(() => follower.settled()) };
	follower.load();
	// The sync forgot the buffer at its last stop; the project's own, kept since, goes again.
	if (getStagedArtifactDepth() > 0) follower.stagedChanged();
}

/** The kind of the committed artifact `id` as the current follower knows it; none without one. */
export function artifactKindOf(id: string): string | undefined {
	return _follower?.follower.kindOf(id);
}

/** A payload answer after this is dropped: it speaks for a replica no longer followed. */
function stopFollower(): void {
	_follower?.follower.stop();
	_follower?.removeQuiet();
	_follower = null;
}

/** Every read goes to the server again; the sync forgets the placements, the engine half everything. */
export function stopReplica(): void {
	uninstallSeam();
	stopFollowingIssues();
	stopFollowingTables();
	detachEngine();
	_placedViews.clear();
	stopFollower();
	_sync?.stop();
	_releaseGate();
}

/**
 * Resolves at once when no surface is on the engine — nothing to wait for;
 * otherwise once the phase is no longer `opening` (`ready`, `server`,
 * `off`, `failed` or `frozen` all answer as they are), or on `stopReplica()`.
 * `boot()` awaits it after its own loads, so the overlay's `finishJourney()`
 * comes after the replica, not before it.
 */
export function replicaGate(): Promise<void> {
	if (!_anyEngine()) return Promise.resolve();
	if (_status.phase !== 'opening') return Promise.resolve();
	return new Promise<void>((resolve) => {
		_gateWaiters.push(resolve);
	});
}

/** A dismissible warning: the engine could not start, so this tab reads from the server. */
export function getReplicaNotice(): boolean {
	return _anyEngine() && _status.phase === 'server' && !_noticeDismissed;
}

export function dismissReplicaNotice(): void {
	_noticeDismissed = true;
}

/** Whether the workspace is blocked: the replica cannot be rebuilt, or a retry of that is running. */
export function isReplicaBlocked(): boolean {
	return (
		_anyEngine() && (_status.phase === 'failed' || (_retrying && _status.phase === 'resyncing'))
	);
}

export function isReplicaRetrying(): boolean {
	return _retrying;
}

/** An in-place re-bootstrap that adopts the batches the sync still holds; a no-op unless `failed`. */
export function retryReplica(): void {
	if (_status.phase !== 'failed') return;
	_retrying = true;
	_sync?.retry();
}

/**
 * Called first for every feed event. A commit is handed over only with the
 * frame's own text: a re-serialized event would have lost what the replica's
 * digest sees (`1.0`, integers past 2^53). A snapshot event, sent at every
 * (re)connect, loads the artifacts again: an event missed meanwhile is healed.
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
			_follower?.follower.load();
			break;
		case 'reset':
			sync.feedReset(event.model_rev);
			break;
		case 'artifact':
			_follower?.follower.onEvent(event.action, event.artifact);
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

/**
 * A commit is in flight, or the answer of one the user landed waits for the
 * replica to apply it (the sync's `ownPending()`); false without a sync.
 */
export function replicaOwnPending(): boolean {
	return _sync?.ownPending?.() ?? false;
}

/** Resolves once the replica has taken in everything it was handed (the sync's `settled()`); at once without a sync. */
export function replicaSettled(): Promise<void> {
	return _sync?.settled() ?? Promise.resolve();
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
	stopFollowingIssues();
	stopFollowingTables();
	detachEngine();
	_switches = null;
	_placedViews.clear();
	stopFollower();
	sync?.stop();
	setStatus(OFF);
	_noticeDismissed = false;
	_retrying = false;
	_offSinceReady = false;
	_releaseGate();
}
