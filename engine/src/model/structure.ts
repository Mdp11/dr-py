import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from './model.ts';
import type { ElementRec, RelRec } from './records.ts';

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
