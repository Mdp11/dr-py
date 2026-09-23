import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { Element, OpsResponse, Relationship, TreeItem } from '$lib/api/types';
import type { ChangedEvent, ReplicaStatus, ReplicaSync } from '$lib/engine/sync';
import { getElement } from '../api/elements';
import { NotFoundError } from '../api/errors';
import { EngineGoneError } from '../engine/client';
import { setStagedProbe } from '../engine/staged-probe';
import * as modelReadApi from '../api/model-read';
import { mergePatch } from './apply';
import { computeDiff, type Diff } from './diff';
import { remapVisitIds } from './inspection-history.svelte';
import { remapCaches } from './model-caches';
import {
	applyDeltaShared,
	bumpStructureRev,
	getModelRev,
	setModelError,
	setModelRev
} from './model-shared.svelte';
import type { ModelOp } from './ops';
import { nameProp } from '$lib/util/element-name';
import { getSelection, select } from './selection.svelte';

/**
 * Engine entity half of the staged-commit model store: a view over the
 * replica. The user's staged edits live in the replica's working copy, and
 * every read of this half is answered by the replica through the `lib/api`
 * seam, so what it caches is the committed model WITH the staged edits on
 * top — a temp id is an id like any other, and nothing a read returns can
 * resurrect a staged delete. The caches hold only what the UI asked for.
 *
 * An edit (`emit`, `emitMany`) is written into the caches at once, so the
 * field under the caret keeps its text, and posted to the engine as a
 * `stage`. While it is in flight its entity is PENDING: nothing the engine
 * says overwrites it but the answer that brings its pending count back to
 * zero, so an answer never regresses a newer edit. A refused stage puts its
 * entities back as the engine has them.
 *
 * The replica says what moved through its `changed` event, the one path that
 * refreshes the caches after a transition: deleted ids leave them, cached
 * changed elements are read again, a structural change moves the structure
 * rev, and a staged list that moved is read again into the mirror (`staged`,
 * `conflicts`, `stagedDiff` as the engine last answered them). The
 * synchronous staged-edit readers read the mirror and, after it, the
 * PROVISIONAL edits: those posted and not yet covered by a mirror read.
 *
 * A commit of the user's names the batches it carried; once it has landed
 * they are COMMITTED, and leave the readers at once, though the replica holds
 * them until it applies the commit's answer — a `frozen` or `failed` replica
 * only once it is rebuilt. An edit the engine would merge into one of them
 * waits, DEFERRED, until the replica has dropped it.
 *
 * The replica store injects the engine (`attachEngine`) and takes it back
 * (`detachEngine`); detached, this half holds nothing.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type StatusListener = (status: ReplicaStatus, previous: ReplicaStatus) => void;

/** What the replica store hands this half: its sync's calls and events, and its status. */
export type EngineHandle = {
	call: ReplicaSync['call'];
	on: ReplicaSync['on'];
	/** The replica store's status. */
	status(): ReplicaStatus;
	subscribe(listener: StatusListener): () => void;
};

/** One of the engine's staged batches, its ops as `lib/state/ops.ts` types them. */
export type StagedBatch = { id: number; ops: ModelOp[] };

/** A staged batch that no longer applies, with the engine's refusal. */
export type StagedConflict = { batch: StagedBatch; error: { status: number; detail: string } };

/** The engine's `stagedDiff`: each entity a staged batch touched, committed image and record now. */
type StagedDiff = {
	elements: { id: string; before: Element | null; after: Element | null }[];
	relationships: { id: string; before: Relationship | null; after: Relationship | null }[];
};

/**
 * Ops posted to the engine and not yet covered by a mirror read; `answered`
 * is the count of mirror reads issued when the engine answered them, and
 * `batch` the batch the answer put them in. A DEFERRED entry is not posted
 * yet: it waits for the replica to drop a committed batch it would merge into.
 */
type Provisional = {
	seq: number;
	ops: ModelOp[];
	answered: number | null;
	batch: StagedBatch | null;
	deferred: boolean;
	/** The elements its cache write changed. */
	touched: Set<string>;
};

/** The engine's answer to a `stage`: the post-state lists are `null` past 500 entities. */
type StageAnswer = {
	batch: StagedBatch;
	coalesced: boolean;
	elements: Element[] | null;
	relationships: Relationship[] | null;
};

type Unstage = 'all' | { batch: number } | { entity: string; incident?: boolean };

const _elements = new SvelteMap<string, Element>();
const _relationships = new SvelteMap<string, Relationship>();
/** Element ids the engine answered do not exist, a temp id included. */
const _missingElementIds = new SvelteSet<string>();
/** Lite tree rows; a full `_elements` entry wins in `getTreeElements()`. */
const _treeItems = new SvelteMap<string, TreeItem>();
/**
 * Cached elements a staged delete took out of the caches; an unstage that
 * brings one back names it as changed, and it is read again then.
 */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- never read reactively
const _hidden = new Set<string>();
/** Shared by concurrent `ensureElement` calls of one id; never read reactively. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _pendingElementFetches = new Map<string, Promise<Element | null>>();
/** Ids an `ensureElements` / `ensureTreeItems` batch is fetching; never read reactively. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _inFlightBatchIds = new Set<string>();

let _batches = $state.raw<StagedBatch[]>([]);
/**
 * The mirror's batches a commit of the user's carried, until a mirror read no
 * longer holds them: they are committed, so no reader shows them and no
 * commit sends them again, though the replica keeps them staged until it
 * applies the commit's answer — which a `frozen` or `failed` replica does only
 * once it is rebuilt.
 */
let _landed = $state.raw<ReadonlySet<number>>(landedOf([]));
/**
 * Committed batches no replica will hold — the answer of the commit that
 * carried them was dropped, or a worker gone could not be asked — kept out of
 * the readers like `_landed` until the next replica is ready without them: a
 * mirror read of the replica before it may still name them, and one after it
 * may number a new batch alike.
 */
