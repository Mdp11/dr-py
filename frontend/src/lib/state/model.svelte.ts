import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { ClientConfig } from '$lib/api/client';
import type {
	Element,
	Issue,
	IssueCounts,
	ModelSummary,
	OpsResponse,
	Relationship,
	TreeItem
} from '$lib/api/types';
import { getElement } from '../api/elements';
import { NotFoundError } from '../api/errors';
import * as modelReadApi from '../api/model-read';
import { validateModel } from '../api/validation';
import { mergePatch } from './apply';
import { computeDiff, type Diff } from './diff';
import { isTempId, type Op } from './ops';
import { remapProperties } from './remap';
import { getSelection, select } from './selection.svelte';

/**
 * Staged-commit model store (Spec B).
 *
 * The backend session model is the source of truth; this store holds only
 * the FETCHED SUBSET of it (entities brought in by paged reads, searches,
 * neighborhoods, and commit deltas — never the whole model) plus the
 * model-wide counters that drive headers/status bars.
 *
 * Mutations keep the synchronous-optimistic `emit(op)` contract: the op is
 * applied to the local caches immediately, then pushed onto the STAGED-EDITS
 * buffer (`_queue`) where it is held until an explicit commit. The frontend
 * no longer auto-flushes to POST /model/ops; the staged buffer is reviewed in
 * the commit panel, sent through preview → commit (see `checkout.svelte.ts`),
 * and cleared once the server's canonical post-commit delta is installed.
 * Property updates still coalesce into an already-staged update of the same
 * entity.
 *
 * Undo/discard are CLIENT-SIDE: `popLastStaged` / `revertStagedFor` /
 * `revertAllStaged` replay the per-op journal recorded at emit time to restore
 * the exact pre-op cache state, no server round-trip.
 *
 * The CONFLICT state (`_error.kind === 'conflict'`) is reachable when the
 * caller declares the caches divergent (a stale-rev recovery path): `emit`
 * drops ops while in conflict, and recovery is a full reload (resetModelStore
 * + refetch).
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
/** Issues keyed by OWNER (= issue.target_ids[0]), mirroring the backend
 * ValidationState; fed by ops deltas and full validateAll() runs. */
const _issuesByOwner = new SvelteMap<string, Issue[]>();

let _summary: ModelSummary | null = $state(null);
let _modelRev = $state(0);
/** Bumped only by STRUCTURAL deltas (created/deleted entities, changed
 * relationships) — see {@link getStructureRev}. */
let _structureRev = $state(0);
let _issueCounts: IssueCounts | null = $state(null);
let _error: ModelStoreError | null = $state(null);

let _queue: QueuedOp[] = $state([]);

/** Bumped by resetModelStore so in-flight responses of a dead store are
 * dropped. Reactive: consumers use it as the "a different model was
 * installed" signal (model_rev alone is ambiguous — two freshly loaded
 * models both start at the same rev). */
let _generation = $state(0);

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
 * that were previously recorded missing. */
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

export function getIssuesByOwner(): ReadonlyMap<string, Issue[]> {
	return _issuesByOwner;
}

export function getModelSummary(): ModelSummary | null {
	return _summary;
}

export function getModelRev(): number {
	return _modelRev;
}

/**
 * Structural-change counter for refetch effects (containment tree, incident
 * relationships, neighborhood graph). Unlike `model_rev` — which bumps on
 * EVERY acked batch, including debounced property-only updates while the user
 * types — this bumps only when a delta creates or deletes entities or touches
 * relationships, i.e. when paged read results can actually have changed
 * shape. Track this (+ `getModelGeneration()`) instead of `getModelRev()` to
 * avoid a refetch fan-out per keystroke ack.
 */
export function getStructureRev(): number {
	return _structureRev;
}

/** Bumps on every {@link resetModelStore} — i.e. whenever a different model
 * (or no model) is installed. Refresh effects track this + `getModelRev()`. */
