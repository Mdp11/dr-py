// Pure connection-rules helpers mirroring the backend metamodel mapping +
// end-constraint semantics (core/validation/validators/endpoint_typing.py and
// multiplicity.py). Svelte-free so they unit-test in isolation, like helpers.ts.

import type { Metamodel, Relationship, RelationshipType } from '$lib/api/types';
import { isSubtype, parseMultiplicity } from './helpers';

/**
 * Distinct target types reachable from `sourceType` through `rt`'s mappings:
 * every `mapping.target` whose `mapping.source` is a supertype-or-equal of
 * `sourceType`. Falls back to the single-pair `rt.source`/`rt.target`
 * shorthand when `rt.mappings` is empty (the backend keeps them in sync, but
 * the zod schema defaults `mappings` to `[]`).
 */
export function allowedTargetTypes(
	mm: Metamodel,
	sourceType: string,
	rt: RelationshipType
): string[] {
	const mappings =
		rt.mappings.length > 0 ? rt.mappings : [{ source: rt.source, target: rt.target }];
	const targets: string[] = [];
	for (const m of mappings) {
		if (isSubtype(mm, sourceType, m.source) && !targets.includes(m.target)) {
			targets.push(m.target);
		}
	}
	return targets;
}

export interface RelTypeFromSource {
	rt: RelationshipType;
	targetTypes: string[];
}

/**
 * Non-abstract relationship types creatable from `sourceType`, each paired
 * with its allowed target types. Excludes types with no matching mapping.
 * Sorted by relationship-type name.
 */
export function relationshipTypesFromSource(
	mm: Metamodel,
	sourceType: string
): RelTypeFromSource[] {
	return mm.relationships
		.filter((rt) => !rt.abstract)
		.map((rt) => ({ rt, targetTypes: allowedTargetTypes(mm, sourceType, rt) }))
		.filter((entry) => entry.targetTypes.length > 0)
		.sort((a, b) => a.rt.name.localeCompare(b.rt.name));
}

/**
 * Distinct target types reachable from a navigation SCOPE of `scopeType`
 * through `rt`'s mappings: every `mapping.target` whose `mapping.source` is
 * on the same inheritance line as `scopeType`, in EITHER direction —
 * `isSubtype(mm, scopeType, m.source) || isSubtype(mm, m.source, scopeType)`.
 * Falls back to the single-pair `rt.source`/`rt.target` shorthand when
 * `rt.mappings` is empty, same as `allowedTargetTypes`.
 *
 * This differs from `allowedTargetTypes`'s CREATION-semantics predicate
 * (`isSubtype(mm, sourceType, m.source)` only — mapping.source must be an
 * ancestor-or-equal of the concrete element's type) because the backend
 * navigation evaluator matches a scope type against instances of that type
 * AND ALL ITS DESCENDANTS (see `element_descendants` in
 * `src/data_rover/core/navigation/evaluate.py`), not just instances whose
 * type is exactly `scopeType` or one of its ancestors. So a mapping whose
 * source is a DESCENDANT of the scope type is also a relationship the
 * evaluator will traverse when walking that scope, even though no plain
 * `scopeType` instance could itself have created an edge via that mapping.
 */
export function scopeAllowedTargetTypes(
	mm: Metamodel,
	scopeType: string,
	rt: RelationshipType
): string[] {
	const mappings =
		rt.mappings.length > 0 ? rt.mappings : [{ source: rt.source, target: rt.target }];
	const targets: string[] = [];
	for (const m of mappings) {
		if (
			(isSubtype(mm, scopeType, m.source) || isSubtype(mm, m.source, scopeType)) &&
			!targets.includes(m.target)
		) {
			targets.push(m.target);
		}
	}
	return targets;
}

/**
 * Non-abstract relationship types traversable as a navigation hop from a
 * scope of `scopeType`, each paired with its allowed target types. Mirrors
 * `relationshipTypesFromSource` but built on `scopeAllowedTargetTypes` — see
 * that function's docstring for why scope semantics differ from creation
 * semantics. Excludes types with no matching mapping. Sorted by
 * relationship-type name.
 */