let _abandoned = $state.raw<ReadonlySet<number>>(landedOf([]));
let _parked = $state.raw<StagedConflict[]>([]);
let _diff = $state.raw<StagedDiff | null>(null);
let _provisional = $state.raw<Provisional[]>([]);
/** A value for `_landed` or `_abandoned`, which are replaced whole and never mutated. */
function landedOf(ids: Iterable<number>): ReadonlySet<number> {
	return new Set(ids);
}
/** The deferred provisional entries, in the order they are posted once free. */
let _deferred: Provisional[] = [];
/** Entity id → edits in flight; a re-read never overwrites such an entity. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _pending = new Map<string, number>();

/** A version no working copy has: the mirror's is not known. */
const UNKNOWN_VERSION = -1;
/** The staged version of the last `changed` event. */
let _seenVersion = UNKNOWN_VERSION;
/** The staged version the mirror reflects. */
let _mirrorVersion = UNKNOWN_VERSION;
/** Mirror reads issued. */
let _reads = 0;
let _mirrorReading = false;
let _mirrorOwed = false;
/** The read in flight is the retry of one the engine refused. */
let _mirrorRetry = false;
/**
 * The engine refused a mirror read and its retry: the answered edits stop
 * waiting to be covered — the readers keep showing them — so nothing hangs,
 * but `stagedSettled()` rejects and the unstage family does nothing until a
 * read succeeds, since the mirror is not the engine's staged list.
 */
let _mirrorFailed = false;
/** What the engine said when it refused the mirror read. */
let _mirrorError = '';
/** Cache re-reads in flight. */
let _refreshing = 0;
let _seq = 0;
/** Unstage requests not yet answered, each waiting for the ones before it. */
let _unstaging = 0;
let _unstageChain: Promise<void> = Promise.resolve();
/**
 * Element ids the staged batches touched before a re-bootstrap, read again
 * with those of the first mirror read numbered `_healFrom` or later: the
 * adopted batches may have parked, and adopting says nothing (`changed`).
 */
let _healIds: Set<string> | null = null;
let _healFrom = 0;
let _waiters: { test: () => boolean; resolve: () => void }[] = [];

let _handle: EngineHandle | null = null;
let _unsubscribe: (() => void)[] = [];
/** Moves at every detach and reset: an answer to an older epoch is dropped. */
let _epoch = 0;

// ---------------------------------------------------------------------------
// The engine handle
// ---------------------------------------------------------------------------

/**
 * Follows the engine behind `handle`: its `changed` events and its status.
 * Meanwhile the staged probe (`lib/engine/staged-probe.ts`) asks this half
 * whether anything is staged.
 */
export function attachEngine(handle: EngineHandle): void {
	detachEngine();
	_handle = handle;
	setStagedProbe(replicaHoldsStaged);
	_unsubscribe = [handle.on('changed', onChanged), handle.subscribe(onStatus)];
	const { phase } = handle.status();
	if (phase === 'ready' || phase === 'frozen') readMirror();
}

/** Stops following the engine and drops everything this half holds. */
export function detachEngine(): void {
	for (const off of _unsubscribe.splice(0)) off();
	_handle = null;
	setStagedProbe(null);
	clearAll();
	_landed = landedOf([]);
	_abandoned = landedOf([]);
}

/**
 * The entity half's share of `resetModelStore()`: everything dropped, the
 * mirror read again — but the batches committed that the replica still
 * holds stay out of the readers.
 */
export function resetEngineStore(): void {
	clearAll();
	const handle = _handle;
	if (handle === null) return;
	const { phase } = handle.status();
	if (phase === 'ready' || phase === 'frozen') readMirror();
}

function clearAll(): void {
	_epoch += 1;
	_pendingElementFetches.clear();
	_inFlightBatchIds.clear();
	_missingElementIds.clear();
	_hidden.clear();
	_elements.clear();
	_treeItems.clear();
	_relationships.clear();
	_batches = [];
	_parked = [];
	_diff = null;
	_provisional = [];
	_deferred = [];
	_pending.clear();
	_seenVersion = UNKNOWN_VERSION;
	_mirrorVersion = UNKNOWN_VERSION;
	_mirrorReading = false;
	_mirrorOwed = false;
	_mirrorRetry = false;
	_mirrorFailed = false;
	_mirrorError = '';
	_refreshing = 0;
	_unstaging = 0;
	_unstageChain = Promise.resolve();
	_healIds = null;
	release();
}

function onStatus(status: ReplicaStatus, previous: ReplicaStatus): void {
	if (status.phase !== 'ready' || previous.phase === 'ready') return;
	// A replica ready anew may be another working copy — a re-bootstrap adopts
	// the batches without a `changed` event, and numbers its versions afresh.
	_seenVersion = UNKNOWN_VERSION;
	_healIds = new Set([...(_healIds ?? []), ...mirrorElementIds()]);
	_healFrom = _reads + 1;
	// It adopted none of the abandoned batches: an id alike is a new batch's.
	if (_abandoned.size > 0) _abandoned = landedOf([]);
	readMirror();
}

function isPending(id: string): boolean {
	return (_pending.get(id) ?? 0) > 0;
}

/**
 * Everything the engine said has been taken in, unstage requests aside. A
 * deferred edit does not count: the engine has not been told of it, and it
 * waits for the replica to drop a committed batch — which a `frozen` or
 * `failed` replica does only once it is rebuilt. Only an edit that is not
 * answered holds a pending count, so a posted one is `awaitingAnswer()`.
 */
function isQuiet(): boolean {
	return (
		!_mirrorReading &&
		!_mirrorOwed &&
		_refreshing === 0 &&
		(_provisional.every((entry) => entry.deferred) || (_mirrorFailed && !awaitingAnswer()))
	);
}

function isSettled(): boolean {
	return isQuiet() && _unstaging === 0;
}

function release(): void {
	if (_waiters.length === 0) return;
	const due = _waiters.filter((waiter) => waiter.test());
	if (due.length === 0) return;
	_waiters = _waiters.filter((waiter) => !due.includes(waiter));
	for (const waiter of due) waiter.resolve();
}

function waitFor(test: () => boolean): Promise<void> {
	if (test()) return Promise.resolve();
	return new Promise<void>((resolve) => _waiters.push({ test, resolve }));
}

