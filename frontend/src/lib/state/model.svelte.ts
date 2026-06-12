import { SvelteMap } from 'svelte/reactivity';

import type { ClientConfig } from '$lib/api/client';
import type {
	Element,
	Issue,
	IssueCounts,
	ModelSummary,
	OpsResponse,
	Relationship
} from '$lib/api/types';
import { getElement } from '../api/elements';
import { ConflictError, NotFoundError, ValidationError } from '../api/errors';
import * as modelOpsApi from '../api/model-ops';
import * as modelReadApi from '../api/model-read';
import { validateModel } from '../api/validation';
import { mergePatch } from './apply';
import { isTempId, type Op } from './ops';
import { remapProperties } from './remap';

/**
 * Delta-protocol model store (Phase D1 of the large-model overhaul).
 *
 * The backend session model is the source of truth; this store holds only
 * the FETCHED SUBSET of it (entities brought in by paged reads, searches,
 * neighborhoods, and ops deltas — never the whole model) plus the model-wide
 * counters that drive headers/status bars.
 *
 * Mutations keep the synchronous-optimistic `emit(op)` contract of the old
 * `pending.svelte.ts` store: the op is applied to the local caches
 * immediately, queued, and flushed to POST /model/ops in batches —
 * structural ops (create/delete/connect) on a 0 ms timeout, property updates
 * debounced (coalescing successive patches to the same entity). Flushes are
 * strictly serialized: never two in-flight batches.
 *
 * Error policy:
 * - 409 (rev conflict): the store enters a CONFLICT state — the queue is
 *   dropped, further flushing is suspended, the summary is refetched so the
 *   UI can report the server's revision, and `getModelError()` returns a
 *   `kind: 'conflict'` error. Recovery = reload the model (resetModelStore +
 *   re-fetch); local caches may be divergent until then.
 * - 422 (invalid op) and network/server errors: the batch did not apply
 *   server-side, so the optimistic cache effects of the failed batch AND of
 *   everything still queued behind it are reverted exactly from a per-op
 *   journal recorded at emit time (no refetch needed — the journal restores
 *   the precise pre-batch cache state). The queue is cleared and a
 *   `kind: 'rejected'` / `kind: 'error'` error is surfaced; the store stays
 *   usable.
 *
 * Cache policy for deltas: ALL changed entities in a delta are upserted into
 * the caches (deltas are small — O(batch + cascade), not O(model)), so
 * anything the user just touched is guaranteed fresh; deleted ids are
 * dropped; temp ids are remapped to canonical ids everywhere (cache keys,
 * relationship endpoints, ref-shaped property values, queued ops and their
 * revert journals).
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ModelStoreError {
	kind: 'conflict' | 'rejected' | 'error';
	message: string;
}

/** Restores one cache slot to its pre-op state (null = entry did not exist). */
type RevertEntry =
	| { entity: 'element'; id: string; before: Element | null }
	| { entity: 'relationship'; id: string; before: Relationship | null };

interface QueuedOp {
	op: Op;
	revert: RevertEntry[];
}

/** Debounce window for property-update flushes. Structural ops flush at 0 ms. */
export const PROPERTY_FLUSH_DELAY_MS = 300;

const _elements = new SvelteMap<string, Element>();
const _relationships = new SvelteMap<string, Relationship>();
/** Issues keyed by OWNER (= issue.target_ids[0]), mirroring the backend
 * ValidationState; fed by ops deltas and full validateAll() runs. */
const _issuesByOwner = new SvelteMap<string, Issue[]>();

let _summary: ModelSummary | null = $state(null);
let _modelRev = $state(0);
let _undoDepth = $state(0);
let _issueCounts: IssueCounts | null = $state(null);
let _error: ModelStoreError | null = $state(null);

let _queue: QueuedOp[] = $state([]);
let _inFlight = $state(false);

let _flushTimer: ReturnType<typeof setTimeout> | null = null;
let _flushDeadline = Infinity;
let _flushPromise: Promise<void> | null = null;
/** Bumped by resetModelStore so in-flight responses of a dead store are dropped. */
let _generation = 0;

