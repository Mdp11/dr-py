/**
 * The `datarover.cr/v1` document `_changes_out` writes, as a response body
 * carries it.
 */
import type { Wire } from '../read/wire.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type { CrElement, CrKindOps, CrRelationship, Diff } from './diff.ts';

export const CR_FORMAT = 'datarover.cr/v1';

/** What the change request is computed against: the working copy's counts. */
export type CrBaseline = { elementCount: number; relationshipCount: number };

/**
 * A deep copy of `value` as JSON-able data, as pydantic writes it: a finite
 * float leaves as its number, a non-finite one as `null`, an integer past
 * 2^53 as the nearest double.
 */
export function crWire(value: Value): Wire {
	if (value instanceof PyFloat) return Number.isFinite(value.value) ? value.value : null;
	if (typeof value === 'bigint') return Number(value);
	if (Array.isArray(value)) return value.map(crWire);
	if (typeof value === 'object' && value !== null) {
		const out: { [key: string]: Wire } = {};
		for (const key of Object.keys(value)) {
			// An own `__proto__` key stays an own key.
			Object.defineProperty(out, key, {
				value: crWire(value[key]!),
				writable: true,
				enumerable: true,
				configurable: true
			});
		}
		return out;
	}
	return value;
}

const elementWire = (e: CrElement): Wire => ({
	id: e.id,
	type_name: e.type_name,
	properties: crWire(e.properties),
	rev: crWire(e.rev)
});

const relWire = (r: CrRelationship): Wire => ({
	id: r.id,
	type_name: r.type_name,
	source_id: r.source_id,
	target_id: r.target_id,
	properties: crWire(r.properties),
	rev: crWire(r.rev)
});

function kindWire<E>(ops: CrKindOps<E>, entity: (e: E) => Wire): Wire {
	return {
		added: ops.added.map(entity),
		modified: ops.modified.map(({ id, before, after }) => ({
			id,
			before: entity(before),
			after: entity(after)
		})),
		deleted: ops.deleted.map(entity)
	};
}

/** `_changes_out(base, diff)`: the file is unknown, so `filename` is `null`, and the document is complete. */
export function crDocument(
	diff: Diff,
	baseline: CrBaseline,
	createdAt: string
): { [key: string]: Wire } {
	return {
		format: CR_FORMAT,
		createdAt,
		baseline: {
			filename: null,
			elementCount: baseline.elementCount,
			relationshipCount: baseline.relationshipCount
		},
		ops: {
			elements: kindWire(diff.elements, elementWire),
			relationships: kindWire(diff.relationships, relWire)
		},
		complete: true
	};
}
