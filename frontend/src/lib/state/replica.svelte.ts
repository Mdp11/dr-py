/**
 * The tab's replica: one `ReplicaSync` (lib/engine/sync.ts), its status as
 * state. The workspace page starts and stops it, the feed hands it commit,
 * rebind, snapshot and reset events, the two commit paths bracket their POST
 * with a flight, the two metamodel-adoption paths tell it the UI moved on,
 * and the view store registers what the committed view places. While it
 * runs, the engine seam is installed: every read is answered by the replica,
 * once its gate is open (`whenReady`), and the model store's engine half
 * follows it through a handle (`attachEngine`). An artifact follower keeps
 * the project's artifacts, committed and staged, in the sync's context, each
 * staged rule set with the server's parse of its YAML. The live issue list
 * is refetched whenever the replica's issue store moves, the open tables
 * re-page whenever what they read moves, and the view store recomputes the
 * active view's warnings the same way.
 */

import type { WireBatch } from '$engine';
import { listArtifactPayloads } from '$lib/api/artifacts';
import { installEngineSeam } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import { parseRules } from '$lib/api/rules';
import { createArtifactFollower, type ArtifactFollower } from '$lib/engine/artifacts';
import { createSnapshotCache } from '$lib/engine/cache';
import { connectFrame } from '$lib/engine/frame';
import { createGate, type GateState } from '$lib/engine/gate';
import { createRulesParser } from '$lib/engine/rules-parse';
import { createEngineSeam } from '$lib/engine/seam';
import { anyStaged } from '$lib/engine/staged-probe';
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
/** Where the working copy stood at the last `changed` of the current link; null before the first one. */
let _stamp = $state.raw<WorkingStamp | null>(null);
/** Moves whenever the status leaves `ready`, a link starts or the replica stops: what a call began on no longer holds. */
let _linkGeneration = 0;
/** Unsubscribes the stamp from the sync's `changed` events. */
let _offStamp: (() => void) | null = null;
let _deps: Partial<SyncDeps> | undefined;
/** The sync the installed seam reads from; null while none is installed. */
let _seamSync: ReplicaSync | null = null;
/** `replicaGate()` waiters, released once the phase leaves `opening`. */
let _gateWaiters: Array<() => void> = [];
/** The views whose placements were handed to the sync; the sync keeps the lists. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _placedViews = new Set<string>();
/** Set by `retryReplica()`, cleared once the retry lands at `ready`, `failed`, `off` or `unavailable`. */
let _retrying = $state(false);
/** A Retry of the artifacts' load is running; apart from `_retrying`, which is a re-bootstrap's. */
let _loadRetrying = $state(false);
/** Why the follower's first artifact load failed, retry included; null while it has not, or has landed. */
let _loadFailure = $state<string | null>(null);
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _statusListeners = new Set<StatusListener>();
/** Unsubscribes the issues refetch from the sync's `changed` events. */
let _offChanged: (() => void) | null = null;
/** Unsubscribes the tables' re-page from the sync's `changed` events. */
let _offTablesChanged: (() => void) | null = null;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _tablesListeners = new Set<() => void>();
/** The last `changed` tuple the tables followed. */
let _tablesSeen: string | null = null;
/** Unsubscribes the view warnings' recompute from the sync's `changed` events. */
let _offViewsChanged: (() => void) | null = null;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _viewsListeners = new Set<() => void>();
/** The last `changed` tuple the view warnings followed. */
let _viewsSeen: string | null = null;
/** The sync reported `off` since its last `ready`: the tables asked meanwhile were refused. */
let _offSinceReady = false;
/** The started replica's artifact follower and the project it follows. */
let _follower: { projectId: string; follower: ArtifactFollower } | null = null;

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
			const issuesWereOpen = issuesOpen(_status);
			const viewsWereOpen = viewsOpen(_status);
			setStatus(status);
			// The live list and the view warnings follow the replica once its first sweep ends.
			if (!issuesWereOpen && issuesOpen(status)) scheduleIssuesRefetch();
			if (!viewsWereOpen && viewsOpen(status)) viewsMoved();
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
				// table asked meanwhile was refused. Its versions start over, so no
				// last tuple seen still holds.
				if (previousPhase === 'resyncing' || (previousPhase === 'opening' && _offSinceReady)) {
					_tablesSeen = null;
					_viewsSeen = null;
					tablesMoved();
				}
				_offSinceReady = false;
			}
			if (
				_retrying &&
				(status.phase === 'ready' ||
					status.phase === 'failed' ||
					status.phase === 'off' ||
					status.phase === 'unavailable')
			) {
				_retrying = false;
			}
			_releaseUnblocked();
		}
	});
	return made;
}

