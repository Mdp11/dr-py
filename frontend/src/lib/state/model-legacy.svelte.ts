import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { Element, OpsResponse, Relationship, TreeItem } from '$lib/api/types';
import { getElement } from '../api/elements';
import { NotFoundError } from '../api/errors';
import * as modelReadApi from '../api/model-read';
import { mergePatch } from './apply';
import { computeDiff, type Diff } from './diff';
import { remapVisitIds } from './inspection-history.svelte';
import { remapCaches, remapElement, remapRelationship } from './model-caches';
import {
	applyDeltaShared,
	getClientConfig,
	getModelError,
	setClientConfig
} from './model-shared.svelte';
import { isTempId, type ModelOp } from './ops';
import { nameProp } from '$lib/util/element-name';
import { remapProperties } from './remap';
import { getSelection, select } from './selection.svelte';

/**
 * Legacy entity half of the staged-commit model store — frozen: this is
 * today's code, moved verbatim, and stays the server-mode fallback behind the
 * `staging` switch (see `model.svelte.ts`, the facade). Model-wide counters
 * and issues live in `model-shared.svelte.ts`; this file holds only the
 * FETCHED SUBSET of the model (entities brought in by paged reads, searches,
 * neighborhoods, and commit deltas — never the whole model) and the staged
 * (uncommitted) edit buffer.
 *
 * Mutations keep the synchronous-optimistic `emit(op)` contract: the op is
 * applied to the local caches immediately, then pushed onto the STAGED-EDITS
 * buffer (`_queue`) where it is held until an explicit commit. The frontend
 * does not auto-flush to POST /model/ops; the staged buffer is reviewed in
 * the commit panel, sent through preview → commit (see `checkout.svelte.ts`),
 * and cleared once the server's canonical post-commit delta is installed.
 * Property updates still coalesce into an already-staged update of the same
 * entity.
 *
 * Undo/discard are CLIENT-SIDE: `popLastStaged` / `revertStagedFor` /
 * `revertAllStaged` replay the per-op journal recorded at emit time to restore
 * the exact pre-op cache state, no server round-trip.
 *
 * The CONFLICT state (`_error.kind === 'conflict'`, in the shared half) is
 * reachable when the caller declares the caches divergent (a stale-rev
 * recovery path): `emit` drops ops while in conflict, and recovery is a full
 * reload (resetModelStore + refetch).
 *
 * Cache policy for deltas: ALL changed entities in a delta are upserted into
 * the caches (deltas are small — O(batch + cascade), not O(model)), so
 * anything the user just touched is guaranteed fresh; deleted ids are
 * dropped; temp ids are remapped to canonical ids everywhere (cache keys,
 * relationship endpoints, ref-shaped property values, staged ops and their
 * revert journals).
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Restores one cache slot to its pre-op state (null = entry did not exist). */
type RevertEntry =
	| { entity: 'element'; id: string; before: Element | null }
	| { entity: 'relationship'; id: string; before: Relationship | null };

interface QueuedOp {
	op: ModelOp;
	revert: RevertEntry[];
}

const _elements = new SvelteMap<string, Element>();
const _relationships = new SvelteMap<string, Relationship>();
/** Element ids the server has confirmed do not exist: requested in a
 * {@link ensureElements} batch but omitted from the response (the batch
 * endpoint drops unknown/deleted ids). Reactive so the view tree can drop a
 * dangling folder placement once it is *known* missing — as opposed to merely
 * not fetched yet, which must keep rendering a skeleton. Cleared on store reset
 * and un-marked whenever the id reappears (seed / delta / single fetch). */
const _missingElementIds = new SvelteSet<string>();
/** Lite display cache for tree rows the user is only VIEWING (id →
 * {type_name, display_name, child_count}). Fed by the by-id tree-items batch
 * and by containment-level pages. Deliberately separate from `_elements`: the
 * moment an element is edited/created/arrives in a delta its FULL entry lands
 * in `_elements`, which `getTreeElements()` prefers — so this cache never needs
 * per-field patching, only eviction on delete and child_count refresh on a
 * structural change. */
const _treeItems = new SvelteMap<string, TreeItem>();

let _queue: QueuedOp[] = $state([]);

/** Test/dev hook: ClientConfig forwarded to every API call this store makes.
 * The single source of truth lives in the shared half (`refreshSummary` and
 * `refetchIssues` forward the same value); this is the public setter's home. */
export const setModelApiConfig = setClientConfig;

