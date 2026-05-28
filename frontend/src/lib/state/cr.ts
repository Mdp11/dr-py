import type { Element, ModelOut, Relationship } from '$lib/api/types';
import { computeDiff, type EntityDiff } from './diff';

export interface ModifiedElement {
	id: string;
	before: Element;
	after: Element;
}

export interface ModifiedRelationship {
	id: string;
	before: Relationship;
	after: Relationship;
}

export interface ChangeRequest {
	format: 'datarover.cr/v1';
	createdAt: string;
	baseline: {
		filename: string | null;
		elementCount: number;
		relationshipCount: number;
	};
	ops: {
		elements: {
			added: Element[];
			modified: ModifiedElement[];
			deleted: Element[];
		};
		relationships: {
			added: Relationship[];
			modified: ModifiedRelationship[];
			deleted: Relationship[];
		};
	};
}

/**
 * Build a Change Request describing the diff between `baseline` and `saved`.
 *
 * Both inputs must be canonical ModelOut values — i.e. all IDs are real,
 * not `tmp_*`. Callers are responsible for capturing the pre-save baseline
 * *before* it gets replaced; the post-save returned model is what makes all
 * IDs server-canonical.
 *
 * Pure: no I/O, no state. Inject `now` for deterministic timestamps in tests.
 */
export function buildChangeRequest(
	baseline: ModelOut,
	saved: ModelOut,
	baselineFilename: string | null,
	now: () => Date = () => new Date()
): ChangeRequest {
	const diff = computeDiff(baseline, saved);

	const elementsAdded: Element[] = [];
	const elementsModified: ModifiedElement[] = [];
	const elementsDeleted: Element[] = [];
	for (const d of diff.elements) {
		partitionElement(d, elementsAdded, elementsModified, elementsDeleted);
	}

	const relsAdded: Relationship[] = [];
	const relsModified: ModifiedRelationship[] = [];
	const relsDeleted: Relationship[] = [];
	for (const d of diff.relationships) {
		partitionRelationship(d, relsAdded, relsModified, relsDeleted);
	}

	return {
		format: 'datarover.cr/v1',
		createdAt: now().toISOString(),
		baseline: {
			filename: baselineFilename,
			elementCount: baseline.elements.length,
			relationshipCount: baseline.relationships.length
		},
		ops: {
			elements: {
				added: elementsAdded,
				modified: elementsModified,
				deleted: elementsDeleted
			},
			relationships: {
				added: relsAdded,
				modified: relsModified,
				deleted: relsDeleted
			}
		}
	};
}

function partitionElement(
	d: EntityDiff,
	added: Element[],
	modified: ModifiedElement[],
	deleted: Element[]
): void {
	if (d.status === 'added' && d.after) {
		added.push(d.after as Element);
	} else if (d.status === 'modified' && d.before && d.after) {
		modified.push({
			id: d.id,
			before: d.before as Element,
			after: d.after as Element
		});
	} else if (d.status === 'deleted' && d.before) {
		deleted.push(d.before as Element);
	}
}

function partitionRelationship(
	d: EntityDiff,
	added: Relationship[],
	modified: ModifiedRelationship[],
	deleted: Relationship[]
): void {
	if (d.status === 'added' && d.after) {
		added.push(d.after as Relationship);
	} else if (d.status === 'modified' && d.before && d.after) {
		modified.push({
			id: d.id,
			before: d.before as Relationship,
			after: d.after as Relationship
		});
	} else if (d.status === 'deleted' && d.before) {
		deleted.push(d.before as Relationship);
	}
}
