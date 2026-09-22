import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { Element, OpsResponse, Relationship, TreeItem } from '$lib/api/types';
import type { ChangedEvent, ReplicaStatus, ReplicaSync } from '$lib/engine/sync';
import { getElement } from '../api/elements';
import { NotFoundError } from '../api/errors';
import * as modelReadApi from '../api/model-read';
import { computeDiff, type Diff } from './diff';
import { remapVisitIds } from './inspection-history.svelte';
import { remapCaches } from './model-caches';
import {
	applyDeltaShared,
	bumpStructureRev,
	getModelRev,
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
 * The replica says what moved through its `changed` event, the one path that
 * refreshes the caches after a transition: deleted ids leave them, cached
 * changed elements are read again, a structural change moves the structure
 * rev, and a staged list that moved is read again into the mirror (`staged`,
 * `conflicts`, `stagedDiff` as the engine last answered them), which the
 * synchronous staged-edit readers read.
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

/** Ops posted to the engine and not yet covered by a mirror read. */
type Provisional = { seq: number; ops: ModelOp[]; answered: number | null };

const _elements = new SvelteMap<string, Element>();
const _relationships = new SvelteMap<string, Relationship>();
/** Element ids the engine answered do not exist, a temp id included. */
const _missingElementIds = new SvelteSet<string>();
/** Lite tree rows; a full `_elements` entry wins in `getTreeElements()`. */
const _treeItems = new SvelteMap<string, TreeItem>();
/** Shared by concurrent `ensureElement` calls of one id; never read reactively. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _pendingElementFetches = new Map<string, Promise<Element | null>>();
/** Ids an `ensureElements` / `ensureTreeItems` batch is fetching; never read reactively. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _inFlightBatchIds = new Set<string>();

let _batches = $state.raw<StagedBatch[]>([]);
let _parked = $state.raw<StagedConflict[]>([]);
let _diff = $state.raw<StagedDiff | null>(null);
let _provisional = $state.raw<Provisional[]>([]);
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
/** Cache re-reads a `changed` event started, still in flight. */
let _refreshing = 0;
let _settledWaiters: (() => void)[] = [];

let _handle: EngineHandle | null = null;
let _unsubscribe: (() => void)[] = [];
/** Moves at every detach and reset: an answer to an older epoch is dropped. */
let _epoch = 0;

// ---------------------------------------------------------------------------
// The engine handle
// ---------------------------------------------------------------------------

/** Follows the engine behind `handle`: its `changed` events and its status. */
export function attachEngine(handle: EngineHandle): void {
	detachEngine();
	_handle = handle;
	_unsubscribe = [handle.on('changed', onChanged), handle.subscribe(onStatus)];
	const { phase } = handle.status();
	if (phase === 'ready' || phase === 'frozen') readMirror();
}

/** Stops following the engine and drops everything this half holds. */
export function detachEngine(): void {
	for (const off of _unsubscribe.splice(0)) off();
	_handle = null;
	clearAll();
}

/** The entity half's share of `resetModelStore()`: everything dropped, the mirror read again. */
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
	_elements.clear();
	_treeItems.clear();
	_relationships.clear();
	_batches = [];
	_parked = [];
	_diff = null;
	_provisional = [];
	_pending.clear();
	_seenVersion = UNKNOWN_VERSION;
	_mirrorVersion = UNKNOWN_VERSION;
	_mirrorReading = false;
	_mirrorOwed = false;
	_refreshing = 0;
	release();
}

function onStatus(status: ReplicaStatus, previous: ReplicaStatus): void {
	if (status.phase !== 'ready' || previous.phase === 'ready') return;
	// A replica ready anew may be another working copy — a re-bootstrap adopts
	// the batches without a `changed` event, and numbers its versions afresh.
	_seenVersion = UNKNOWN_VERSION;
	readMirror();
}

function isPending(id: string): boolean {
	return (_pending.get(id) ?? 0) > 0;
}

function isSettled(): boolean {
	return (
		!_mirrorReading &&
		!_mirrorOwed &&
		_refreshing === 0 &&
		_provisional.length === 0 &&
		_pending.size === 0
	);
}

function release(): void {
	if (!isSettled() || _settledWaiters.length === 0) return;
	const waiters = _settledWaiters;
	_settledWaiters = [];
	for (const resolve of waiters) resolve();
}

/**
 * Resolves once this half has taken in everything the engine told it: no
 * mirror read in flight or owed, no cache re-read in flight, no edit posted
 * and not yet covered by the mirror.
 */
