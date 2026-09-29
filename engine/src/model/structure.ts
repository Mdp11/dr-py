import type { KeySpec } from '../metamodel/key.ts';
import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Steps } from '../steps/steps.ts';
import type { Model } from './model.ts';
import type { ElementRec, RelRec } from './records.ts';
import { uniqKeyText } from './uniq-key.ts';

/**
 * What validation reads of a model's structure under one metamodel: the
 * containment parents and the uniqueness groups. The model itself answers
 * everything else (lookups, adjacency) whatever the metamodel.
 */
export interface Structure {
	readonly metamodel: Metamodel;
	/** The element's containment parents, in relationship order. */
	parentsOf(el: ElementRec): readonly RelRec[];
	/** The element's uniqueness group, itself included; null when it is alone. */
	groupOf(el: ElementRec): readonly ElementRec[] | null;
	keyOf(el: ElementRec): string;
}

const LIVE = new WeakMap<Model, Structure>();

/**
 * The model's structure under its own metamodel, as its indexes keep it. A
 * group is null when the element is alone in its bucket, and may be `[el]`
 * when its bucket is shared by different keys.
 */
export function liveStructure(model: Model): Structure {
	let structure = LIVE.get(model);
	if (structure === undefined) {
		const indexes = model.indexes;
		structure = {
			metamodel: model.metamodel,
			parentsOf: (el) => el.parents,
			groupOf: (el) =>
				indexes.buckets.get(el.uniq) instanceof Set ? indexes.uniqGroupOf(el) : null,
			keyOf: (el) => indexes.uniqKey(el)
		};
		LIVE.set(model, structure);
	}
	return structure;
}

const NO_PARENTS: readonly RelRec[] = [];

/**
 * The model's structure under `mm`, as the indexes would keep it were `mm` the
 * model's metamodel, in steps of 2,048 entity visits and a last one at the
 * total: containment parents in relationship order, and groups of equal key
 * text, so no two keys ever share one. It reads the records and writes none.
 * Nothing may write the model between two steps: the passes hold iterators
 * over it.
 */
export function* candidateStructureSteps(model: Model, mm: Metamodel): Steps<Structure> {
	const total = model.relationshipCount + model.elementCount + 1;
	let done = 0;
	const visited = () => (++done & 2047) === 0;
	// Relationships first, in order, so that owners are known before keying.
	const parents = new Map<ElementRec, RelRec[]>();
	for (const rel of model.relationships()) {
		if (mm.isContainment(rel.typeName)) {
			const of = parents.get(rel.target);
			if (of === undefined) parents.set(rel.target, [rel]);
			else of.push(rel);
		}
		if (visited()) yield { done, total };
	}
	const parentsOf = (el: ElementRec): readonly RelRec[] => parents.get(el) ?? NO_PARENTS;
	const specs = new Map<string, KeySpec | null>();
	// Key text → the first element with it; only the groups of two or more outlive the build.
	const first = new Map<string, ElementRec>();
	const memberOf = new Map<ElementRec, ElementRec[]>();
	const keyOfMember = new Map<ElementRec, string>();
	for (const el of model.elements()) {
		const key = uniqKeyText(mm, parentsOf, el, specs);
		const earlier = first.get(key);
		if (earlier === undefined) {
			first.set(key, el);
		} else {
			let group = memberOf.get(earlier);
			if (group === undefined) {
				memberOf.set(earlier, (group = [earlier]));
				keyOfMember.set(earlier, key);
			}
			group.push(el);
			memberOf.set(el, group);
			keyOfMember.set(el, key);
		}
		if (visited()) yield { done, total };
	}
	yield { done: total, total };
	return {
		metamodel: mm,
		parentsOf,
		groupOf: (el) => memberOf.get(el) ?? null,
		keyOf: (el) => keyOfMember.get(el) ?? uniqKeyText(mm, parentsOf, el, specs)
	};
}