/** Every status change goes through here, so each listener hears it with the one before. */
function setStatus(status: ReplicaStatus): void {
	const previous = _status;
	if (status === previous) return;
	_status = status;
	// The staged version restarts with each worker: no stamp outlives its link.
	if (status.phase !== 'ready') {
		_stamp = null;
		_linkGeneration++;
	}
	_gate.moved();
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

/** The committed rev and staged version of the engine's working copy. */
export type WorkingStamp = { rev: number; staged: number };

/** The working copy's stamp, or null when no `changed` of the current link has been heard. */
export function getWorkingStamp(): WorkingStamp | null {
	return _stamp;
}

/** The link generation: read before a call, handed to `adoptWorkingStamp` with its answer. */
export function getLinkGeneration(): number {
	return _linkGeneration;
}

/**
 * Takes a run's stamp as the working stamp when none is known and the link the
 * run began on still stands (`generation`, read before the call): a replica
 * built again posts no `changed` for what it holds, and a later change moves it.
 */
export function adoptWorkingStamp(stamp: WorkingStamp, generation: number = _linkGeneration): void {
	if (_stamp === null && generation === _linkGeneration) {
		_stamp = { rev: stamp.rev, staged: stamp.staged };
	}
}

/** Whether there is no engine to run scripts on: the replica is off or unavailable. Reactive. */
export function scriptsNeedEngine(): boolean {
	return _status.phase === 'off' || _status.phase === 'unavailable';
}

/** One call to the engine; a cancelled `signal` rejects it locally. */
export function callEngine<T>(method: string, params?: unknown, options?: CallOptions): Promise<T> {
	if (_sync === null) return Promise.reject(new Error('the engine is not running'));
	return _sync.call<T>(method, params, options);
}

function followStamp(sync: ReplicaSync): void {
	_offStamp?.();
	_stamp = null;
	_linkGeneration++;
	_offStamp = sync.on('changed', (event) => {
		const current = _stamp;
		if (current?.rev === event.rev && current.staged === event.staged_version) return;
		_stamp = { rev: event.rev, staged: event.staged_version };
	});
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
 * Whether the live issue list follows the replica at `status`: it holds a
 * model and its first sweep has ended.
 */
function issuesOpen(status: ReplicaStatus): boolean {
	return holdsModel(status) && status.seeded;
}

/** Whether the view warnings follow the replica at `status`: the issues' gate is open and the artifacts are loaded. */
function viewsOpen(status: ReplicaStatus): boolean {
	return issuesOpen(status) && (_follower?.follower.loaded() ?? false);
}

/** `failed` and `frozen` keep their replica: the sync holds the batches staged there across a re-bootstrap. */
function holdsModel(status: ReplicaStatus): boolean {
	return status.phase !== 'off' && status.phase !== 'unavailable';
}

/**
 * Routes every read through `sync`, which answers once the gate is open: the
 * replica is ready, its issue store swept whole and the artifacts loaded
 * (until then the engine holds none of the rule sets and tables a read may
 * name).
 */
function installSeam(sync: ReplicaSync): void {
	uninstallSeam();
	_seamSync = sync;
	installEngineSeam(createEngineSeam(sync, (signal) => _gate.whenReady(signal)));
	_gate.moved();
}

function uninstallSeam(): void {
	_seamSync = null;
	installEngineSeam(null);
	_gate.moved();
}

/**
 * Whether a read can be answered now: a replica is installed, ready or
 * frozen, its issue store swept whole and the artifacts loaded. `closed`
 * while it opens or re-bootstraps; `unavailable` once it has failed, has no
 * model, could not start, or is not installed. A `frozen` replica keeps
 * `seeded`: its list matches the old-metamodel UI until the adoption
 * re-bootstraps it.
 */
function gateState(): GateState {
	if (_seamSync === null) return { state: 'unavailable', reason: 'the engine is not running' };
	const { phase, seeded, reason } = _seamSync.status();
	switch (phase) {
		case 'opening':
		case 'resyncing':
			return { state: 'closed' };
		case 'ready':
		case 'frozen':
			if (_follower?.follower.loadFailed() ?? false) {
				return {
					state: 'unavailable',
					reason: `the artifacts could not be loaded: ${_loadFailure ?? 'the fetch failed'}`
				};
			}
			return seeded && (_follower?.follower.loaded() ?? false)
				? { state: 'open' }
				: { state: 'closed' };
		case 'off':
			return { state: 'unavailable', reason: reason ?? 'the engine has no replica' };
		case 'failed':
		case 'unavailable':
			return { state: 'unavailable', reason: reason ?? 'the replica cannot be rebuilt' };
	}
}

const _gate = createGate(gateState);

/** The replica's status; reactive. */
export function getReplicaStatus(): ReplicaStatus {
	return _status;
}

/**
 * Opens the active project's replica and installs the seam; the model
 * store's engine half follows it. Nothing without an active project.
 */
export function startReplica(): void {
	const projectId = getActiveProjectId();
	if (!projectId) return;
	const sync = (_sync ??= build(_deps));
	installSeam(sync);
	attachEngine(engineHandle(sync));
	followStamp(sync);
	followIssues(sync);
	followTables(sync);
	followViews(sync);
	sync.open(projectId);
	// Before the follower mirrors the buffer: one staged in another project is dropped.
	bindStagedArtifacts(projectId);
	follow(sync, projectId);
}

/**
 * A `changed` whose `issues_version` moved refetches the live list. The version is per worker, so a new worker's
 * first may repeat an old one; the gate opening after its sweep refetches.
 */
function followIssues(sync: ReplicaSync): void {
	stopFollowingIssues();
	let seen: number | null = null;
	_offChanged = sync.on('changed', (event) => {
		if (event.issues_version === seen) return;
		seen = event.issues_version;
		if (issuesOpen(_status)) scheduleIssuesRefetch();
	});
}

function stopFollowingIssues(): void {
	_offChanged?.();
	_offChanged = null;
}

/**
 * `listener` is called whenever what an open table reads has moved:
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
 * A `changed` whose `rev`, `staged_version` or `artifacts_version` moved
 * tells the `onTablesMoved` listeners.
 */
function followTables(sync: ReplicaSync): void {
	stopFollowingTables();
	_tablesSeen = null;
	_offTablesChanged = sync.on('changed', (event) => {
		const at = `${event.rev}:${event.staged_version}:${event.artifacts_version}`;
		if (at === _tablesSeen) return;
		_tablesSeen = at;
		tablesMoved();
	});
}

/** Tells the `onTablesMoved` listeners. */
function tablesMoved(): void {
	for (const listener of [..._tablesListeners]) listener();
}

function stopFollowingTables(): void {
	_offTablesChanged?.();
	_offTablesChanged = null;
}

/**
 * `listener` is called whenever what the view warnings read have moved: the replica's committed rev, its staged edits or its
 * artifacts, or the gate opening on them. The returned function unsubscribes.
 */
export function onViewsMoved(listener: () => void): () => void {
	_viewsListeners.add(listener);
	return () => {
		_viewsListeners.delete(listener);
	};
}

/**
 * A `changed` whose `rev`, `staged_version` or `artifacts_version` moved
 * tells the `onViewsMoved` listeners.
 */
function followViews(sync: ReplicaSync): void {
	stopFollowingViews();
	_viewsSeen = null;
	_offViewsChanged = sync.on('changed', (event) => {
		const at = `${event.rev}:${event.staged_version}:${event.artifacts_version}`;
		if (at === _viewsSeen) return;
		_viewsSeen = at;
		viewsMoved();
	});
}

/** Tells the `onViewsMoved` listeners. */
function viewsMoved(): void {
	for (const listener of [..._viewsListeners]) listener();
}

function stopFollowingViews(): void {
	_offViewsChanged?.();
	_offViewsChanged = null;
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
		// Reads would wait for artifacts that are not coming: the gate rejects them
		// and the workspace blocks, its Retry loading them again.
		onLoadFailed: (error) => {
			_loadFailure = error instanceof Error ? error.message : String(error);
			_loadRetrying = false;
			_gate.moved();
		},
		// The issues, tables and views follow the artifacts too.
		onLoaded: () => {
			_loadFailure = null;
			_loadRetrying = false;
			_gate.moved();
			_releaseUnblocked();
			if (issuesOpen(_status)) scheduleIssuesRefetch();
			tablesMoved();
			viewsMoved();
		}
	});
	_follower = { projectId, follower };
	follower.load();
	// The sync forgot the buffer at its last stop; the project's own, kept since, goes again.
	if (getStagedArtifactDepth() > 0) follower.stagedChanged();
}