/** The engine refused to say what is staged: the mirror is not its staged list. */
export class StagedUnreadableError extends Error {
	constructor(detail: string) {
		super(`the staged edits could not be read: ${detail}`);
		this.name = 'StagedUnreadableError';
	}
}

/**
 * Resolves once this half has taken in everything the engine told it — every
 * edit but the deferred ones answered and covered by a mirror read, no mirror
 * read in flight or owed, no cache re-read in flight, no unstage request
 * unanswered — so that `getStagedBatches()` are exactly the engine's staged
 * batches, and `getStagedOps()` those plus the deferred edits. Rejects with {@link StagedUnreadableError} when the engine refused
 * the mirror read (a fresh one is tried first), since the readers then show
 * edits no read has covered.
 */
export function stagedSettled(): Promise<void> {
	if (_mirrorFailed) readMirror();
	return waitFor(isSettled).then(() => {
		if (_mirrorFailed) throw new StagedUnreadableError(_mirrorError);
	});
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

/** Asks for a mirror read. */
function readMirror(): void {
	_mirrorOwed = true;
	pumpMirror();
}

/** An edit still waits for its answer — which reads the mirror when it comes. */
function awaitingAnswer(): boolean {
	return _provisional.some((entry) => entry.answered === null && !entry.deferred);
}

/**
 * Reads `staged`, `conflicts` and `stagedDiff` into the mirror when one is
 * owed, the staged list moved since the last, or an answered edit is not
 * covered yet; one read in flight at a time. A read issued after an edit's
 * answer covers that edit; one issued before may have run ahead of it
 * (`staged` is answered at once), and the `changed` a stage emits comes
 * before its answer — so no read starts while an edit waits for its answer.
 * The three calls go as transitions: posted in arrival order with the
 * stages and never held for a `rev`, so a later stage cannot overtake them.
 * Only in `ready` and `frozen`, where a transition is posted at once; the
 * next `ready` reads what is due.
 */
function pumpMirror(): void {
	const handle = _handle;
	if (handle === null || _mirrorReading) return;
	const due =
		_mirrorOwed ||
		_seenVersion !== _mirrorVersion ||
		(!_mirrorFailed && _provisional.some((entry) => entry.answered !== null));
	if (!due || awaitingAnswer()) {
		release();
		return;
	}
	const { phase } = handle.status();
	if (phase !== 'ready' && phase !== 'frozen') return;
	_mirrorReading = true;
	_mirrorOwed = false;
	_reads += 1;
	const at = _reads;
	const version = _seenVersion;
	const epoch = _epoch;
	const inOrder = { transition: true };
	Promise.all([
		handle.call<StagedBatch[]>('staged', undefined, inOrder),
		handle.call<StagedConflict[]>('conflicts', undefined, inOrder),
		handle.call<StagedDiff>('stagedDiff', undefined, inOrder)
	]).then(
		([batches, parked, diff]) => {
			if (epoch !== _epoch) return;
			_mirrorRetry = false;
			_mirrorFailed = false;
			_batches = batches;
			_parked = parked;
			_diff = diff;
			_mirrorVersion = version;
			_provisional = _provisional.filter(
				(entry) => entry.answered === null || entry.answered >= at
			);
			// A committed batch the replica no longer holds is gone for good.
			if (_landed.size > 0) {
				const held = new Set([
					...batches.map((batch) => batch.id),
					...parked.map((conflict) => conflict.batch.id)
				]);
				_landed = landedOf([..._landed].filter((id) => held.has(id)));
			}
			_mirrorReading = false;
			if (_healIds !== null && at >= _healFrom) heal(_healIds);
			postDeferred();
			pumpMirror();
		},
		(error: unknown) => {
			if (epoch !== _epoch) return;
			_mirrorReading = false;
			if (!(error instanceof EngineGoneError) && !_mirrorRetry) {
				_mirrorRetry = true;
				readMirror();
				return;
			}
			// The mirror stays as it was: with the engine gone, the next `ready`
			// reads it again; refused twice, the next change or edit does.
			if (!(error instanceof EngineGoneError)) {
				_mirrorFailed = true;
				_mirrorError = error instanceof Error ? error.message : String(error);
				setModelError({
					kind: 'error',
					message: new StagedUnreadableError(_mirrorError).message
				});
			}
			_mirrorRetry = false;
			_mirrorOwed = false;
			release();
		}
	);
}

/** The element ids the mirror's staged and parked batches touch. */
function mirrorElementIds(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
	const ids = new Set<string>();
	for (const entry of _diff?.elements ?? []) ids.add(entry.id);
	for (const conflict of _parked) {
		for (const op of conflict.batch.ops) if (isElementOp(op)) ids.add(entityOf(op));
	}
	return ids;
}

/** Re-reads the cached elements a re-bootstrap's batches touched, before and after it. */
function heal(before: Set<string>): void {
	_healIds = null;
	const ids = [...new Set([...before, ...mirrorElementIds()])].filter(
		(id) => (_elements.has(id) || _treeItems.has(id) || _hidden.has(id)) && !isPending(id)
	);
	if (ids.length > 0) reReadElements(ids);
}

// ---------------------------------------------------------------------------
// `changed`, and deltas
// ---------------------------------------------------------------------------

function onChanged(event: ChangedEvent): void {
	_seenVersion = event.staged_version;
	for (const id of event.deleted_element_ids) {
		if (_elements.delete(id)) _hidden.add(id);
		_treeItems.delete(id);
		_pendingElementFetches.delete(id);
	}
	for (const id of event.deleted_relationship_ids) _relationships.delete(id);
	for (const id of event.element_ids) _missingElementIds.delete(id);
	// A changed relationship is left to the relationships list, which refetches
	// on the structure rev: the event is structural whenever one moved.
	const reread = event.element_ids.filter(
		(id) => (_elements.has(id) || _hidden.has(id)) && !isPending(id)
	);
	if (reread.length > 0) reReadElements(reread);
	if (event.structural) bumpStructureRev();
	// A delta's event may come before or after the store's own `applyDelta`.
	if (event.rev > getModelRev()) setModelRev(event.rev);
	// Last: with nothing to read, it releases the settled waiters.
	pumpMirror();
}

/** Writes what the engine answers for `ids` over the cache; an id it omits leaves it. */
function reReadElements(ids: readonly string[]): void {
	const epoch = _epoch;
	_refreshing += 1;
	void (async () => {
		try {
			for (let i = 0; i < ids.length; i += modelReadApi.READ_PAGE_LIMIT) {
				const chunk = ids.slice(i, i + modelReadApi.READ_PAGE_LIMIT);
				const fetched = await modelReadApi.getElementsBatch(chunk);
				if (epoch !== _epoch) return;
				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
				const returned = new Set<string>();
				for (const e of fetched) {
					returned.add(e.id);
					if (isPending(e.id)) continue;
					_elements.set(e.id, e);
					_hidden.delete(e.id);
				}
				for (const id of chunk) {
					if (returned.has(id) || isPending(id)) continue;
					_hidden.delete(id);
					_elements.delete(id);
					_treeItems.delete(id);
					_missingElementIds.add(id);
				}
			}
		} catch {
			// The next change, or the next read, heals.
		} finally {
			if (epoch === _epoch) {
				_refreshing -= 1;
				release();
			}
		}
	})();
}

/** The ids a staged batch touches: the diff's, and the targets of edits not yet in it. */
function stagedIds(): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
	const ids = new Set<string>();
	for (const entry of _diff?.elements ?? []) ids.add(entry.id);
	for (const entry of _diff?.relationships ?? []) ids.add(entry.id);
	for (const entry of _provisional) for (const op of entry.ops) ids.add(entityOf(op));
	return ids;
}

