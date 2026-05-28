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

/**
 * Produce `<TS>_<base>.cr.json`.
 * - `<TS>` is local-time `YYYYMMDDTHHmmss`, zero-padded, no colons.
 * - `<base>` is `modelFilename` with the trailing extension stripped.
 * - Null or empty `modelFilename` falls back to `model`.
 */
export function composeCrFilename(
	modelFilename: string | null,
	now: () => Date = () => new Date()
): string {
	const base = stripExtension(modelFilename);
	const ts = localTimestamp(now());
	return `${ts}_${base}.cr.json`;
}

function stripExtension(filename: string | null): string {
	if (filename === null || filename.length === 0) return 'model';
	const dot = filename.lastIndexOf('.');
	if (dot <= 0) return filename; // no extension or leading dot
	return filename.slice(0, dot);
}

function localTimestamp(d: Date): string {
	const yyyy = d.getFullYear().toString().padStart(4, '0');
	const mm = (d.getMonth() + 1).toString().padStart(2, '0');
	const dd = d.getDate().toString().padStart(2, '0');
	const hh = d.getHours().toString().padStart(2, '0');
	const mi = d.getMinutes().toString().padStart(2, '0');
	const ss = d.getSeconds().toString().padStart(2, '0');
	return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
}