// ---------------------------------------------------------------------------
// Read surface
// ---------------------------------------------------------------------------

export function getCachedElements(): ReadonlyMap<string, Element> {
	return _elements;
}

/** Ids a by-id batch fetch confirmed missing (see {@link _missingElementIds}). */
export function getMissingElementIds(): ReadonlySet<string> {
	return _missingElementIds;
}

export function getCachedTreeItems(): ReadonlyMap<string, TreeItem> {
	return _treeItems;
}

/**
 * The map the sidebar tree renders from: full `_elements` (loaded on selection
 * / arrived via deltas) take precedence; every other cached row appears as a
 * MINIMAL element synthesized from its lite `_treeItems` entry — just enough
 * for `elementDisplayName` (name prop or id), the type filter (`type_name`),
 * and presence checks (`map.has(id)`). The lite cache thus accelerates display
 * without ever masquerading in `_elements` itself (the Inspector still only
 * sees genuinely-loaded full elements).
 */
export function getTreeElements(): Map<string, Element> {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const out = new Map<string, Element>();
	for (const [id, t] of _treeItems) {
		const properties = t.display_name && t.display_name !== id ? { name: t.display_name } : {};
		out.set(id, { id, type_name: t.type_name, properties, rev: 0 });
	}
	for (const [id, e] of _elements) out.set(id, e); // full wins
	return out;
}

/** Upsert lite rows (from containment pages / by-id batch) and un-mark any
 * that are currently recorded missing. */
export function seedTreeItems(items: readonly TreeItem[]): void {
	for (const t of items) {
		_treeItems.set(t.id, t);
		_missingElementIds.delete(t.id);
	}
}

/** Evict lite rows so a subsequent ensureTreeItems refetches them (used after a
 * structural change that may have altered display_name / child_count). */
export function dropTreeItems(ids: readonly string[]): void {
	for (const id of ids) {
		_treeItems.delete(id);
		_missingElementIds.delete(id);
	}
}

export function getCachedRelationships(): ReadonlyMap<string, Relationship> {
	return _relationships;
}

// ---------------------------------------------------------------------------
// Delta application
// ---------------------------------------------------------------------------

