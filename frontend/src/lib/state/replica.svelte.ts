/**
 * The tab's replica: one `ReplicaSync` (lib/engine/sync.ts), its status as
 * state. The workspace page starts and stops it, the feed hands it commit,
 * rebind, snapshot and reset events, the two commit paths bracket their POST
 * with a flight, the two metamodel-adoption paths tell it the UI moved on,
 * and the view store registers what the committed view places. While it
 * runs, the engine seam is installed: every read is answered by the replica,
 * once its gate is open (`whenReady`); with staging on the engine, the model
 * store's engine half follows it through a handle (`attachEngine`). An
 * artifact follower keeps the project's
 * artifacts, committed and staged, in the sync's context, each staged rule
 * set with the server's parse of its YAML. With the issues on
 * the engine, the live issue list is refetched whenever the replica's issue
 * store moves; with the tables on the engine, the open tables re-page
 * whenever what they read moves, and with the views on the engine, the view
 * store recomputes the active view's warnings whenever what they read moves.
 */

import type { WireBatch } from '$engine';
import { listArtifactPayloads } from '$lib/api/artifacts';
import { installEngineSeam, type Side, type Surface } from '$lib/api/engine-route';
import type { FeedEvent } from '$lib/api/feed';
import { parseRules } from '$lib/api/rules';
import { createArtifactFollower, type ArtifactFollower } from '$lib/engine/artifacts';
import { createSnapshotCache } from '$lib/engine/cache';
import { connectFrame } from '$lib/engine/frame';
import { createGate, type GateState } from '$lib/engine/gate';
import { addQuietProbe } from '$lib/engine/quiet';
import { createRulesParser } from '$lib/engine/rules-parse';
import { createEngineSeam } from '$lib/engine/seam';
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
/** Where the working copy stood at the last `changed` of the current link; null before the first one. */
let _stamp = $state.raw<WorkingStamp | null>(null);
/** Moves whenever the status leaves `ready`, a link starts or the replica stops: what a call began on no longer holds. */
let _linkGeneration = 0;
/** Unsubscribes the stamp from the sync's `changed` events. */
let _offStamp: (() => void) | null = null;
let _deps: Partial<SyncDeps> | undefined;
/** The switches, read at the first start and kept until `resetReplica()`; tracked so a `$derived` reading it stays live. */
let _switches = $state.raw<Switches | null>(null);
/** The sync the installed seam reads from; null while none is installed. */
let _seamSync: ReplicaSync | null = null;
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
/** The last `changed` tuple the tables followed, on the engine side. */
let _tablesSeen: string | null = null;
/** Unsubscribes the view warnings' recompute from the sync's `changed` events. */
let _offViewsChanged: (() => void) | null = null;
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _viewsListeners = new Set<() => void>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _viewsClosedListeners = new Set<() => void>();
/** The last `changed` tuple the view warnings followed, on the engine side. */
let _viewsSeen: string | null = null;
/** The sync reported `off` since its last `ready`: the tables went to the server meanwhile. */
let _offSinceReady = false;
/** Moves whenever a follower's artifacts land or it stops: what the seam's artifact gates read is tracked through it. */
let _followerEpoch = $state(0);
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
			const viewsWereOpen = viewsOnEngine(_status);
			setStatus(status);
			// The live list was the server's until now: the engine's replaces it.
			if (!issuesWereOpen && issuesOnEngine(status)) scheduleIssuesRefetch();
			// So were the view warnings, over the committed view.
			if (!viewsWereOpen && viewsOnEngine(status)) viewsMoved();
			// And back to the server's when the gate shuts.
			if (viewsWereOpen && !viewsOnEngine(status)) viewsClosed();
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
				// Its versions start over, so no last tuple seen still holds.
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

