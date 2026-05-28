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
	partitionEntities<Element>(diff.elements, elementsAdded, elementsModified, elementsDeleted);

	const relsAdded: Relationship[] = [];
	const relsModified: ModifiedRelationship[] = [];
	const relsDeleted: Relationship[] = [];
	partitionEntities<Relationship>(diff.relationships, relsAdded, relsModified, relsDeleted);

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

function partitionEntities<T>(
	diffs: EntityDiff[],
	added: T[],
	modified: { id: string; before: T; after: T }[],
	deleted: T[]
): void {
	for (const d of diffs) {
		if (d.status === 'added' && d.after) {
			added.push(d.after as T);
		} else if (d.status === 'modified' && d.before && d.after) {
			modified.push({
				id: d.id,
				before: d.before as T,
				after: d.after as T
			});
		} else if (d.status === 'deleted' && d.before) {
			deleted.push(d.before as T);
		}
	}
}
