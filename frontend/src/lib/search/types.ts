import type { Snapshot } from '$lib/state/ops';

export type TargetKind = 'element' | 'relationship';
export type Direction = 'outgoing' | 'incoming' | 'either';

export type PropertyOp =
	| 'equals'
	| 'not_equals'
	| 'contains'
	| 'matches'
	| 'gt'
	| 'lt'
	| 'gte'
	| 'lte'
	| 'exists'
	| 'is_empty';

export type TextOp = Extract<PropertyOp, 'contains' | 'matches' | 'equals'>;
export type CountOp = 'at_least' | 'at_most' | 'exactly';

export type LeafCriterion =
	| { type: 'entity_type'; names: string[] }
	| { type: 'property'; name: string; datatype?: string | null; op: PropertyOp; value: string }
	| { type: 'name_id'; field: 'name' | 'id'; op: TextOp; value: string }
	| { type: 'relation_count'; op: CountOp; count: number; direction: Direction; relTypes: string[] }
	| { type: 'orphan' }
	| { type: 'connected_to_type'; direction: Direction; names: string[] }
	| { type: 'endpoint_type'; endpoint: 'source' | 'target'; names: string[] };

/** OR group: matches iff ANY member matches; an EMPTY group is a no-op that
 * matches everything (transient editing state — mirrors the backend's
 * AnyOfCriterion docstring). Members are leaves only: no nesting, enforced
 * structurally on both sides of the wire. */
export type AnyOfCriterion = { type: 'any_of'; criteria: LeafCriterion[] };

export type Criterion = LeafCriterion | AnyOfCriterion;

export type CriterionType = Criterion['type'];

export interface AdvancedQuery {
	target: TargetKind;
	criteria: Criterion[];
}

export interface SearchResultItem {
	kind: TargetKind;
	id: string;
}

/** The working-model snapshot the evaluator runs against. */
export type SearchModel = Snapshot;

export const CRITERION_LABELS: Record<CriterionType, string> = {
	entity_type: 'Has type',
	property: 'Property',
	name_id: 'Name / ID',
	relation_count: 'Relation count',
	orphan: 'Is orphan (no relations)',
	connected_to_type: 'Connected to type',
	endpoint_type: 'Endpoint type',
	any_of: 'Any of'
};

const ELEMENT_CRITERIA: CriterionType[] = [
	'entity_type',
	'property',
	'name_id',
	'relation_count',
	'orphan',
	'connected_to_type',
	'any_of'
];
const RELATIONSHIP_CRITERIA: CriterionType[] = [
	'entity_type',
	'property',
	'name_id',
	'endpoint_type',
	'any_of'
];

/** Criterion types offered for a given target kind, in display order. */
export function criteriaForKind(kind: TargetKind): CriterionType[] {
	return kind === 'element' ? ELEMENT_CRITERIA : RELATIONSHIP_CRITERIA;
}

/** A fresh criterion of the given type with sensible defaults. */
export function newCriterion(type: CriterionType): Criterion {
	switch (type) {
		case 'entity_type':
			return { type, names: [] };
		case 'property':
			return { type, name: '', datatype: null, op: 'equals', value: '' };
		case 'name_id':
			return { type, field: 'name', op: 'contains', value: '' };
		case 'relation_count':
			return { type, op: 'at_least', count: 1, direction: 'either', relTypes: [] };
		case 'orphan':
			return { type };
		case 'connected_to_type':
			return { type, direction: 'either', names: [] };
		case 'endpoint_type':
			return { type, endpoint: 'source', names: [] };
		case 'any_of':
			return { type, criteria: [] };
	}
}

/** Drop criteria that do not apply to `target` (used when switching kind).
 * Recurses into `any_of` groups: inapplicable MEMBERS are dropped, and a
 * group emptied by pruning is dropped with them (an always-empty leftover
 * would otherwise sit uneditable in the list). */
export function pruneCriteria(criteria: Criterion[], target: TargetKind): Criterion[] {
	const allowed = criteriaForKind(target);
	const out: Criterion[] = [];
	for (const c of criteria) {
		if (c.type === 'any_of') {
			const members = c.criteria.filter((m) => allowed.includes(m.type));
			if (members.length > 0) out.push({ ...c, criteria: members });
		} else if (allowed.includes(c.type)) {
			out.push(c);
		}
	}
	return out;
}