/**
 * Splices a committed delta, the user's own or a peer's, into the store: the
 * shared half first (rev, issues, summary), then temp ids re-keyed in the
 * caches, the visit history and the selection, then the delta's entities
 * upserted — except those a staged batch touches, whose cached record is the
 * working copy's, and the replica's `changed` event re-reads them. The
 * structure rev and the mirror move on that event, not here.
 *
 * A delta older than the store's rev is one the replica applied already —
 * its `changed` events moved the rev and re-read the caches past it — so its
 * rev and entities are stale: only its issues and its id map are taken.
 */
export function applyDelta(d: OpsResponse): void {
	const stale = d.model_rev < getModelRev();
	applyDeltaShared(d, (id) => _elements.has(id), { structure: false, rev: !stale });

	if (Object.keys(d.id_map).length > 0) {
		remapCaches(_elements, _relationships, _treeItems, d.id_map);
		// Before the re-point: its visit then finds the canonical id at the cursor.
		remapVisitIds(d.id_map);
		const sel = getSelection();
		if (sel !== null && d.id_map[sel.id] !== undefined) {
			select({ kind: sel.kind, id: d.id_map[sel.id] });
		}
	}
	if (stale) return;

	const staged = stagedIds();
	for (const e of d.changed_elements) {
		if (staged.has(e.id)) continue;
		_elements.set(e.id, e);
		_missingElementIds.delete(e.id);
	}
	for (const r of d.changed_relationships) {
		if (staged.has(r.id)) continue;
		_relationships.set(r.id, r);
	}
	for (const id of d.deleted_element_ids) {
		_elements.delete(id);
		_treeItems.delete(id);
		_missingElementIds.add(id);
	}
	for (const id of d.deleted_relationship_ids) _relationships.delete(id);
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export function getCachedElements(): ReadonlyMap<string, Element> {
	return _elements;
}

export function getMissingElementIds(): ReadonlySet<string> {
	return _missingElementIds;
}

export function getCachedTreeItems(): ReadonlyMap<string, TreeItem> {
	return _treeItems;
}

/** Full `_elements` entries, and a minimal element for every other lite tree row. */
export function getTreeElements(): Map<string, Element> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const out = new Map<string, Element>();
	for (const [id, t] of _treeItems) {
		const properties = t.display_name && t.display_name !== id ? { name: t.display_name } : {};
		out.set(id, { id, type_name: t.type_name, properties, rev: 0 });
	}
	for (const [id, e] of _elements) out.set(id, e);
	return out;
}

export function seedTreeItems(items: readonly TreeItem[]): void {
	for (const t of items) {
		_treeItems.set(t.id, t);
		_missingElementIds.delete(t.id);
	}
}

export function dropTreeItems(ids: readonly string[]): void {
	for (const id of ids) {
		_treeItems.delete(id);
		_missingElementIds.delete(id);
	}
}

export function getCachedRelationships(): ReadonlyMap<string, Relationship> {
	return _relationships;
}

/**
 * Upserts elements a paged read of the replica returned. No rev guard: a
 * record the engine answers later is newer, whatever its `rev` — an unstaged
 * edit puts the committed, lower one back.
 */
export function seedElements(els: readonly Element[]): void {
	for (const e of els) {
		if (isPending(e.id)) continue;
		_elements.set(e.id, e);
		_missingElementIds.delete(e.id);
	}
}

/** Relationship counterpart of {@link seedElements}. */
export function seedRelationships(rels: readonly Relationship[]): void {
	for (const r of rels) {
		if (isPending(r.id)) continue;
		_relationships.set(r.id, r);
	}
}

// ---------------------------------------------------------------------------
// Cache-or-fetch reads
// ---------------------------------------------------------------------------

/**
 * The cached element, or the replica's (cached then); `null` when the engine
 * says there is none — a temp id asked is asked like any other.
 */
export async function ensureElement(id: string): Promise<Element | null> {
	const cached = _elements.get(id);
	if (cached !== undefined) return cached;
	const pending = _pendingElementFetches.get(id);
	if (pending !== undefined) return pending;
	const epoch = _epoch;
	const fetchPromise = (async (): Promise<Element | null> => {
		try {
			const e = await getElement(id);
			if (epoch !== _epoch) return e;
			if (isPending(e.id)) return _elements.get(e.id) ?? e;
			_elements.set(e.id, e);
			_missingElementIds.delete(e.id);
			return e;
		} catch (err) {
			if (err instanceof NotFoundError) {
				if (epoch === _epoch) _missingElementIds.add(id);
				return null;
			}
			throw err;
		}
	})();
	_pendingElementFetches.set(id, fetchPromise);
	try {
		return await fetchPromise;
	} finally {
		if (_pendingElementFetches.get(id) === fetchPromise) _pendingElementFetches.delete(id);
	}
}

