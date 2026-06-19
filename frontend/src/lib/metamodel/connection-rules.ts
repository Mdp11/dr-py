// Pure connection-rules helpers mirroring the backend metamodel mapping +
// end-constraint semantics (core/validation/validators/endpoint_typing.py and
// multiplicity.py). Svelte-free so they unit-test in isolation, like helpers.ts.

import type { Metamodel, RelationshipType } from '$lib/api/types';
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
	const mappings = rt.mappings.length > 0 ? rt.mappings : [{ source: rt.source, target: rt.target }];
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