function remapOp(op: ModelOp, idMap: Record<string, string>): ModelOp {
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

/** Remap the queued-but-unflushed ops and their revert journals: the server
 * resolves temp ids only WITHIN a batch, so later batches must carry
 * canonical ids. */
function remapQueue(idMap: Record<string, string>): void {
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

/**
 * Splice an {@link OpsResponse} delta into the store: remap temp ids, upsert
 * changed entities, drop deleted ids, and apply the shared half (rev, issue
 * delta, summary patch, structure rev). Queue-aware upsert: a changed entity
 * that still has a queued op is NOT overwritten with the (now-stale) server
 * state — see the comment at the upsert loop. This prevents an in-flight
 * batch's ack from reverting newer optimistic edits the user is still typing;
 * the queued op re-acks the final value on the next flush.
 */
export function applyDelta(d: OpsResponse): void {
	// Computed BEFORE the cache upserts (and the id-map remap below) so
	// "element we have never seen" still detects creations that arrive
	// without an id_map (e.g. apply-cr deltas): applyDeltaShared's structural
	// formula asks `_elements.has` in its PRE-delta state.
	applyDeltaShared(d, (id) => _elements.has(id));

	if (Object.keys(d.id_map).length > 0) {
		remapCaches(_elements, _relationships, _treeItems, d.id_map);
		remapQueue(d.id_map);
		// Rewrite the inspection history BEFORE the selection re-point below:
		// the re-point goes through select(), whose pushVisit then finds the
		// canonical id already at the cursor and dedups (no duplicate entry).
		remapVisitIds(d.id_map);
		// keep the global selection pointing at the same entity across the
		// temp-id -> canonical-id rename (the old architecture kept temp ids
		// alive until file save; the delta protocol renames on first flush ack)
		const sel = getSelection();
		if (sel !== null && d.id_map[sel.id] !== undefined) {
			select({ kind: sel.kind, id: d.id_map[sel.id] });
		}
	}

	// Upsert the server's authoritative version of changed entities — UNLESS the
	// entity still has a queued op. While the user types fast, a batch carrying
	// an earlier value can be in flight while newer keystrokes are already
	// queued; clobbering with the now-stale server value reverts the input
	// mid-typing (the "text jumps back then forward" flicker, and the
	// controlled-input reset that makes typing feel sluggish). Skipping the
	// upsert keeps the optimistic value; the queued op flushes and re-acks the
	// final value once the user pauses. Mirrors the guard in seedElements().
	for (const e of d.changed_elements) {
		if (hasQueuedOpFor(e.id)) continue;
		_elements.set(e.id, e);
		_missingElementIds.delete(e.id); // a (re)created/restored id is no longer missing
	}
	for (const r of d.changed_relationships) {
		// The cascade check matters for PEER deltas only: a peer commit touching
		// a relationship my staged delete_element cascade-removed must not
		// resurrect it (my commit deletes it server-side anyway). Own-commit acks
		// clear the staged buffer before calling applyDelta, so both guards are
		// inert there.
		if (hasQueuedOpFor(r.id) || isStagedDeletedRelationship(r.id)) continue;
		_relationships.set(r.id, r);
	}
	for (const id of d.deleted_element_ids) {
		_elements.delete(id);
		_treeItems.delete(id);
		// A deleted id is confirmed-missing: a selection still pointing at it must
		// render "not found" (not a loading state), and the view tree can drop
		// dangling placements. Re-create/restore un-marks it (upsert loop above).
		_missingElementIds.add(id);
	}
	for (const id of d.deleted_relationship_ids) _relationships.delete(id);
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
function applyOptimistic(op: ModelOp): RevertEntry[] {
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
	op: ModelOp
): op is Extract<ModelOp, { properties_patch: Record<string, unknown> }> {
	return op.kind === 'update_element' || op.kind === 'update_relationship';
}

/**
 * Apply `op` optimistically and append it to the STAGED-EDITS buffer.
 *
 * Edits do not auto-flush. `emit` applies the op to the local
 * caches synchronously (they reflect it before this returns), records the
 * journal entries that restore the pre-op state, and pushes the op onto the
 * staged buffer (`_queue`) where it is held until an explicit commit. Property
 * updates still coalesce into an already-queued update of the same entity.
 *
 * In CONFLICT state the op is dropped entirely (not applied, not staged):
 * the caches are already declared divergent, so staging would only leave the
 * buffer in a divergent state. Recovery is a full reload (resetModelStore +
 * refetch).
 */
export function emit(op: ModelOp): void {
	if (getModelError()?.kind === 'conflict') return;

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
			return;
		}
		_queue.push({ op: { ...op, properties_patch: { ...op.properties_patch } }, revert });
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

// ---------------------------------------------------------------------------
// Staged-edits surface: the queue is the local-edit buffer held until
// commit. No auto-flush. Discard/undo replay the per-op journal recorded at
// emit time; commit drops the buffer (clearStaged) after applyDelta installs
// the server's canonical post-commit state.
// ---------------------------------------------------------------------------

function queuedTargetId(q: QueuedOp): string {
	const op = q.op;
	return op.kind === 'create_element' || op.kind === 'create_relationship' ? op.temp_id : op.id;
}

export function getStagedOps(): ModelOp[] {
	return _queue.map((q) => q.op);
}

export function getStagedOpsFor(id: string): ModelOp[] {
	return _queue.filter((q) => queuedTargetId(q) === id).map((q) => q.op);
}

/**
 * The display name a STAGED (uncommitted) edit gives `id`, or `undefined`
 * when no staged op touches its name. Cells that render a server-provided
 * `display_name` (table scope/element cells) overlay this so a staged rename
 * shows up everywhere at once, not only in value cells. Newest-first, same
 * rule as ValueCell's staged overlay; a staged edit that CLEARS the name
 * returns the id itself (matching `elementDisplayName`'s fallback).
 */
export function getStagedNameOverride(id: string): string | undefined {
	for (let i = _queue.length - 1; i >= 0; i--) {
		const q = _queue[i];
		if (queuedTargetId(q) !== id) continue;
		const op = q.op;
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
	return _queue.length;
}

export function hasStagedOps(): boolean {
	return _queue.length > 0;
}

/** Revert and remove every staged op targeting `id` (per-element discard).
 * Reverts newest-first across the whole buffer slice for `id` so cascades
 * (e.g. a delete_element that also removed incident relationships) restore. */
export function revertStagedFor(id: string): void {
	const remove = _queue.filter((q) => queuedTargetId(q) === id);
	if (remove.length === 0) return;
	revertOptimistic(remove);
	_queue = _queue.filter((q) => queuedTargetId(q) !== id);
}

/** Resolve a queued relationship op's endpoints: create ops carry them
 * inline; update/delete ops resolve via the cache, falling back to the op's
 * own journal snapshot (a staged delete removed the rel from the cache, but
 * its pre-state is journaled). Returns null for element ops and rels that
 * were never cached (endpoints unknowable client-side). */
function queuedRelEndpoints(q: QueuedOp): { source_id: string; target_id: string } | null {
	const op = q.op;
	if (op.kind === 'create_relationship') {
		return { source_id: op.source_id, target_id: op.target_id };
	}
	if (op.kind !== 'update_relationship' && op.kind !== 'delete_relationship') return null;
	const cached = _relationships.get(op.id);
	if (cached !== undefined) return { source_id: cached.source_id, target_id: cached.target_id };
	for (const entry of q.revert) {
		if (entry.entity === 'relationship' && entry.id === op.id && entry.before !== null) {
			return { source_id: entry.before.source_id, target_id: entry.before.target_id };
		}
	}
	return null;
}

/** Cascade revert for the "Staged elements" section: revert and remove every
 * staged op targeting `id` PLUS every staged relationship op whose source or
 * target is `id`. The relationship cascade is mandatory for created elements
 * — a surviving staged rel referencing the reverted temp id would 422 the
 * eventual commit with an unknown id. Side effect accepted by design: this
 * can demote the OTHER endpoint of a removed staged rel from "modified" back
 * to untouched. Corollary for created elements: reverting one also removes the
 * staged containment relationship to any staged-created CHILD, leaving that
 * child staged with no parent — which surfaces at commit as a containment
 * conformance issue rather than silently vanishing. */
export function revertStagedForElement(id: string): void {
	const remove = _queue.filter((q) => {
		if (queuedTargetId(q) === id) return true;
		const ep = queuedRelEndpoints(q);
		return ep !== null && (ep.source_id === id || ep.target_id === id);
	});
	if (remove.length === 0) return;
	revertOptimistic(remove);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const removeSet = new Set(remove);
	_queue = _queue.filter((q) => !removeSet.has(q));
}

export function revertAllStaged(): void {
	if (_queue.length === 0) return;
	revertOptimistic(_queue);
	_queue = [];
}

/** Client-side undo: revert the last staged op. Returns false if empty. */
export function popLastStaged(): boolean {
	const last = _queue[_queue.length - 1];
	if (last === undefined) return false;
	revertOptimistic([last]);
	_queue = _queue.slice(0, -1);
	return true;
}

/** Drop the buffer WITHOUT reverting caches — the commit flow calls this first
 * and then applyDelta installs the server's canonical post-commit state over
 * the optimistic caches. */
export function clearStaged(): void {
	_queue = [];
}

/** A diff of the staged edits, for the commit-review panel and badge. Baseline
 * = each touched entity's earliest journaled `before` (absent ⇒ created);
 * working = its current cache value (absent ⇒ deleted). Reuses computeDiff. */
export function getStagedDiff(): Diff {
	// Ephemeral computation scratch, rebuilt on every call and never read
	// reactively — plain Map/Set are intentional (not reactive store state).
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const baseElements = new Map<string, Element>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const baseRels = new Map<string, Relationship>();
	for (const q of _queue) {
		for (const r of q.revert) {
			if (r.before === null) continue;
			if (r.entity === 'element') {
				if (!baseElements.has(r.id)) baseElements.set(r.id, r.before);
			} else if (!baseRels.has(r.id)) baseRels.set(r.id, r.before);
		}
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const touched = new Set<string>();
	for (const q of _queue) touched.add(queuedTargetId(q));
	// include ids that only appear as journal targets (cascade-deleted rels)
	for (const id of baseElements.keys()) touched.add(id);
	for (const id of baseRels.keys()) touched.add(id);

	const workingElements: Element[] = [];
	const workingRels: Relationship[] = [];
	for (const id of touched) {
		const e = _elements.get(id);
		if (e !== undefined) workingElements.push(e);
		const r = _relationships.get(id);
		if (r !== undefined) workingRels.push(r);
	}
	return computeDiff(
		{ elements: [...baseElements.values()], relationships: [...baseRels.values()] } as never,
		{ elements: workingElements, relationships: workingRels }
	);
}

export function getStagedChangeCount(): number {
	const c = getStagedDiff().counts;
	return c.added + c.modified + c.deleted;
}

// ---------------------------------------------------------------------------
// Cache-or-fetch reads
// ---------------------------------------------------------------------------

/** In-flight {@link ensureElement} fetches, so concurrent callers of the same
 * id share one request. Entries are cleared on settle and on resetModelStore.
 * Internal bookkeeping, never read reactively — a plain Map is intentional. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _pendingElementFetches = new Map<string, Promise<Element | null>>();

/** Ids currently being fetched by an {@link ensureElements} batch, so
 * overlapping windows do not double-request the same id. Cleared on settle
 * and on resetModelStore. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const _inFlightBatchIds = new Set<string>();

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
	// Locally deleted: the server would still return it (the delete is only
	// staged), but caching that response would resurrect the element and erase
	// its row from the staged diff. Not marked confirmed-missing — the server
	// never said it doesn't exist. See isStagedDeleted.
	if (isStagedDeleted(id)) return null;
	const pending = _pendingElementFetches.get(id);
	if (pending !== undefined) return pending;
	const fetchPromise = (async (): Promise<Element | null> => {
		try {
			const e = await getElement(id, getClientConfig());
			// Deleted locally while the fetch was in flight — same rule as above.
			if (isStagedDeleted(e.id)) return null;
			_elements.set(e.id, e);
			_missingElementIds.delete(e.id);
			return e;
		} catch (err) {
			if (err instanceof NotFoundError) {
				// Record the confirmed miss so consumers (e.g. the Inspector) can
				// distinguish "fetch in flight" (show loading) from "the server said
				// this id does not exist" (show not-found).
				_missingElementIds.add(id);
				return null;
			}
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
 * Batched cache-or-fetch for many ids: fetches only the uncached, non-temp,
 * not-already-in-flight ids via POST /model/elements/batch (chunked at
 * READ_PAGE_LIMIT) and seeds the cache. The window renderer calls this with
 * the on-screen id slice; unknown ids are omitted by the server and simply
 * stay uncached. On a mid-chunk failure, earlier chunks stay seeded (a read
 * fill-path never rolls back) and the in-flight marks are still released; a
 * retry simply re-fetches whatever is still missing.
 */
export async function ensureElements(ids: readonly string[]): Promise<void> {
	const want: string[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		// skip ids already cached, temp (server never heard of them), staged-
		// deleted (locally deleted; fetching would resurrect — see
		// isStagedDeleted), already in flight via either fetch path, or already
		// confirmed missing (re-requesting a dangling placement on every window
		// recompute would hammer the endpoint).
		if (
			_elements.has(id) ||
			isTempId(id) ||
			isStagedDeleted(id) ||
			_missingElementIds.has(id) ||
			_inFlightBatchIds.has(id) ||
			_pendingElementFetches.has(id)
		)
			continue;
		want.push(id);
	}
	if (want.length === 0) return;
	for (const id of want) _inFlightBatchIds.add(id);
	try {
		for (let i = 0; i < want.length; i += modelReadApi.READ_PAGE_LIMIT) {
			const chunk = want.slice(i, i + modelReadApi.READ_PAGE_LIMIT);
			const fetched = await modelReadApi.getElementsBatch(chunk, getClientConfig());
			// The staged-delete re-check covers deletes staged while the chunk
			// was in flight (same rule as ensureElement's post-await guard).
			for (const e of fetched) if (!isStagedDeleted(e.id)) _elements.set(e.id, e);
			// Ids the server omitted from this chunk do not exist (deleted/unknown):
			// record them so the view tree drops the dangling placement instead of
			// holding a skeleton row forever. A later create/restore of the same id
			// un-marks it (seedElements / applyDelta).
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const returned = new Set(fetched.map((e) => e.id)); // ephemeral membership check
			for (const id of chunk) if (!returned.has(id)) _missingElementIds.add(id);
		}
	} finally {
		for (const id of want) _inFlightBatchIds.delete(id);
	}
}

/**
 * Fetch the lite tree-row projection for `ids` (POST /model/elements/tree-items,
 * chunked at READ_PAGE_LIMIT) into `_treeItems`. Mirrors {@link ensureElements}:
 * dedups against both caches, temp ids, the shared in-flight set, and the
 * confirmed-missing set; ids the server omits are recorded missing so the tree
 * drops a dangling placement instead of holding a skeleton forever. Skips ids
 * already in `_elements` (a full entry already renders that row).
 */
export async function ensureTreeItems(ids: readonly string[]): Promise<void> {
	const want: string[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		if (
			_elements.has(id) ||
			_treeItems.has(id) ||
			isTempId(id) ||
			isStagedDeleted(id) ||
			_missingElementIds.has(id) ||
			_inFlightBatchIds.has(id) ||
			_pendingElementFetches.has(id)
		)
			continue;
		want.push(id);
	}
	if (want.length === 0) return;
	for (const id of want) _inFlightBatchIds.add(id);
	try {
		for (let i = 0; i < want.length; i += modelReadApi.READ_PAGE_LIMIT) {
			const chunk = want.slice(i, i + modelReadApi.READ_PAGE_LIMIT);
			const fetched = await modelReadApi.getTreeItemsBatch(chunk, getClientConfig());
			// mid-flight staged deletes re-checked, as in ensureElements
			seedTreeItems(fetched.filter((t) => !isStagedDeleted(t.id)));
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const returned = new Set(fetched.map((t) => t.id));
			for (const id of chunk) if (!returned.has(id)) _missingElementIds.add(id);
		}
	} finally {
		for (const id of want) _inFlightBatchIds.delete(id);
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

/**
 * True when a staged (uncommitted) `delete_element` targets `id`. Such an id
 * is LOCALLY DELETED: absent from the cache while the server still returns it,
 * so cache-or-fetch reads must not fetch it back — re-inserting it would
 * silently erase the delete from the staged diff (badge + DiffDrawer) and
 * re-render the element everywhere while the queued delete still commits.
 * Exported for the Inspector, which renders a staged-deleted selection as
 * not-found rather than loading-forever.
 */
export function isStagedDeleted(id: string): boolean {
	return _queue.some((q) => q.op.kind === 'delete_element' && q.op.id === id);
}

/**
 * Relationship counterpart of {@link isStagedDeleted}: a staged
 * `delete_relationship` targeting `id`, OR a staged `delete_element` whose
 * optimistic cascade removed `id`. The cascade case is the subtle one — those
 * relationships have NO queued op of their own (only the delete_element's
 * journal entries record them), so `hasQueuedOpFor` misses them and every
 * server read that includes them (incident-relationship pages, neighborhoods,
 * peer-commit deltas) would resurrect them without this check.
 */
function isStagedDeletedRelationship(id: string): boolean {
	return _queue.some(
		(q) =>
			(q.op.kind === 'delete_relationship' && q.op.id === id) ||
			(q.op.kind === 'delete_element' &&
				q.revert.some((r) => r.entity === 'relationship' && r.id === id))
	);
}

/** True when any queued (unflushed) op targets `id` — such an entity's cache
 * entry is optimistic local state that read results must not clobber. */
function hasQueuedOpFor(id: string): boolean {
	for (const q of _queue) {
		const op = q.op;
		if (op.kind === 'create_element' || op.kind === 'create_relationship') {
			if (op.temp_id === id) return true;
		} else if (op.id === id) {
			return true;
		}
	}
	return false;
}

/**
 * Upsert elements fetched by paged reads (search pages, containment levels,
 * neighborhoods) into the cache so `getCachedElements()` consumers see them.
 *
 * Guards against clobbering newer local state: entities targeted by a queued
 * op keep their optimistic value, and a cached entity with a HIGHER rev than
 * the incoming one (a read raced an ops ack) is kept.
 */
export function seedElements(els: readonly Element[]): void {
	for (const e of els) {
		if (hasQueuedOpFor(e.id)) continue;
		const cached = _elements.get(e.id);
		if (cached !== undefined && cached.rev > e.rev) continue;
		_elements.set(e.id, e);
		_missingElementIds.delete(e.id); // it exists after all
	}
}

/** Relationship counterpart of {@link seedElements}; same guards, plus the
 * cascade-delete guard (hasQueuedOpFor cannot see a relationship a staged
 * delete_element cascade removed — see isStagedDeletedRelationship). */
export function seedRelationships(rels: readonly Relationship[]): void {
	for (const r of rels) {
		if (hasQueuedOpFor(r.id) || isStagedDeletedRelationship(r.id)) continue;
		const cached = _relationships.get(r.id);
		if (cached !== undefined && cached.rev > r.rev) continue;
		_relationships.set(r.id, r);
	}
}

/**
 * Drop every cache, counter and queue — the entity half's share of
 * `resetModelStore()` (the facade, which also resets the shared half). See
 * that function for why the Validate overlay must go too.
 */
export function resetLegacyStore(): void {
	_pendingElementFetches.clear();
	_inFlightBatchIds.clear();
	_missingElementIds.clear();
	_elements.clear();
	_treeItems.clear();
	_relationships.clear();
	_queue = [];
}