/** Test/dev hook: ClientConfig forwarded to every API call this store makes. */
let _clientConfig: ClientConfig | undefined;

export function setModelApiConfig(cfg: ClientConfig | undefined): void {
	_clientConfig = cfg;
}

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export function getCachedElements(): ReadonlyMap<string, Element> {
	return _elements;
}

export function getCachedRelationships(): ReadonlyMap<string, Relationship> {
	return _relationships;
}

export function getIssuesByOwner(): ReadonlyMap<string, Issue[]> {
	return _issuesByOwner;
}

export function getModelSummary(): ModelSummary | null {
	return _summary;
}

export function getModelRev(): number {
	return _modelRev;
}

export function getUndoDepth(): number {
	return _undoDepth;
}

/** null = the model has not been validated yet (distinct from zero issues). */
export function getIssueCounts(): IssueCounts | null {
	return _issueCounts;
}

export function getModelError(): ModelStoreError | null {
	return _error;
}

export function clearModelError(): void {
	// conflict errors are NOT clearable this way: the store is divergent and
	// only a reload (resetModelStore + refetch) makes it trustworthy again
	if (_error !== null && _error.kind !== 'conflict') _error = null;
}

/**
 * True while local edits have not been acknowledged by the server (queued
 * and/or in flight). Task 10 gates save flows on `flushNow()` + this.
 *
 * Never sticks at true in conflict state: the 409 handler drops the queue
 * and {@link emit} discards ops while conflicted, so save gating cannot hang.
 */