/**
 * Batched cache-or-fetch: the ids not cached, not confirmed missing and not
 * already being fetched, in chunks; an id the engine omits is recorded missing.
 */
export async function ensureElements(ids: readonly string[]): Promise<void> {
	const want = wanted(ids, (id) => _elements.has(id));
	if (want.length === 0) return;
	await fetchChunks(want, async (chunk, epoch) => {
		const fetched = await modelReadApi.getElementsBatch(chunk);
		if (epoch !== _epoch) return;
		for (const e of fetched) if (!isPending(e.id)) _elements.set(e.id, e);
		markOmitted(
			chunk,
			fetched.map((e) => e.id)
		);
	});
}

/** The lite tree rows of `ids` not already held in either cache; see {@link ensureElements}. */
export async function ensureTreeItems(ids: readonly string[]): Promise<void> {
	const want = wanted(ids, (id) => _elements.has(id) || _treeItems.has(id));
	if (want.length === 0) return;
	await fetchChunks(want, async (chunk, epoch) => {
		const fetched = await modelReadApi.getTreeItemsBatch(chunk);
		if (epoch !== _epoch) return;
		seedTreeItems(fetched);
		markOmitted(
			chunk,
			fetched.map((t) => t.id)
		);
	});
}

function wanted(ids: readonly string[], held: (id: string) => boolean): string[] {
	const want: string[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral dedup
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (
			held(id) ||
			_missingElementIds.has(id) ||
			_inFlightBatchIds.has(id) ||
			_pendingElementFetches.has(id)
		)
			continue;
		want.push(id);
	}
	return want;
}

async function fetchChunks(
	want: string[],
	fetchChunk: (chunk: string[], epoch: number) => Promise<void>
): Promise<void> {
	const epoch = _epoch;
	for (const id of want) _inFlightBatchIds.add(id);
	try {
		for (let i = 0; i < want.length; i += modelReadApi.READ_PAGE_LIMIT) {
			await fetchChunk(want.slice(i, i + modelReadApi.READ_PAGE_LIMIT), epoch);
		}
	} finally {
		if (epoch === _epoch) for (const id of want) _inFlightBatchIds.delete(id);
	}
}

function markOmitted(asked: readonly string[], returned: readonly string[]): void {
	const got = new Set(returned);
	for (const id of asked) if (!got.has(id)) _missingElementIds.add(id);
}

/** Cache-only: there is no single-relationship read. */
export async function ensureRelationship(id: string): Promise<Relationship | null> {
	return _relationships.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Staged-edit readers, over the mirror and the edits not yet in it
// ---------------------------------------------------------------------------

function targetOf(op: ModelOp): string {
	return op.kind === 'create_element' || op.kind === 'create_relationship' ? op.temp_id : op.id;
}

/** A committed batch the replica may still hold: no reader shows it. */
function isCommitted(batchId: number): boolean {
	return _landed.has(batchId) || _abandoned.has(batchId);
}

function anyCommitted(): boolean {
	return _landed.size > 0 || _abandoned.size > 0;
}

/** The mirror's batches but the committed ones. */
function stagedBatches(): StagedBatch[] {
	return anyCommitted() ? _batches.filter((batch) => !isCommitted(batch.id)) : _batches;
}

/** Every staged op: the mirror's batches in order, then the provisional ones. */
function stagedOps(): ModelOp[] {
	const ops: ModelOp[] = [];
	for (const batch of stagedBatches()) ops.push(...batch.ops);
	for (const entry of _provisional) ops.push(...entry.ops);
	return ops;
}

export function getStagedOps(): ModelOp[] {
	return stagedOps();
}

export function getStagedOpsFor(id: string): ModelOp[] {
	return stagedOps().filter((op) => targetOf(op) === id);
}

/** The name the newest staged op touching it gives `id`; the id itself when that op clears it. */
export function getStagedNameOverride(id: string): string | undefined {
	const ops = stagedOps();
	for (let i = ops.length - 1; i >= 0; i--) {
		const op = ops[i];
		if (targetOf(op) !== id) continue;
		const bag =
			op.kind === 'update_element' || op.kind === 'update_relationship'
				? op.properties_patch
				: op.kind === 'create_element' || op.kind === 'create_relationship'
					? op.properties
					: undefined;
		if (bag === undefined) continue;
		const key = 'name' in bag ? 'name' : Object.keys(bag).find((k) => k.toLowerCase() === 'name');
		if (key === undefined) continue;
		return nameProp({ name: bag[key] }) ?? id;
	}
	return undefined;
}

export function getStagedDepth(): number {
	return stagedOps().length;
}

export function hasStagedOps(): boolean {
	return getStagedDepth() > 0;
}

export function getStagedBatchIds(): number[] {
	return stagedBatches().map((batch) => batch.id);
}

/** The mirror's batches alone: the ops of each are exactly what naming its id commits. */
export function getStagedBatches(): readonly StagedBatch[] {
	return stagedBatches();
}

export function getStagedConflicts(): StagedConflict[] {
	return anyCommitted() ? _parked.filter((c) => !isCommitted(c.batch.id)) : _parked;
}

/** A staged `delete_element` targets `id`. */
export function isStagedDeleted(id: string): boolean {
	return stagedOps().some((op) => op.kind === 'delete_element' && op.id === id);
}

/** The engine's diff: each touched entity's committed image against its record now. */
export function getStagedDiff(): Diff {
	const elements = { before: [] as Element[], after: [] as Element[] };
	const relationships = { before: [] as Relationship[], after: [] as Relationship[] };
	const committed = committedOnly(landedOf([..._landed, ..._abandoned]));
	for (const entry of _diff?.elements ?? []) {
		if (committed.has(entry.id)) continue;
		if (entry.before !== null) elements.before.push(entry.before);
		if (entry.after !== null) elements.after.push(entry.after);
	}
	for (const entry of _diff?.relationships ?? []) {
		if (committed.has(entry.id)) continue;
		if (entry.before !== null) relationships.before.push(entry.before);
		if (entry.after !== null) relationships.after.push(entry.after);
	}
	return computeDiff({ elements: elements.before, relationships: relationships.before } as never, {
		elements: elements.after,
		relationships: relationships.after
	});
}

export function getStagedChangeCount(): number {
	const c = getStagedDiff().counts;
	return c.added + c.modified + c.deleted;
}

/**
 * The diff's entity ids only the batches `ids` account for: what their ops
 * name, and the cascade of a delete among them — the deleted relationships
 * incident to a deleted element of it, and the deleted elements those
 * relationships contain — less anything another staged edit names.
 */
function committedOnly(ids: ReadonlySet<number>): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
	const out = new Set<string>();
	if (ids.size === 0 || _diff === null) return out;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
	const deleted = new Set<string>();
	for (const batch of [..._batches, ..._parked.map((conflict) => conflict.batch)]) {
		if (!ids.has(batch.id)) continue;
		for (const op of batch.ops) {
			out.add(entityOf(op));
			if (op.kind === 'delete_element') deleted.add(op.id);
		}
	}
	const gone = new Set(_diff.elements.filter((e) => e.after === null).map((e) => e.id));
	for (let grew = deleted.size > 0; grew; ) {
		grew = false;
		for (const entry of _diff.relationships) {
			if (entry.after !== null || entry.before === null || out.has(entry.id)) continue;
			const { source_id: source, target_id: target } = entry.before;
			if (!deleted.has(source) && !deleted.has(target)) continue;
			out.add(entry.id);
			// A delete cascades from a container, the source, to what it contains.
			if (deleted.has(source) && gone.has(target) && !deleted.has(target)) {
				deleted.add(target);
				out.add(target);
			}
			grew = true;
		}
	}
	for (const op of stagedOps()) out.delete(entityOf(op));
	for (const conflict of getStagedConflicts()) {
		for (const op of conflict.batch.ops) out.delete(entityOf(op));
	}
	return out;
}