/** Whether there is no engine to run scripts on: the replica is off or the server serves. Reactive. */
export function scriptsNeedEngine(): boolean {
	return _status.phase === 'off' || _status.phase === 'server';
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

/** Whether the view warnings are the engine's at `status`: their switch says so and the issues' gate is open. */
function viewsOnEngine(status: ReplicaStatus): boolean {
	return (
		_switches !== null &&
		_switches.surfaces.views === 'engine' &&
		stagingOnEngine(status) &&
		status.seeded &&
		(_follower?.follower.loaded() ?? false)
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
 * Routes every read through `sync`, which answers once the gate is open: the
 * replica is ready, its issue store swept whole and the artifacts loaded
 * (until then the engine holds none of the rule sets and tables a read may
 * name). The `dr.surfaces` switches only decide what `engineSide` reports to
 * the stores that follow the replica.
 */
function installSeam(sync: ReplicaSync): void {
	uninstallSeam();
	_switches ??= readSwitches();
	_seamSync = sync;
	installEngineSeam(createEngineSeam(sync, (signal) => _gate.whenReady(signal)));
	_removeQuietProbe = addQuietProbe(() => sync.settled());
	_gate.moved();
}

function uninstallSeam(): void {
	_seamSync = null;
	installEngineSeam(null);
	_removeQuietProbe?.();
	_removeQuietProbe = null;
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
		case 'server':
			return { state: 'unavailable', reason: reason ?? 'the replica cannot be rebuilt' };
	}
}

const _gate = createGate(gateState);

/**
 * The side a surface's stores follow: the engine when its switch says so, its
 * gate (if any) is open and a replica is neither `off` nor `server`. Reads
 * answer from the engine whatever this says; it decides who re-pages and
 * recomputes when the replica moves.
 */
export function engineSide(surface: Surface): Side {
	if (_seamSync === null || _switches === null) return 'server';
	if (_switches.surfaces[surface] !== 'engine') return 'server';
	if (surfaceGate(_seamSync, surface) === false) return 'server';
	const { phase } = _seamSync.status();
	return phase === 'off' || phase === 'server' ? 'server' : 'engine';
}

/** Surfaces whose reads may name artifacts: a navigation, a table by its own id or through its navigations, an export through its tables or its exporter. */
const NAMES_ARTIFACTS: ReadonlySet<Surface> = new Set(['navigation', 'tables', 'exports']);

/**
 * Surfaces answered from the issue store or the working copy: a candidate
 * metamodel is diffed against the issues' list, a view's warnings name the
 * artifacts it places, and a compare diffs the working copy, which only
 * staging on the engine holds.
 */
const NEEDS_SWEPT_STORE: ReadonlySet<Surface> = new Set([
	'issues',
	'metamodel',
	'views',
	'compare'
]);

/** The extra gate of `surface`, if it has one: what its reads need the replica to hold. */
function surfaceGate(sync: ReplicaSync, surface: Surface): boolean | undefined {
	const loaded = _follower?.follower.loaded() ?? false;
	if (NAMES_ARTIFACTS.has(surface)) return loaded;
	// A store swept part-way is not the model's list, and until the artifacts
	// are held the engine knows none of the rule sets its list must carry.
	if (NEEDS_SWEPT_STORE.has(surface)) {
		return getStagingSide() === 'engine' && sync.status().seeded && loaded;
	}
	return undefined;
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
 * `listener` is called whenever what the view warnings on the engine read
 * have moved: the replica's committed rev, its staged edits or its
 * artifacts, or the gate opening on them. The returned function unsubscribes.
 */
export function onViewsMoved(listener: () => void): () => void {
	_viewsListeners.add(listener);
	return () => {
		_viewsListeners.delete(listener);
	};
}

/**
 * With the view warnings on the engine, a `changed` whose `rev`,
 * `staged_version` or `artifacts_version` moved tells the `onViewsMoved`
 * listeners; one heard while they are the server's is not remembered.
 */
function followViews(sync: ReplicaSync): void {
	stopFollowingViews();
	_viewsSeen = null;
	_offViewsChanged = sync.on('changed', (event) => {
		if (engineSide('views') !== 'engine') return;
		const at = `${event.rev}:${event.staged_version}:${event.artifacts_version}`;
		if (at === _viewsSeen) return;
		_viewsSeen = at;
		viewsMoved();
	});
}

/**
 * `listener` is called when the views gate shuts (a resync, the follower
 * stopping): the view warnings on the engine are no longer backed by
 * anything, and the server's take their place. The returned function
 * unsubscribes.
 */
export function onViewsClosed(listener: () => void): () => void {
	_viewsClosedListeners.add(listener);
	return () => {
		_viewsClosedListeners.delete(listener);
	};
}

function viewsClosed(): void {
	for (const listener of [..._viewsClosedListeners]) listener();
}

/** Tells the `onViewsMoved` listeners, while the view warnings are on the engine. */
function viewsMoved(): void {
	if (engineSide('views') !== 'engine') return;
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
			_retrying = false;
			_gate.moved();
		},
		// The issues, tables and views gates open here too: the server's list,
		// pages and warnings, answered until now, hold none of the staged edits.
		onLoaded: () => {
			_loadFailure = null;
			_retrying = false;
			_followerEpoch += 1;
			_gate.moved();
			if (issuesOnEngine(_status)) scheduleIssuesRefetch();
			tablesMoved();
			viewsMoved();
		}
	});
	// `quiet()` waits out a payload fetch or a rules parse in flight, which may change what a read sees.
	_follower = { projectId, follower, removeQuiet: addQuietProbe(() => follower.settled()) };
	follower.load();
	// The sync forgot the buffer at its last stop; the project's own, kept since, goes again.
	if (getStagedArtifactDepth() > 0) follower.stagedChanged();
}

