/**
 * The read keys a transition touches, in the vocabulary a call's read-set is
 * recorded in: what the cell cache evicts by. The rules are the oracle's
 * `touched_keys`, applied to the ids present in one state.
 *
 * A changed element touches itself, the `children` of every containment parent
 * (a `children()` answer inlines the element) and every `scan` that could have
 * listed it: all types and its own type and ancestors. A relationship touches
 * its source's `out` and its target's `in`, and when it is containment the
 * source's `children` and the target's `parent`.
 *
 * A transition's keys are the union of this over the state before it and over
 * the state after, for the ids it touched: an entity present in one state only
 * (created or deleted) takes its type and endpoints from the state that has it,
 * and an element that was re-parented its old and new parents. An id absent
 * from the state it is looked up in touches only itself, and a relationship
 * nothing; `deletedKeys` takes what such an id was from its image.
 */
import type { Metamodel } from '../metamodel/metamodel.ts';
import type { Model } from '../model/model.ts';
import { readKeyText } from './cell-cache.ts';

export type TouchedIds = {
	elementIds: Iterable<string>;
	relationshipIds: Iterable<string>;
};

export function touchedKeys(
	model: Model,
	metamodel: Metamodel,
	ids: TouchedIds,
	into: Set<string> = new Set()
): Set<string> {
	for (const id of ids.elementIds) {
		into.add(readKeyText(['el', id]));
		const element = model.findElement(id);
		if (element === undefined) continue;
		for (const parent of element.parents) into.add(readKeyText(['children', parent.source.id]));
		into.add(readKeyText(['scan', null]));
		into.add(readKeyText(['scan', element.typeName]));
		for (const name of metamodel.elementAncestors(element.typeName)) {
			into.add(readKeyText(['scan', name]));
		}
	}
	for (const id of ids.relationshipIds) {
		const rel = model.findRelationship(id);
		if (rel === undefined) continue;
		into.add(readKeyText(['out', rel.source.id]));
		into.add(readKeyText(['in', rel.target.id]));
		if (metamodel.isContainment(rel.typeName)) {
			into.add(readKeyText(['children', rel.source.id]));
			into.add(readKeyText(['parent', rel.target.id]));
		}
	}
	return into;
}

/** What a deleted entity was: the type of an element, the type and ends of a relationship. */
export type DeletedImages = {
	element(id: string): { readonly typeName: string } | null;
	relationship(
		id: string
	): { readonly typeName: string; readonly sourceId: string; readonly targetId: string } | null;
};

/**
 * The keys of entities a transition removed, from the images they had: an
 * element touches itself and every `scan` that listed it, a relationship the
 * keys it has present. An id without an image adds only `el` for an element
 * and nothing for a relationship, as an id absent from the state does.
 */
export function deletedKeys(
	metamodel: Metamodel,
	ids: TouchedIds,
	images: DeletedImages,
	into: Set<string> = new Set()
): Set<string> {
	for (const id of ids.elementIds) {
		into.add(readKeyText(['el', id]));
		const image = images.element(id);
		if (image === null) continue;
		into.add(readKeyText(['scan', null]));
		into.add(readKeyText(['scan', image.typeName]));
		for (const name of metamodel.elementAncestors(image.typeName)) {
			into.add(readKeyText(['scan', name]));
		}
	}
	for (const id of ids.relationshipIds) {
		const image = images.relationship(id);
		if (image === null) continue;
		into.add(readKeyText(['out', image.sourceId]));
		into.add(readKeyText(['in', image.targetId]));
		if (metamodel.isContainment(image.typeName)) {
			into.add(readKeyText(['children', image.sourceId]));
			into.add(readKeyText(['parent', image.targetId]));
		}
	}
	return into;
}