export function hasPendingOps(): boolean {
	return _queue.length > 0 || _inFlight;
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

/**
 * Change-tracking (like {@link remapProperties}): returns the ORIGINAL object
 * when nothing referenced a mapped id, so callers can skip the cache write.
 */
function remapElement(e: Element, idMap: Record<string, string>): Element {
	const id = idMap[e.id] ?? e.id;
	const properties = remapProperties(e.properties, idMap);
	if (id === e.id && properties === e.properties) return e;
	return { ...e, id, properties };
}

/** Change-tracking; see {@link remapElement}. */
function remapRelationship(r: Relationship, idMap: Record<string, string>): Relationship {
	const id = idMap[r.id] ?? r.id;
	const source_id = idMap[r.source_id] ?? r.source_id;
	const target_id = idMap[r.target_id] ?? r.target_id;
	const properties = remapProperties(r.properties, idMap);
	if (
		id === r.id &&
		source_id === r.source_id &&
		target_id === r.target_id &&
		properties === r.properties
	) {
		return r;
	}
	return { ...r, id, source_id, target_id, properties };
}

function remapOp(op: Op, idMap: Record<string, string>): Op {
	switch (op.kind) {
		case 'create_element':
			return { ...op, properties: remapProperties(op.properties, idMap) };
		case 'update_element':
		case 'update_relationship':
			return {
				...op,
				id: idMap[op.id] ?? op.id,
				properties_patch: remapProperties(op.properties_patch, idMap)
			};
		case 'delete_element':
		case 'delete_relationship':
			return { ...op, id: idMap[op.id] ?? op.id };
		case 'create_relationship':
			return {
				...op,
				source_id: idMap[op.source_id] ?? op.source_id,
				target_id: idMap[op.target_id] ?? op.target_id,
				properties: remapProperties(op.properties, idMap)
			};
	}
}

function remapCaches(idMap: Record<string, string>): void {
	// 1. move entries keyed by a temp id to their canonical key
	for (const [tempId, canonicalId] of Object.entries(idMap)) {
		const e = _elements.get(tempId);
		if (e !== undefined) {
			_elements.delete(tempId);
			_elements.set(canonicalId, { ...e, id: canonicalId });
		}
		const r = _relationships.get(tempId);
		if (r !== undefined) {
			_relationships.delete(tempId);
			_relationships.set(canonicalId, { ...r, id: canonicalId });
		}
	}
	// 2. remap references held INSIDE cached entities (endpoints + ref props);
	//    identity-preserving: entities that referenced no mapped id keep their
	//    object and skip the Map.set, so subscriptions don't churn O(cache)
	for (const [id, e] of _elements) {
		const next = remapElement(e, idMap);
		if (next !== e) _elements.set(id, next);
	}
	for (const [id, r] of _relationships) {
		const next = remapRelationship(r, idMap);
		if (next !== r) _relationships.set(id, next);
	}
	// 3. remap queued-but-unflushed ops and their revert journals: the server
	//    resolves temp ids only WITHIN a batch, so later batches must carry
	//    canonical ids
	_queue = _queue.map((q) => ({
		op: remapOp(q.op, idMap),
		revert: q.revert.map((entry): RevertEntry => {
			if (entry.entity === 'element') {
				return {
					entity: 'element',
					id: idMap[entry.id] ?? entry.id,
					before: entry.before === null ? null : remapElement(entry.before, idMap)
				};
			}
			return {
				entity: 'relationship',
				id: idMap[entry.id] ?? entry.id,
				before: entry.before === null ? null : remapRelationship(entry.before, idMap)
			};
		})
	}));
}

/** Bucket an issue under its owner (= target_ids[0]), mirroring the backend ValidationState. */
function addIssueToOwner(issue: Issue): void {
	const owner = issue.target_ids[0] ?? '';
	const existing = _issuesByOwner.get(owner);
	if (existing !== undefined) _issuesByOwner.set(owner, [...existing, issue]);
	else _issuesByOwner.set(owner, [issue]);
}

/**
 * Splice an {@link OpsResponse} delta into the store: remap temp ids, upsert
 * changed entities, drop deleted ids, apply the issue-store delta, and adopt
 * the server's revision/issue counts.
 *
 * Does NOT touch `undoDepth` (an OpsResponse does not carry it): callers
 * adjust it (+1 per accepted batch, -1 per undo, 0 after apply-cr) or
 * refresh the summary.
 *
 * Known (accepted) artifact: an acked delta upserts the SERVER state of a
 * changed entity, transiently overwriting optimistic effects of ops still
 * queued for that same entity; the next flush re-acks them within the
 * debounce window. Exact queue-aware splicing was judged not worth the
 * complexity for a sub-flush-window flicker.
 */
export function applyDelta(d: OpsResponse): void {
	if (Object.keys(d.id_map).length > 0) remapCaches(d.id_map);

	for (const e of d.changed_elements) _elements.set(e.id, e);
	for (const r of d.changed_relationships) _relationships.set(r.id, r);
	for (const id of d.deleted_element_ids) _elements.delete(id);
	for (const id of d.deleted_relationship_ids) _relationships.delete(id);

	for (const owner of d.issues_removed_owner_ids) _issuesByOwner.delete(owner);
	for (const issue of d.issues_added) addIssueToOwner(issue);

	_modelRev = d.model_rev;
	_issueCounts = d.issue_counts;
	if (_summary !== null) {
		// keep the coherent bits in sync; element/relationship counts are NOT
		// maintained incrementally (refreshSummary() is the cheap exact source)
		_summary = { ..._summary, model_rev: d.model_rev, issue_counts: d.issue_counts };
	}
}

// ---------------------------------------------------------------------------
// emit() — optimistic local apply + queued flush
// ---------------------------------------------------------------------------

function snapshotElement(id: string): RevertEntry {
	return { entity: 'element', id, before: _elements.get(id) ?? null };
}

function snapshotRelationship(id: string): RevertEntry {
	return { entity: 'relationship', id, before: _relationships.get(id) ?? null };
}

/**
 * Apply one op to the local caches, returning the journal entries that
 * restore the pre-op cache state. Ops touching entities that are not cached
 * are a local no-op (the server delta upserts them on ack).
 */
function applyOptimistic(op: Op): RevertEntry[] {
	switch (op.kind) {
		case 'create_element': {
			const revert = [snapshotElement(op.temp_id)];
			_elements.set(op.temp_id, {
				id: op.temp_id,
				type_name: op.type_name,
				properties: { ...op.properties },
				rev: 0
			});
			return revert;
		}
		case 'update_element': {
			const e = _elements.get(op.id);
			if (e === undefined) return [];
			const revert = [snapshotElement(op.id)];
			_elements.set(op.id, { ...e, properties: mergePatch(e.properties, op.properties_patch) });
			return revert;
		}
		case 'delete_element': {
			if (!_elements.has(op.id)) return [];
			const revert = [snapshotElement(op.id)];
			_elements.delete(op.id);
			// cascade over CACHED incident relationships (mirrors apply.ts);
			// server-side containment cascades arrive via the delta's deleted ids
			for (const [rid, r] of _relationships) {
				if (r.source_id === op.id || r.target_id === op.id) {
					revert.push({ entity: 'relationship', id: rid, before: r });
					_relationships.delete(rid);
				}
			}
			return revert;
		}
		case 'create_relationship': {
			const revert = [snapshotRelationship(op.temp_id)];
			_relationships.set(op.temp_id, {
				id: op.temp_id,
				type_name: op.type_name,
				source_id: op.source_id,
				target_id: op.target_id,
				properties: { ...op.properties },
				rev: 0
			});
			return revert;
		}
		case 'update_relationship': {
			const r = _relationships.get(op.id);
			if (r === undefined) return [];
			const revert = [snapshotRelationship(op.id)];
			_relationships.set(op.id, {
				...r,
				properties: mergePatch(r.properties, op.properties_patch)
			});
			return revert;
		}
		case 'delete_relationship': {
			if (!_relationships.has(op.id)) return [];
			const revert = [snapshotRelationship(op.id)];
			_relationships.delete(op.id);
			return revert;
		}
	}
}

function isPropertyUpdate(
	op: Op
): op is Extract<Op, { properties_patch: Record<string, unknown> }> {
	return op.kind === 'update_element' || op.kind === 'update_relationship';
}

function cancelFlushTimer(): void {
	if (_flushTimer !== null) {
		clearTimeout(_flushTimer);
		_flushTimer = null;
		_flushDeadline = Infinity;
	}
}

function scheduleFlush(delayMs: number): void {
	if (_error?.kind === 'conflict') return; // flushing is suspended until reload
	const deadline = Date.now() + delayMs;
	if (_flushTimer !== null) {
		if (deadline >= _flushDeadline) return; // an earlier-or-equal flush is already due
		cancelFlushTimer();
	}
	_flushDeadline = deadline;
	_flushTimer = setTimeout(() => {
		_flushTimer = null;
		_flushDeadline = Infinity;
		void startFlush();
	}, delayMs);
}

/**
 * Apply `op` optimistically and queue it for the server.
 *
 * Synchronous, like the old `pending.svelte.ts` emit: the caches reflect the
 * op before this returns. Structural ops flush on a 0 ms timeout; property
 * updates are debounced {@link PROPERTY_FLUSH_DELAY_MS} and coalesced into an
 * already-queued update of the same entity.
 *
 * In CONFLICT state the op is dropped entirely (not applied, not queued):
 * the caches are already declared divergent and flushing is suspended, so
 * queueing would only leave {@link hasPendingOps} true forever and hang
 * save gating. Recovery is a full reload (resetModelStore + refetch).
 */
export function emit(op: Op): void {
	if (_error?.kind === 'conflict') return;

	const revert = applyOptimistic(op);

	if (isPropertyUpdate(op)) {
		const existing = _queue.find((q) => q.op.kind === op.kind && q.op.id === op.id);
		if (existing !== undefined && isPropertyUpdate(existing.op)) {
			// later keys win; null values survive the spread (null = delete key
			// server-side). Safe regardless of intervening ops: property updates
			// of one entity commute with every op on OTHER entities, and a
			// delete/create of the SAME id in between would be a caller bug.
			// The journal keeps the ORIGINAL pre-update snapshot — unless that
			// snapshot is empty (entity was uncached at first emit and a delta
			// upserted it since), in which case the earliest known state wins.
			existing.op.properties_patch = {
				...existing.op.properties_patch,
				...op.properties_patch
			};
			if (existing.revert.length === 0) existing.revert.push(...revert);
			scheduleFlush(PROPERTY_FLUSH_DELAY_MS);
			return;
		}
		_queue.push({ op: { ...op, properties_patch: { ...op.properties_patch } }, revert });
		scheduleFlush(PROPERTY_FLUSH_DELAY_MS);
		return;
	}

	// defensive copy: create ops carry a properties object the caller might
	// keep mutating before the flush fires (mirrors the property-patch copy)
	_queue.push({
		op:
			op.kind === 'create_element' || op.kind === 'create_relationship'
				? { ...op, properties: { ...op.properties } }
				: op,
		revert
	});
	scheduleFlush(0);
}

function revertOptimistic(failed: QueuedOp[]): void {
	// newest-first, restoring each op's pre-state exactly
	for (let i = failed.length - 1; i >= 0; i--) {
		const { revert } = failed[i];
		for (let j = revert.length - 1; j >= 0; j--) {
			const entry = revert[j];
			if (entry.entity === 'element') {
				if (entry.before === null) _elements.delete(entry.id);
				else _elements.set(entry.id, entry.before);
			} else {
				if (entry.before === null) _relationships.delete(entry.id);
				else _relationships.set(entry.id, entry.before);
			}
		}
	}
}

async function handleFlushError(err: unknown, batch: QueuedOp[]): Promise<void> {
	const message = err instanceof Error ? err.message : String(err);
	if (err instanceof ConflictError) {
		// rev mismatch: someone/something else moved the session model. The
		// optimistic caches can no longer be trusted; freeze mutations and let
		// the UI offer a reload. (resetModelStore is the recovery entry point.)
		cancelFlushTimer();
		_queue = [];
		_error = { kind: 'conflict', message };
		try {
			await refreshSummary();
		} catch {
			// summary refetch is best-effort; the conflict error stands either way
		}
		return;
	}
	// 422 (and network/server errors): the batch did not apply server-side.
	// Roll the caches back to the pre-batch state — including ops queued
	// behind the failed batch, whose optimistic effects may depend on it.
	cancelFlushTimer();
	const trailing = _queue;
	_queue = [];
	revertOptimistic([...batch, ...trailing]);
	_error = {
		kind: err instanceof ValidationError ? 'rejected' : 'error',
		message
	};
}

async function flushLoop(): Promise<void> {
	const generation = _generation;
	_inFlight = true;
	try {
		// drain until empty — but stop when a debounce timer is pending (ops
		// emitted while a batch was in flight keep their debounce window) or
		// the store entered conflict state
		while (_queue.length > 0 && _flushTimer === null && _error?.kind !== 'conflict') {
			const batch = _queue;
			_queue = [];
			try {
				const delta = await modelOpsApi.applyOps(
					_modelRev,
					batch.map((q) => q.op),
					_clientConfig
				);
				if (generation !== _generation) return; // store was reset mid-flight
				applyDelta(delta);
				_undoDepth += 1;
			} catch (err) {
				if (generation !== _generation) return;
				await handleFlushError(err, batch);
				return;
			}
		}
	} finally {
		if (generation === _generation) _inFlight = false;
	}
}

function startFlush(): Promise<void> {
	if (_flushPromise === null) {
		_flushPromise = flushLoop().finally(() => {
			_flushPromise = null;
		});
	}
	return _flushPromise;
}

/**
 * Force every queued op to the server now (cancelling debounce timers) and
 * resolve when the queue is fully drained, a flush error was surfaced, or
 * the store is in conflict state. Save flows await this before serializing.
 */
export async function flushNow(): Promise<void> {
	for (;;) {
		cancelFlushTimer();
		await startFlush();
		// flush errors clear the queue and conflict suspends flushing, so this
		// terminates; a STALE (pre-existing) error must not stop the drain
		if (_queue.length === 0 || _error?.kind === 'conflict') return;
		// ops were emitted while the loop was draining; go around again
	}
}

// ---------------------------------------------------------------------------
// Cache-or-fetch reads
// ---------------------------------------------------------------------------

/** In-flight {@link ensureElement} fetches, so concurrent callers of the same
 * id share one request. Entries are cleared on settle and on resetModelStore.
 * Internal bookkeeping, never read reactively — a plain Map is intentional. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _pendingElementFetches = new Map<string, Promise<Element | null>>();

/**
 * Return the cached element or fetch it (GET /model/elements/{id}) and cache
 * it. Resolves null for unknown ids (404) and for unflushed temp ids that
 * are not in the cache (the server has never heard of those). Concurrent
 * calls for the same uncached id are deduped onto a single request.
 */
export async function ensureElement(id: string): Promise<Element | null> {
	const cached = _elements.get(id);
	if (cached !== undefined) return cached;
	if (isTempId(id)) return null;
	const pending = _pendingElementFetches.get(id);
	if (pending !== undefined) return pending;
	const fetchPromise = (async (): Promise<Element | null> => {
		try {
			const e = await getElement(id, _clientConfig);
			_elements.set(e.id, e);
			return e;
		} catch (err) {
			if (err instanceof NotFoundError) return null;
			throw err;
		}
	})();
	_pendingElementFetches.set(id, fetchPromise);
	try {
		return await fetchPromise;
	} finally {
		_pendingElementFetches.delete(id);
	}
}

/**
 * Cache-only lookup: the backend has no single-relationship GET endpoint
 * (verified against routes/relationships.py), so relationships enter the
 * cache via ops deltas, neighborhoods, and per-element relationship pages.
 * Async for symmetry with {@link ensureElement} and so an endpoint can be
 * slotted in later without changing callers.
 */
export async function ensureRelationship(id: string): Promise<Relationship | null> {
	return _relationships.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Summary / undo / validation / lifecycle
// ---------------------------------------------------------------------------

/** Fetch GET /model/summary and adopt rev / undo depth / issue counts. */
export async function refreshSummary(): Promise<ModelSummary> {
	const s = await modelReadApi.getModelSummary(_clientConfig);
	_summary = s;
	_modelRev = s.model_rev;
	_undoDepth = s.undo_depth;
	_issueCounts = s.issue_counts;
	return s;
}

/** Like {@link refreshSummary} but a no-op when a summary is already loaded. */
export async function loadSummary(): Promise<ModelSummary> {
	return _summary ?? refreshSummary();
}

/**
 * Undo the last accepted op batch (after flushing local edits, so "undo"
 * always targets what the user just did). Resolves false when there is
 * nothing to undo (server 409) or the store is in conflict state.
 */
export async function undo(): Promise<boolean> {
	await flushNow();
	if (_error?.kind === 'conflict') return false;
	try {
		const delta = await modelOpsApi.undoOps(_clientConfig);
		applyDelta(delta);
		_undoDepth = Math.max(0, _undoDepth - 1);
		return true;
	} catch (err) {
		if (err instanceof ConflictError) {
			// empty history — resync counters and report "nothing to undo"
			try {
				await refreshSummary();
			} catch {
				// best-effort
			}
			return false;
		}
		throw err;
	}
}

/**
 * Full validation run over the SESSION model (POST /model/validate with no
 * body — which also seeds the server-side issue store so subsequent ops
 * deltas are exact). Resets `issuesByOwner` and the counts from the result.
 */
export async function validateAll(): Promise<Issue[]> {
	await flushNow();
	const issues = await validateModel(undefined, _clientConfig);
	_issuesByOwner.clear();
	const counts: IssueCounts = {};
	for (const issue of issues) {
		addIssueToOwner(issue);
		counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
	}
	_issueCounts = counts;
	if (_summary !== null) _summary = { ..._summary, issue_counts: counts };
	return issues;
}

/**
 * Drop every cache, counter, queue, and error — for tests and for replacing
 * the model (load/upload flows call this, then refreshSummary()). In-flight
 * responses from before the reset are ignored when they land.
 */
export function resetModelStore(): void {
	_generation += 1;
	cancelFlushTimer();
	_pendingElementFetches.clear();
	_elements.clear();
	_relationships.clear();
	_issuesByOwner.clear();
	_summary = null;
	_modelRev = 0;
	_undoDepth = 0;
	_issueCounts = null;
	_error = null;
	_queue = [];
	_inFlight = false;
}
