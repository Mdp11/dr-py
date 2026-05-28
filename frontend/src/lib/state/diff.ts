import type { Element, ModelOut, Relationship } from '$lib/api/types';
import type { Snapshot } from './ops';

export type EntityStatus = 'unchanged' | 'added' | 'modified' | 'deleted';

export interface EntityDiff {
	id: string;
	status: EntityStatus;
	before?: Element | Relationship;
	after?: Element | Relationship;
	modifiedFields?: string[];
}

export interface Diff {
	elements: EntityDiff[];
	relationships: EntityDiff[];
	counts: { added: number; modified: number; deleted: number };
}

/**
 * Compute the diff between the baseline ModelOut and the working Snapshot.
 *
 * Only entries whose status is 'added', 'modified', or 'deleted' are
 * returned; 'unchanged' entries are filtered out.
 */
export function computeDiff(baseline: ModelOut | null, working: Snapshot): Diff {
	const baseElements: Element[] = baseline ? baseline.elements : [];
	const baseRels: Relationship[] = baseline ? baseline.relationships : [];

	const elements = diffElements(baseElements, working.elements);
	const relationships = diffRelationships(baseRels, working.relationships);

	const counts = { added: 0, modified: 0, deleted: 0 };
	for (const e of elements) bumpCount(counts, e.status);
	for (const r of relationships) bumpCount(counts, r.status);

	return { elements, relationships, counts };
}

function bumpCount(
	counts: { added: number; modified: number; deleted: number },
	status: EntityStatus
): void {
	if (status === 'added') counts.added++;
	else if (status === 'modified') counts.modified++;
	else if (status === 'deleted') counts.deleted++;
}

function diffElements(base: Element[], working: Element[]): EntityDiff[] {
	const baseById = indexById(base);
	const workById = indexById(working);
	const out: EntityDiff[] = [];

	for (const w of working) {
		const b = baseById.get(w.id);
		if (!b) {
			out.push({ id: w.id, status: 'added', after: w });
			continue;
		}
		const modifiedFields = elementModifiedFields(b, w);
		if (modifiedFields.length > 0) {
			out.push({ id: w.id, status: 'modified', before: b, after: w, modifiedFields });
		}
	}
	for (const b of base) {
		if (!workById.has(b.id)) {
			out.push({ id: b.id, status: 'deleted', before: b });
		}
	}
	return out;
}

function diffRelationships(base: Relationship[], working: Relationship[]): EntityDiff[] {
	const baseById = indexById(base);
	const workById = indexById(working);
	const out: EntityDiff[] = [];

	for (const w of working) {
		const b = baseById.get(w.id);
		if (!b) {
			out.push({ id: w.id, status: 'added', after: w });
			continue;
		}
		const modifiedFields = relationshipModifiedFields(b, w);
		if (modifiedFields.length > 0) {
			out.push({ id: w.id, status: 'modified', before: b, after: w, modifiedFields });
		}
	}
	for (const b of base) {
		if (!workById.has(b.id)) {
			out.push({ id: b.id, status: 'deleted', before: b });
		}
	}
	return out;
}

function indexById<T extends { id: string }>(list: T[]): Map<string, T> {
	const m = new Map<string, T>();
	for (const item of list) m.set(item.id, item);
	return m;
}

function elementModifiedFields(before: Element, after: Element): string[] {
	return propertyDiffKeys(before.properties, after.properties);
}

function relationshipModifiedFields(before: Relationship, after: Relationship): string[] {
	const keys = propertyDiffKeys(before.properties, after.properties);
	if (before.source_id !== after.source_id) keys.push('source_id');
	if (before.target_id !== after.target_id) keys.push('target_id');
	return keys;
}

function propertyDiffKeys(
	before: Record<string, unknown>,
	after: Record<string, unknown>
): string[] {
	const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
	const out: string[] = [];
	for (const k of keys) {
		if (!deepEqual(before[k], after[k])) out.push(k);
	}
	return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (typeof a !== 'object') return false;

	if (Array.isArray(a)) {
		if (!Array.isArray(b)) return false;
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (Array.isArray(b)) return false;

	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	const aKeys = Object.keys(ao);
	const bKeys = Object.keys(bo);
	if (aKeys.length !== bKeys.length) return false;
	for (const k of aKeys) {
		if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
		if (!deepEqual(ao[k], bo[k])) return false;
	}
	return true;
}