export function getModelGeneration(): number {
	return _generation;
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
		// A just-created id may have a stale lite skeleton from before it existed
		// as a full element; the canonical id is seeded as FULL by this same
		// delta, so drop the temp id's lite entry unconditionally.
		_treeItems.delete(tempId);
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
 * Queue-aware upsert: a changed entity that still has a queued op is NOT
 * overwritten with the (now-stale) server state — see the comment at the
 * upsert loop. This prevents an in-flight batch's ack from reverting newer
 * optimistic edits the user is still typing; the queued op re-acks the final
 * value on the next flush.
 */
export function applyDelta(d: OpsResponse): void {
	// Structural = anything that can change paged read results (containment
	// levels, incident-relationship pages, neighborhoods): entity creation
	// (acked creates always carry a temp-id -> canonical-id mapping), entity
	// deletion, or any relationship change. Property-only element acks (the
	// per-keystroke debounced updates) deliberately do NOT count. Computed
	// BEFORE the cache upserts so "element we have never seen" still detects
	// creations that arrive without an id_map (e.g. apply-cr deltas).
	const structural =
		Object.keys(d.id_map).length > 0 ||
		d.changed_relationships.length > 0 ||
		d.deleted_element_ids.length > 0 ||
		d.deleted_relationship_ids.length > 0 ||
		d.changed_elements.some((e) => !_elements.has(e.id));

	if (Object.keys(d.id_map).length > 0) {
		remapCaches(d.id_map);
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
		if (hasQueuedOpFor(r.id)) continue;
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

	for (const owner of d.issues_removed_owner_ids) _issuesByOwner.delete(owner);
	for (const issue of d.issues_added) addIssueToOwner(issue);

	_modelRev = d.model_rev;
	if (structural) _structureRev += 1;
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

/**
 * Apply `op` optimistically and append it to the STAGED-EDITS buffer.
 *
 * Spec B: edits no longer auto-flush. `emit` applies the op to the local
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
// Staged-edits surface (Spec B): the queue is the local-edit buffer held until
// commit. No auto-flush. Discard/undo replay the per-op journal recorded at
// emit time; commit drops the buffer (clearStaged) after applyDelta installs
// the server's canonical post-commit state.
// ---------------------------------------------------------------------------

function queuedTargetId(q: QueuedOp): string {
	const op = q.op;
	return op.kind === 'create_element' || op.kind === 'create_relationship' ? op.temp_id : op.id;
}

export function getStagedOps(): Op[] {
	return _queue.map((q) => q.op);
}

export function getStagedOpsFor(id: string): Op[] {
	return _queue.filter((q) => queuedTargetId(q) === id).map((q) => q.op);
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

export function setModelError(e: ModelStoreError | null): void {
	_error = e;
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
	const pending = _pendingElementFetches.get(id);
	if (pending !== undefined) return pending;
	const fetchPromise = (async (): Promise<Element | null> => {
		try {
			const e = await getElement(id, _clientConfig);
			_elements.set(e.id, e);
			_missingElementIds.delete(e.id);
			return e;
		} catch (err) {
			if (err instanceof NotFoundError) {
				// Record the confirmed miss so consumers (Inspector/DetailView) can
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
		// skip ids already cached, temp (server never heard of them), already in
		// flight via either fetch path, or already confirmed missing (re-requesting
		// a dangling placement on every window recompute would hammer the endpoint).
		if (
			_elements.has(id) ||
			isTempId(id) ||
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
			const fetched = await modelReadApi.getElementsBatch(chunk, _clientConfig);
			for (const e of fetched) _elements.set(e.id, e);
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
			const fetched = await modelReadApi.getTreeItemsBatch(chunk, _clientConfig);
			seedTreeItems(fetched);
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

// ---------------------------------------------------------------------------
// Summary / validation / lifecycle
// ---------------------------------------------------------------------------

/** Fetch GET /model/summary and adopt rev / issue counts. */
export async function refreshSummary(): Promise<ModelSummary> {
	const s = await modelReadApi.getModelSummary(_clientConfig);
	_summary = s;
	_modelRev = s.model_rev;
	_issueCounts = s.issue_counts;
	return s;
}

/** Like {@link refreshSummary} but a no-op when a summary is already loaded. */
export async function loadSummary(): Promise<ModelSummary> {
	return _summary ?? refreshSummary();
}

/**
 * Adopt a summary the caller already holds (load/upload responses return one)
 * without an extra GET /model/summary round-trip. Load flows call
 * `resetModelStore()` first, then this.
 */
export function adoptSummary(s: ModelSummary): void {
	_summary = s;
	_modelRev = s.model_rev;
	_issueCounts = s.issue_counts;
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

/** Relationship counterpart of {@link seedElements}; same guards. */
export function seedRelationships(rels: readonly Relationship[]): void {
	for (const r of rels) {
		if (hasQueuedOpFor(r.id)) continue;
		const cached = _relationships.get(r.id);
		if (cached !== undefined && cached.rev > r.rev) continue;
		_relationships.set(r.id, r);
	}
}

/**
 * Full validation run that INCLUDES staged (uncommitted) edits. When the staged
 * buffer is non-empty, the staged ops + current rev are sent to POST
 * /model/validate, which applies them against the committed model, validates,
 * rolls back, and tags each issue's origin (on_server / uncommitted / resolved).
 * With an empty buffer it is a plain committed-model validation (all on_server).
 * Resets `issuesByOwner` and the counts from the result.
 *
 * Resolved issues are returned in the result array but intentionally excluded
 * from `_issuesByOwner` and the counts (they are not active problems); IssuesPanel
 * reads the full returned array via `getIssues()`, so it still renders them.
 */
export async function validateAll(): Promise<Issue[]> {
	const staged = getStagedOps();
	const options = staged.length > 0 ? { ops: staged, baseRev: _modelRev } : undefined;
	const issues = await validateModel(options, _clientConfig);
	_issuesByOwner.clear();
	const counts: IssueCounts = {};
	for (const issue of issues) {
		// resolved issues are not active problems — keep them out of the counts
		if (issue.origin === 'resolved') continue;
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
	_pendingElementFetches.clear();
	_inFlightBatchIds.clear();
	_missingElementIds.clear();
	_elements.clear();
	_treeItems.clear();
	_relationships.clear();
	_issuesByOwner.clear();
	_summary = null;
	_modelRev = 0;
	_structureRev = 0;
	_issueCounts = null;
	_error = null;
	_queue = [];
}