export function relationshipTypesFromScope(mm: Metamodel, scopeType: string): RelTypeFromSource[] {
	return mm.relationships
		.filter((rt) => !rt.abstract)
		.map((rt) => ({ rt, targetTypes: scopeAllowedTargetTypes(mm, scopeType, rt) }))
		.filter((entry) => entry.targetTypes.length > 0)
		.sort((a, b) => a.rt.name.localeCompare(b.rt.name));
}

/**
 * True when `rt`'s `target_multiplicity` has a finite upper bound and the
 * source already has >= upper outgoing edges of this type. Matches the
 * MultiplicityValidator target-end check (target_multiplicity bounds
 * count_out(source, rel_type)). A malformed spec parses to `0..*` (no upper),
 * so this returns false rather than throwing.
 */
export function targetMultiplicityExceeded(rt: RelationshipType, currentOutCount: number): boolean {
	const { upper } = parseMultiplicity(rt.target_multiplicity);
	return upper !== null && currentOutCount >= upper;
}

/** Outgoing-edge counts per relationship type for one source element. */
export function outCountsByType(
	relationships: Iterable<Relationship>,
	sourceId: string
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const r of relationships) {
		if (r.source_id !== sourceId) continue;
		counts.set(r.type_name, (counts.get(r.type_name) ?? 0) + 1);
	}
	return counts;
}

export interface PickerTypeOption {
	rt: RelationshipType;
	/** Allowed target types to fetch candidates from. */
	targetTypes: string[];
	/** Allowed by the metamodel mappings from this source type. */
	allowed: boolean;
	/** Source already at target_multiplicity upper bound for this type. */
	atMax: boolean;
	outCount: number;
	/** Upper bound, or null when unbounded. */
	max: number | null;
	/** Hard guardrail: render disabled (atMax AND not in show-all mode). */
	disabled: boolean;
}

function uniqueTargets(rt: RelationshipType): string[] {
	const raw = rt.mappings.length > 0 ? rt.mappings.map((m) => m.target) : [rt.target];
	return [...new Set(raw)];
}

/**
 * The relationship-type options the picker renders for `sourceType`.
 *
 * - filtered (`showAll === false`): only mapping-allowed types; a type whose
 *   source is at target_multiplicity max is `disabled`.
 * - escape hatch (`showAll === true`): every non-abstract type (allowed flag
 *   distinguishes off-metamodel ones); the maxed disable is downgraded to a
 *   non-disabling `atMax` flag so the user can still create it.
 */
export function buildPickerTypeOptions(
	mm: Metamodel,
	sourceType: string,
	outCounts: Map<string, number>,
	showAll: boolean
): PickerTypeOption[] {
	const allowed = relationshipTypesFromSource(mm, sourceType);
	const allowedByName = new Map(allowed.map((e) => [e.rt.name, e]));

	const base: { rt: RelationshipType; targetTypes: string[]; allowed: boolean }[] = showAll
		? mm.relationships
				.filter((rt) => !rt.abstract)
				.slice()
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((rt) => {
					const hit = allowedByName.get(rt.name);
					return {
						rt,
						targetTypes: hit ? hit.targetTypes : uniqueTargets(rt),
						allowed: hit !== undefined
					};
				})
		: allowed.map((e) => ({ rt: e.rt, targetTypes: e.targetTypes, allowed: true }));

	return base.map(({ rt, targetTypes, allowed: isAllowed }) => {
		const outCount = outCounts.get(rt.name) ?? 0;
		const { upper } = parseMultiplicity(rt.target_multiplicity);
		const atMax = targetMultiplicityExceeded(rt, outCount);
		return {
			rt,
			targetTypes,
			allowed: isAllowed,
			atMax,
			outCount,
			max: upper,
			disabled: atMax && !showAll
		};
	});
}