/**
 * The batches a commit of the user's carried, once the server has landed it:
 * no reader shows them and no commit sends them again, from now until a
 * mirror read no longer holds them.
 */
export function markLanded(batchIds: readonly number[]): void {
	if (batchIds.length === 0) return;
	_landed = landedOf([..._landed, ...batchIds]);
}

/**
 * The batches `batchIds` will not be in the replica that comes next — the
 * answer of the commit that carried them was dropped, or they are committed
 * and a worker gone could not be asked: they leave the mirror now, with what
 * the diff owes them alone, and stay out of the readers until that replica
 * is ready.
 */
export function forgetBatches(batchIds: readonly number[]): void {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
	const ids = new Set(batchIds);
	if (ids.size === 0) return;
	const committed = committedOnly(ids);
	if (_diff !== null && committed.size > 0) {
		_diff = {
			elements: _diff.elements.filter((entry) => !committed.has(entry.id)),
			relationships: _diff.relationships.filter((entry) => !committed.has(entry.id))
		};
	}
	_batches = _batches.filter((batch) => !ids.has(batch.id));
	_parked = _parked.filter((conflict) => !ids.has(conflict.batch.id));
	_landed = landedOf([..._landed].filter((id) => !ids.has(id)));
	_abandoned = landedOf([..._abandoned, ...ids]);
	postDeferred();
	release();
}

/**
 * What a re-bootstrap adopts when the worker is gone and cannot be asked: the
 * staged and parked batches as this half last knew them — the mirror's, each
 * replaced by a later stage answer's — less the committed ones, which leave
 * the mirror as they are handed over. An edit not answered yet is not among
 * them: the sync holds it and posts it to the replica that adopts them.
 */
export function handOverStaged(): StagedBatch[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral lookup
	const byId = new Map<number, StagedBatch>();
	for (const batch of _batches) byId.set(batch.id, batch);
	for (const conflict of _parked) byId.set(conflict.batch.id, conflict.batch);
	for (const entry of _provisional) if (entry.batch !== null) byId.set(entry.batch.id, entry.batch);
	const committed = [..._landed, ..._abandoned];
	const out = [...byId.values()].filter((batch) => !isCommitted(batch.id));
	forgetBatches(committed);
	return out.sort((a, b) => a.id - b.id);
}

