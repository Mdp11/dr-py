import type { KeyRel, KeySpec } from '../metamodel/key.ts';
import type { Metamodel } from '../metamodel/metamodel.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyKey } from '../value/key.ts';
import type { Value } from '../value/types.ts';
import { getProp, type ElementRec, type RelRec } from './records.ts';

/**
 * The canonical text of the element's identity under `mm`, computed from the
 * element as it now stands; equal texts mean identical elements. The owner is
 * the first of `parentsOf(el)`. `specs` memoizes `mm`'s effective key specs:
 * one map per metamodel.
 */
export function uniqKeyText(
	mm: Metamodel,
	parentsOf: (el: ElementRec) => readonly RelRec[],
	el: ElementRec,
	specs: Map<string, KeySpec | null>
): string {
	const parents = parentsOf(el);
	const owner = parents.length > 0 ? parents[0]!.source.id : null;
	const spec = keySpec(mm, specs, el.typeName);
	const signature: Value =
		spec === null
			? el.props
			: [
					spec.properties.map((name) => getProp(el.props, name) ?? null),
					spec.relationships.map((keyRel) => keyEndpoints(el, keyRel))
				];
	return pyKey([el.typeName, owner, signature]);
}

function keySpec(
	mm: Metamodel,
	specs: Map<string, KeySpec | null>,
	typeName: string
): KeySpec | null {
	let spec = specs.get(typeName);
	if (spec === undefined) {
		spec = mm.effectiveElementKeySpec(typeName);
		specs.set(typeName, spec);
	}
	return spec;
}

/** Sorted endpoint ids of the element's edges of exactly this type; subtypes do not count. */
export function keyEndpoints(el: ElementRec, keyRel: KeyRel): string[] {
	const ids: string[] = [];
	if (keyRel.direction === 'out') {
		for (const rel of el.out) if (rel.typeName === keyRel.relType) ids.push(rel.target.id);
	} else {
		for (const rel of el.in) if (rel.typeName === keyRel.relType) ids.push(rel.source.id);
	}
	return ids.sort(cmpCodePoint);
}
