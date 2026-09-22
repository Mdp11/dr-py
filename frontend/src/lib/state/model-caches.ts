import type { Element, Relationship, TreeItem } from '$lib/api/types';
import { remapProperties } from './remap';

/**
 * Pure id-remap helpers shared by both entity halves' `applyDelta`: after a
 * commit resolves temp ids to canonical ones, cached entries keyed by (or
 * referencing) a temp id must move/rewrite before anything reads them again.
 */

/**
 * Change-tracking (like {@link remapProperties}): returns the ORIGINAL object
 * when nothing referenced a mapped id, so callers can skip the cache write.
 */
export function remapElement(e: Element, idMap: Record<string, string>): Element {
	const id = idMap[e.id] ?? e.id;
	const properties = remapProperties(e.properties, idMap);
	if (id === e.id && properties === e.properties) return e;
	return { ...e, id, properties };
}

/** Change-tracking; see {@link remapElement}. */
export function remapRelationship(r: Relationship, idMap: Record<string, string>): Relationship {
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

/**
 * Move/rewrite the three entity caches after an id map resolves temp ids to
 * canonical ones: relocate the cache entries keyed by a mapped id, then
 * rewrite every remaining entity's own references (relationship endpoints,
 * ref-shaped property values). Identity-preserving on the second pass: an
 * entity that referenced no mapped id keeps its object and skips the
 * `Map.set`, so subscriptions don't churn O(cache).
 */
export function remapCaches(
	elements: Map<string, Element>,
	relationships: Map<string, Relationship>,
	treeItems: Map<string, TreeItem>,
	idMap: Record<string, string>
): void {
	// 1. move entries keyed by a temp id to their canonical key
	for (const [tempId, canonicalId] of Object.entries(idMap)) {
		const e = elements.get(tempId);
		if (e !== undefined) {
			elements.delete(tempId);
			elements.set(canonicalId, { ...e, id: canonicalId });
		}
		// A just-created id may have a stale lite skeleton from before it existed
		// as a full element; the canonical id is seeded as FULL by this same
		// delta, so drop the temp id's lite entry unconditionally.
		treeItems.delete(tempId);
		const r = relationships.get(tempId);
		if (r !== undefined) {
			relationships.delete(tempId);
			relationships.set(canonicalId, { ...r, id: canonicalId });
		}
	}
	// 2. remap references held INSIDE cached entities (endpoints + ref props)
	for (const [id, e] of elements) {
		const next = remapElement(e, idMap);
		if (next !== e) elements.set(id, next);
	}
	for (const [id, r] of relationships) {
		const next = remapRelationship(r, idMap);
		if (next !== r) relationships.set(id, next);
	}
}