export function stagedSettled(): Promise<void> {
	if (isSettled()) return Promise.resolve();
	return new Promise<void>((resolve) => _settledWaiters.push(resolve));
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

/**
 * Reads `staged`, `conflicts` and `stagedDiff` into the mirror; one read in
 * flight, one owed. A read issued after an edit's answer covers that edit; one
 * issued before may have run ahead of it (`staged` is answered at once).
 */
function readMirror(): void {
	const handle = _handle;
	if (handle === null) return;
	if (_mirrorReading) {
		_mirrorOwed = true;
		return;
	}
	_mirrorReading = true;
	_mirrorOwed = false;
	_reads += 1;
	const at = _reads;
	const version = _seenVersion;
	const epoch = _epoch;
	Promise.all([
		handle.call<StagedBatch[]>('staged'),
		handle.call<StagedConflict[]>('conflicts'),
		handle.call<StagedDiff>('stagedDiff')
	]).then(
		([batches, parked, diff]) => {
			if (epoch !== _epoch) return;
			_batches = batches;
			_parked = parked;
			_diff = diff;
			_mirrorVersion = version;
			_provisional = _provisional.filter(
				(entry) => entry.answered === null || entry.answered >= at
			);
			_mirrorReading = false;
			if (_mirrorOwed || _seenVersion !== _mirrorVersion) readMirror();
			else release();
		},
		() => {
			if (epoch !== _epoch) return;
			// The mirror stays as it was; the next `ready` reads it again.
			_mirrorReading = false;
			_mirrorOwed = false;
			release();
		}
	);
}

// ---------------------------------------------------------------------------
// `changed`, and deltas
// ---------------------------------------------------------------------------

function onChanged(event: ChangedEvent): void {
	_seenVersion = event.staged_version;
	if (_seenVersion !== _mirrorVersion) readMirror();
	for (const id of event.deleted_element_ids) {
		_elements.delete(id);
		_treeItems.delete(id);
		_pendingElementFetches.delete(id);
	}
	for (const id of event.deleted_relationship_ids) _relationships.delete(id);
	for (const id of event.element_ids) _missingElementIds.delete(id);
	// A changed relationship is left to the relationships list, which refetches
	// on the structure rev: the event is structural whenever one moved.
	const reread = event.element_ids.filter((id) => _elements.has(id) && !isPending(id));
	if (reread.length > 0) reReadElements(reread);
	if (event.structural) bumpStructureRev();
	// A delta's event may come before or after the store's own `applyDelta`.
	if (event.rev > getModelRev()) setModelRev(event.rev);
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
					if (!isPending(e.id)) _elements.set(e.id, e);
				}
				for (const id of chunk) {
					if (returned.has(id) || isPending(id)) continue;
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
	for (const entry of _provisional) for (const op of entry.ops) ids.add(targetOf(op));
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

/** Every staged op: the mirror's batches in order, then the provisional ones. */
function stagedOps(): ModelOp[] {
	const ops: ModelOp[] = [];
	for (const batch of _batches) ops.push(...batch.ops);
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
	return _batches.map((batch) => batch.id);
}

export function getStagedConflicts(): StagedConflict[] {
	return _parked;
}

/** A staged `delete_element` targets `id`. */
export function isStagedDeleted(id: string): boolean {
	return stagedOps().some((op) => op.kind === 'delete_element' && op.id === id);
}

/** The engine's diff: each touched entity's committed image against its record now. */
export function getStagedDiff(): Diff {
	const elements = { before: [] as Element[], after: [] as Element[] };
	const relationships = { before: [] as Relationship[], after: [] as Relationship[] };
	for (const entry of _diff?.elements ?? []) {
		if (entry.before !== null) elements.before.push(entry.before);
		if (entry.after !== null) elements.after.push(entry.after);
	}
	for (const entry of _diff?.relationships ?? []) {
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

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function notBuilt(): never {
	throw new Error('not built');
}

export function emit(op: ModelOp): void {
	void op;
	notBuilt();
}

export function popLastStaged(): boolean {
	return notBuilt();
}

export function revertStagedFor(id: string): void {
	void id;
	notBuilt();
}

export function revertStagedForElement(id: string): void {
	void id;
	notBuilt();
}

export function revertAllStaged(): void {
	notBuilt();
}

/** Nothing: the engine drops the committed batches itself, on the commit's delta. */
export function clearStaged(): void {}