/** A payload answer after this is dropped: it speaks for a replica no longer followed. */
function stopFollower(): void {
	if (_follower === null) return;
	_follower.follower.stop();
	_follower = null;
	_loadFailure = null;
	_loadRetrying = false;
	_gate.moved();
	_releaseUnblocked();
}

/**
 * Whether an export now would hold staged edits: the replica holds staged
 * model edits or staged artifacts, and an export reads the working copy. The
 * manifest's `model_rev` stays the committed rev. Reactive.
 */
export function exportsIncludeStaged(): boolean {
	return anyStaged() || getStagedArtifactDepth() > 0;
}

/**
 * Whether a metamodel preview now would hold staged edits: the replica holds
 * staged model edits or staged artifacts, and a preview reads the working
 * copy. Reactive.
 */
export function metamodelIncludesStaged(): boolean {
	return anyStaged() || getStagedArtifactDepth() > 0;
}

/** Every read is unavailable again; the sync forgets the placements, the engine half everything. */
export function stopReplica(): void {
	uninstallSeam();
	_offStamp?.();
	_offStamp = null;
	_stamp = null;
	_linkGeneration++;
	stopFollowingIssues();
	stopFollowingTables();
	stopFollowingViews();
	detachEngine();
	_placedViews.clear();
	// The page is going: a refresh now would post placements to a replica no longer followed.
	stopFollower();
	_sync?.stop();
	_releaseGate();
	_releaseUnblocked();
}

