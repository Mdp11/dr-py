// Maps a property's metamodel datatype to the set of search operators that
// make sense for it. Used by the advanced-search property criterion so that,
// e.g., numeric properties don't offer `contains` and strings don't offer `>`.
//
// Datatype resolution mirrors Inspector/PropertyField.svelte's `Kind` logic:
// built-in scalar datatypes are recognised by name; otherwise the metamodel's
// enums and element types are consulted; anything else is `unknown`.

import type { Metamodel } from '$lib/api/types';
import type { PropertyOp } from './types';

export type DatatypeKind = 'string' | 'numeric' | 'boolean' | 'enum' | 'element' | 'unknown';

const STRING_OPS: PropertyOp[] = [
	'equals',
	'not_equals',
	'contains',
	'matches',
	'exists',
	'is_empty'
];
const NUMERIC_OPS: PropertyOp[] = [
	'equals',
	'not_equals',
	'gt',
	'lt',
	'gte',
	'lte',
	'exists',
	'is_empty'
];
const EQUALITY_OPS: PropertyOp[] = ['equals', 'not_equals', 'exists', 'is_empty'];
const ALL_OPS: PropertyOp[] = [
	'equals',
	'not_equals',
	'contains',
	'matches',
	'gt',
	'lt',
	'gte',
	'lte',
	'exists',
	'is_empty'
];

/** Short labels for each operator, shown in the criterion's operator dropdown. */
export const PROPERTY_OP_LABELS: Record<PropertyOp, string> = {
	equals: '=',
	not_equals: '≠',
	contains: 'contains',
	matches: 'matches',
	gt: '>',
	lt: '<',
	gte: '≥',
	lte: '≤',
	exists: 'exists',
	is_empty: 'is empty'
};

/** Resolve a metamodel datatype string to a coarse kind for operator selection.
 *  `date` is treated as `string` (ISO strings; the evaluator has no date-aware
 *  comparison, so numeric ops are intentionally not offered). */
export function resolvePropertyKind(datatype: string | null, mm: Metamodel | null): DatatypeKind {
	if (!datatype) return 'unknown';
	if (datatype === 'string' || datatype === 'date') return 'string';
	if (datatype === 'integer' || datatype === 'float') return 'numeric';
	if (datatype === 'boolean') return 'boolean';
	if (mm) {
		if (mm.enums[datatype]) return 'enum';
		if (mm.elements.some((e) => e.name === datatype)) return 'element';
	}
	return 'unknown';
}

/** Operators compatible with a resolved datatype kind, in display order. */
export function compatibleOps(kind: DatatypeKind): PropertyOp[] {
	switch (kind) {
		case 'string':
			return STRING_OPS;
		case 'numeric':
			return NUMERIC_OPS;
		case 'boolean':
		case 'enum':
		case 'element':
			return EQUALITY_OPS;
		case 'unknown':
			return ALL_OPS;
	}
}