/** Anything is staged in the replica, the committed batches it still holds included. */
function replicaHoldsStaged(): boolean {
	return _batches.some((batch) => batch.ops.length > 0) || _provisional.length > 0;
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** The id the engine stages an op's entity under: a create's `id` hint, else its temp id. */
function entityOf(op: ModelOp): string {
	if (op.kind === 'create_element' || op.kind === 'create_relationship') {
		return op.id ?? op.temp_id;
	}
	return op.id;
}

function isElementOp(op: ModelOp): boolean {
	return (
		op.kind === 'create_element' || op.kind === 'update_element' || op.kind === 'delete_element'
	);
}

/** A copy the caller cannot change under the provisional mirror. */
function copyOp(op: ModelOp): ModelOp {
	if (op.kind === 'create_element' || op.kind === 'create_relationship') {
		return { ...op, properties: { ...op.properties } };
	}
	if (op.kind === 'update_element' || op.kind === 'update_relationship') {
		return { ...op, properties_patch: { ...op.properties_patch } };
	}
	return { ...op };
}

/**
 * Writes `op` into the caches as the engine will apply it; an update or a
 * delete of what is not cached changes nothing. Whether a cache changed.
 */
function applyOptimistic(op: ModelOp): boolean {
	switch (op.kind) {
		case 'create_element': {
			const id = entityOf(op);
			_elements.set(id, { id, type_name: op.type_name, properties: { ...op.properties }, rev: 0 });
			_treeItems.set(id, {
				id,
				type_name: op.type_name,
				display_name: nameProp(op.properties) ?? id,
				child_count: 0
			});
			_missingElementIds.delete(id);
			return true;
		}
		case 'update_element': {
			const e = _elements.get(op.id);
			if (e === undefined) return false;
			_elements.set(op.id, { ...e, properties: mergePatch(e.properties, op.properties_patch) });
			return true;
		}
		case 'delete_element': {
			let touched = _elements.delete(op.id);
			if (touched) _hidden.add(op.id);
			if (_treeItems.delete(op.id)) touched = true;
			// The cached incident relationships; the engine's `changed` names the rest of the cascade.
			for (const [rid, r] of _relationships) {
				if (r.source_id !== op.id && r.target_id !== op.id) continue;
				_relationships.delete(rid);
				touched = true;
			}
			return touched;
		}
		case 'create_relationship': {
			const id = entityOf(op);
			_relationships.set(id, {
				id,
				type_name: op.type_name,
				source_id: op.source_id,
				target_id: op.target_id,
				properties: { ...op.properties },
				rev: 0
			});
			return true;
		}
		case 'update_relationship': {
			const r = _relationships.get(op.id);
			if (r === undefined) return false;
			_relationships.set(op.id, {
				...r,
				properties: mergePatch(r.properties, op.properties_patch)
			});
			return true;
		}
		case 'delete_relationship':
			return _relationships.delete(op.id);
	}
}

/**
 * Stages `op` in the replica: written into the caches at once, then posted as
 * a `stage`, which coalesces a property update into the first staged update
 * of the same entity.
 */
export function emit(op: ModelOp): void {
	stage([op]);
}

/** Stages `ops` as ONE batch: all of them or, refused, none. */
export function emitMany(ops: readonly ModelOp[]): void {
	if (ops.length > 0) stage(ops);
}

function stage(given: readonly ModelOp[]): void {
	const ops = given.map(copyOp);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
	const touched = new Set<string>();
	for (const op of ops) if (applyOptimistic(op) && isElementOp(op)) touched.add(entityOf(op));
	for (const op of ops) {
		const id = entityOf(op);
		_pending.set(id, (_pending.get(id) ?? 0) + 1);
	}
	_seq += 1;
	const entry: Provisional = {
		seq: _seq,
		ops,
		answered: null,
		batch: null,
		deferred: false,
		touched
	};
	_provisional = [..._provisional, entry];
	// Behind a deferred edit, every later one waits too: they reach the engine in order.
	if (_deferred.length > 0 || mergesIntoCommitted(ops)) {
		entry.deferred = true;
		_deferred.push(entry);
		return;
	}
	void post(entry, touched);
}

/**
 * Whether the engine would merge `ops` into a committed batch it still
 * holds: a single property update merges into the first staged batch
 * holding an update of the same entity, and such a batch is dropped whole
 * once the replica applies the commit's answer.
 */
function mergesIntoCommitted(ops: readonly ModelOp[]): boolean {
	if (!anyCommitted() || ops.length !== 1) return false;
	const op = ops[0]!;
	if (op.kind !== 'update_element' && op.kind !== 'update_relationship') return false;
	const first = _batches.find((batch) =>
		batch.ops.some((other) => other.kind === op.kind && other.id === op.id)
	);
	return first !== undefined && isCommitted(first.id);
}

/** Posts the deferred edits, in order, up to one that would still merge into a committed batch. */
function postDeferred(): void {
	while (_deferred.length > 0 && !mergesIntoCommitted(_deferred[0]!.ops)) {
		const entry = _deferred.shift()!;
		entry.deferred = false;
		void post(entry, entry.touched);
	}
}

async function post(entry: Provisional, touched: Set<string>): Promise<void> {
	const epoch = _epoch;
	const handle = _handle;
	let answer: StageAnswer;
	try {
		if (handle === null) throw new EngineGoneError();
		answer = await handle.call<StageAnswer>('stage', { ops: entry.ops }, { transition: true });
	} catch (error) {
		if (epoch === _epoch) refused(entry, touched, error);
		return;
	}
	if (epoch === _epoch) answered(entry, answer);
}

/** Takes `entry`'s edits off the pending counts; the ids whose count reached zero. */
function unpend(entry: Provisional): Set<string> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- ephemeral membership check
	const done = new Set<string>();
	for (const op of entry.ops) {
		const id = entityOf(op);
		const left = (_pending.get(id) ?? 1) - 1;
		if (left > 0) {
			_pending.set(id, left);
			done.delete(id);
		} else {
			_pending.delete(id);
			done.add(id);
		}
	}
	return done;
}

/**
 * The engine's post-state is written for the entities no newer edit is in
 * flight for; a newer edit's own answer writes them.
 */
function answered(entry: Provisional, answer: StageAnswer): void {
	entry.batch = answer.batch;
	const done = unpend(entry);
	if (answer.elements === null) {
		const ids = [...done].filter((id) => _elements.has(id));
		if (ids.length > 0) reReadElements(ids);
	} else {
		for (const e of answer.elements) {
			if (!done.has(e.id) || !_elements.has(e.id)) continue;
			_elements.set(e.id, e);
			_missingElementIds.delete(e.id);
		}
	}
	for (const r of answer.relationships ?? []) {
		if (done.has(r.id) && _relationships.has(r.id)) _relationships.set(r.id, r);
	}
	// A mirror read issued from now on covers this edit.
	entry.answered = _reads;
	pumpMirror();
}

/**
 * A refused batch left no trace in the engine: the elements its optimistic
 * write changed are read back, an id the engine does not know leaving the
 * caches; a relationship it created leaves them, and any other relationship
 * change is healed by the refetch a structure-rev bump starts.
 */
function refused(entry: Provisional, touched: Set<string>, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	setModelError({ kind: error instanceof EngineGoneError ? 'error' : 'rejected', message });
	withdraw(entry, touched);
}

/**
 * Takes an edit the engine does not hold out of this half: the elements its
 * cache write changed are read back, as the engine has them.
 */