/**
 * Resolves once the phase is no longer `opening` (`ready`, `unavailable`,
 * `off`, `failed` or `frozen` all answer as they are), or on `stopReplica()`.
 * `boot()` awaits it after its own loads, so the overlay's `finishJourney()`
 * comes after the replica, not before it.
 */
export function replicaGate(): Promise<void> {
	if (_status.phase !== 'opening') return Promise.resolve();
	return new Promise<void>((resolve) => {
		_gateWaiters.push(resolve);
	});
}

/**
 * Whether the workspace is blocked: the replica cannot be rebuilt or could
 * not start, the artifacts could not be loaded, or a retry of either is
 * running. A project with no model (`off`) is not blocked.
 */
export function isReplicaBlocked(): boolean {
	return (
		_status.phase === 'failed' ||
		_status.phase === 'unavailable' ||
		_loadFailure !== null ||
		(_retrying && (_status.phase === 'resyncing' || _status.phase === 'opening'))
	);
}

/** `whenReplicaUnblocked()` waiters, released once the workspace is no longer blocked. */
let _unblockWaiters: Array<() => void> = [];

function _releaseUnblocked(): void {
	if (_unblockWaiters.length === 0 || isReplicaBlocked()) return;
	const waiters = _unblockWaiters;
	_unblockWaiters = [];
	for (const resolve of waiters) resolve();
}

/**
 * Resolves once the workspace is not blocked (at once when it is not): a
 * Retry landed, or the replica stopped. The page uses it to finish the boot
 * steps a blocked open skipped.
 */
export function whenReplicaUnblocked(): Promise<void> {
	if (!isReplicaBlocked()) return Promise.resolve();
	return new Promise<void>((resolve) => _unblockWaiters.push(resolve));
}

/** Why the workspace is blocked, when it is. */
export function getReplicaBlockReason(): string | null {
	if (_status.phase === 'failed' || _status.phase === 'unavailable') return _status.reason;
	return _loadFailure === null ? null : `The artifacts could not be loaded: ${_loadFailure}`;
}

export function isReplicaRetrying(): boolean {
	return _retrying || _loadRetrying;
}

/**
 * An in-place re-bootstrap that adopts the batches the sync still holds, when
 * `failed`; a fresh connect, when `unavailable`; else, when the artifacts
 * could not be loaded, a new load of them. A no-op otherwise.
 */
export function retryReplica(): void {
	if (_status.phase === 'failed' || _status.phase === 'unavailable') {
		_retrying = true;
		_sync?.retry();
		return;
	}
	if (_loadFailure !== null && _follower !== null) {
		_loadRetrying = true;
		_follower.follower.load();
		// A load asked again is waited for, not refused, until it fails once more.
		_gate.moved();
	}
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
	_offStamp?.();
	_offStamp = null;
	_stamp = null;
	_linkGeneration++;
	stopFollowingIssues();
	stopFollowingTables();
	stopFollowingViews();
	detachEngine();
	_placedViews.clear();
	stopFollower();
	sync?.stop();
	setStatus(OFF);
	_retrying = false;
	_loadFailure = null;
	_offSinceReady = false;
	_releaseGate();
	_releaseUnblocked();
}