/** A payload answer after this is dropped: it speaks for a replica no longer followed. */
function stopFollower(notify = true): void {
	if (_follower === null) return;
	const viewsWereOpen = viewsOnEngine(_status);
	_follower.follower.stop();
	_follower.removeQuiet();
	_follower = null;
	_loadFailure = null;
	_followerEpoch += 1;
	_gate.moved();
	if (notify && viewsWereOpen) viewsClosed();
}

/**
 * Whether compare and apply-CR read the engine now, before any answer says
 * which side gave it. Reactive.
 */
export function compareOnEngine(): boolean {
	void _status;
	void _followerEpoch;
	return engineSide('compare') === 'engine';
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
	stopFollower(false);
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

/**
 * Whether the workspace is blocked: the replica cannot be rebuilt, the
 * artifacts could not be loaded, or a retry of either is running.
 */
export function isReplicaBlocked(): boolean {
	return (
		_anyEngine() &&
		(_status.phase === 'failed' ||
			_loadFailure !== null ||
			(_retrying && _status.phase === 'resyncing'))
	);
}

/** Why the workspace is blocked, when it is. */
export function getReplicaBlockReason(): string | null {
	if (_status.phase === 'failed') return _status.reason;
	return _loadFailure === null ? null : `The artifacts could not be loaded: ${_loadFailure}`;
}

export function isReplicaRetrying(): boolean {
	return _retrying;
}

/**
 * An in-place re-bootstrap that adopts the batches the sync still holds, when
 * `failed`; else, when the artifacts could not be loaded, a new load of them.
 * A no-op otherwise.
 */
export function retryReplica(): void {
	if (_status.phase === 'failed') {
		_retrying = true;
		_sync?.retry();
		return;
	}
	if (_loadFailure !== null && _follower !== null) {
		_retrying = true;
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
	_switches = null;
	_placedViews.clear();
	stopFollower();
	sync?.stop();
	setStatus(OFF);
	_noticeDismissed = false;
	_retrying = false;
	_loadFailure = null;
	_offSinceReady = false;
	_releaseGate();
}