function withdraw(entry: Provisional, touched: Set<string>): void {
	_provisional = _provisional.filter((e) => e !== entry);
	unpend(entry);
	for (const op of entry.ops) {
		const id = entityOf(op);
		if (isPending(id)) continue;
		if (op.kind === 'create_relationship') _relationships.delete(id);
		else if (op.kind === 'create_element' || op.kind === 'delete_element') _treeItems.delete(id);
	}
	const reread = [...touched].filter((id) => !isPending(id));
	if (reread.length > 0) reReadElements(reread);
	if (entry.ops.some((op) => op.kind !== 'update_element')) bumpStructureRev();
	pumpMirror();
}

// ---------------------------------------------------------------------------
// Unstaging
// ---------------------------------------------------------------------------

/**
 * Runs `work` once every edit before it has reached the mirror and every
 * earlier unstage request has been answered; the engine's `changed` does the
 * rest. A refused mirror is read once more first, and `work` does not run
 * while it stays refused: the mirror is not the engine's staged list then —
 * unless `work` reads nothing of the mirror (`readsMirror: false`).
 */
function unstageAfter(
	work: (handle: EngineHandle) => Promise<void>,
	{ readsMirror = true }: { readsMirror?: boolean } = {}
): void {
	const epoch = _epoch;
	_unstaging += 1;
	_unstageChain = _unstageChain.then(async () => {
		try {
			await waitFor(isQuiet);
			if (readsMirror && _mirrorFailed && epoch === _epoch) {
				readMirror();
				await waitFor(isQuiet);
			}
			const handle = _handle;
			if (epoch !== _epoch || handle === null || (readsMirror && _mirrorFailed)) return;
			await work(handle);
		} catch (error) {
			if (epoch !== _epoch) return;
			setModelError({
				kind: 'error',
				message: error instanceof Error ? error.message : String(error)
			});
		} finally {
			if (epoch === _epoch) {
				_unstaging -= 1;
				release();
			}
		}
	});
}

async function unstage(handle: EngineHandle, what: Unstage): Promise<void> {
	await handle.call('unstage', { what }, { transition: true });
}

/** Whether `op` targets `id` or has it as an end. */
function touches(op: ModelOp, id: string): boolean {
	if (entityOf(op) === id || targetOf(op) === id) return true;
	if (op.kind === 'create_relationship') return op.source_id === id || op.target_id === id;
	if (op.kind === 'update_relationship' || op.kind === 'delete_relationship') {
		const r =
			_relationships.get(op.id) ??
			_diff?.relationships.find((entry) => entry.id === op.id)?.before ??
			undefined;
		return r !== undefined && r !== null && (r.source_id === id || r.target_id === id);
	}
	return false;
}

/** Withdraws the deferred edits `test` picks: the engine never had them. */
function withdrawDeferred(test: (entry: Provisional) => boolean): void {
	const picked = _deferred.filter(test);
	if (picked.length === 0) return;
	_deferred = _deferred.filter((entry) => !picked.includes(entry));
	for (const entry of picked) withdraw(entry, entry.touched);
	postDeferred();
}

/**
 * Undo: unstages the last staged batch — a coalesced keystroke lives in its
 * first one — or withdraws the last deferred edit, the newest of all. False,
 * undoing nothing, when nothing is staged or the mirror is refused (which
 * reads it again for the next try).
 */
export function popLastStaged(): boolean {
	const deferred = _deferred.at(-1);
	if (deferred !== undefined) {
		withdrawDeferred((entry) => entry === deferred);
		return true;
	}
	if (_mirrorFailed) {
		readMirror();
		return false;
	}
	if (!hasStagedOps()) return false;
	unstageAfter(async (handle) => {
		const last = stagedBatches().at(-1);
		if (last !== undefined) await unstage(handle, { batch: last.id });
	});
	return true;
}

/** Unstages every staged op targeting `id`; a parked batch stays for the conflicts. */
export function revertStagedFor(id: string): void {
	withdrawDeferred((entry) => entry.ops.some((op) => targetOf(op) === id));
	unstageAfter((handle) => unstage(handle, { entity: id }));
}

/**
 * Unstages every staged op targeting `id` or having it as an end, and drops
 * the parked batches that do.
 */
export function revertStagedForElement(id: string): void {
	withdrawDeferred((entry) => entry.ops.some((op) => touches(op, id)));
	unstageAfter(async (handle) => {
		const parked = _parked
			.filter((conflict) => conflict.batch.ops.some((op) => touches(op, id)))
			.map((conflict) => conflict.batch.id);
		await unstage(handle, { entity: id, incident: true });
		for (const batch of parked) await unstage(handle, { batch });
	});
}

/** Unstages everything, parked batches included. */
export function revertAllStaged(): void {
	withdrawDeferred(() => true);
	unstageAfter((handle) => unstage(handle, 'all'));
}

/**
 * Unstages everything, parked batches included, whether or not the mirror
 * can be read; resolves once the engine has answered and this half has taken
 * it in. What a reload of the model does before it drops the caches: the
 * leases of the edits go with the reload.
 */
export function discardAllStaged(): Promise<void> {
	withdrawDeferred(() => true);
	unstageAfter((handle) => unstage(handle, 'all'), { readsMirror: false });
	return waitFor(isSettled);
}

/** Drops a parked batch. */
export function revertConflict(batchId: number): void {
	unstageAfter((handle) => unstage(handle, { batch: batchId }));
}

/**
 * Unstages batches a commit carried that the replica does not drop itself:
 * one that swapped the metamodel freezes the replica, which never applies
 * it. Held by id, the drop also finds them in a replica that adopted them
 * after a re-bootstrap; an id no longer staged is nothing to the engine.
 */
export function dropBatches(batchIds: readonly number[]): void {
	if (batchIds.length === 0) return;
	const ids = [...batchIds];
	unstageAfter(
		async (handle) => {
			for (const batch of ids) await unstage(handle, { batch });
		},
		{ readsMirror: false }
	);
}

/** Nothing: the engine drops the committed batches itself, on the commit's delta. */
export function clearStaged(): void {}
