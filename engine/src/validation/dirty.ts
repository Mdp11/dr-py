import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { containmentClosure } from '../ops/apply.ts';
import { cmpCodePoint } from '../value/compare.ts';

const byId = (a: RelRec, b: RelRec) => cmpCodePoint(a.id, b.id);

/**
 * Whether the element's uniqueness key names the relationship type in that
 * direction (`out:` / `in:`), which makes connecting or disconnecting such a
 * relationship re-key it. Exact type, as the key does.
 */
export function keysOn(
	model: Model,
	elementId: string,
	relType: string,
	direction: 'out' | 'in'
): boolean {
	const element = model.findElement(elementId);
	if (element === undefined) return false;
	const spec = model.metamodel.effectiveElementKeySpec(element.typeName);
	return (
		spec !== null &&
		spec.relationships.some((key) => key.relType === relType && key.direction === direction)
	);
}

/**
 * The ids whose verdict a mutation may have changed, in first-insertion order,
 * with the Python core's hooks (`core/validation/dirty.py`). Each hook adds
 * exactly what the core's does, in its order, and sorts every set it reads
 * from the indexes by code point. A hook only ever adds, so one collector
 * spans a whole batch. An id may name an entity that no longer exists: the
 * pipeline skips it, and the issue store drops what it owned.
 */
export class DirtyCollector {
	private readonly seen = new Set<string>();
	private readonly order: string[] = [];

	get ids(): readonly string[] {
		return this.order;
	}

	get size(): number {
		return this.order.length;
	}

	has(id: string): boolean {
		return this.seen.has(id);
	}

	add(...ids: string[]): void {
		this.update(ids);
	}

	update(ids: Iterable<string>): void {
		for (const id of ids) {
			if (this.seen.has(id)) continue;
			this.seen.add(id);
			this.order.push(id);
		}
	}

	/** The element's current uniqueness group, itself included; nothing when it does not exist. */
	addUniquenessGroupOf(model: Model, elementId: string): void {
		const element = model.findElement(elementId);
		if (element === undefined) return;
		this.update(sortedIds(model.indexes.uniqGroupOf(element)));
	}

	/** The current groups of the ends whose key names the relationship type: re-keyed by it. */
	private addKeyedEnds(model: Model, relType: string, sourceId: string, targetId: string): void {
		if (keysOn(model, sourceId, relType, 'out')) this.addUniquenessGroupOf(model, sourceId);
		if (keysOn(model, targetId, relType, 'in')) this.addUniquenessGroupOf(model, targetId);
	}

	/** After an element is created: it, its group, and whoever referenced its id while it dangled. */
	afterElementCreate(model: Model, elementId: string): void {
		this.add(elementId);
		this.addUniquenessGroupOf(model, elementId);
		this.update([...model.indexes.referencersOf(elementId)].sort(cmpCodePoint));
	}

	/** Before an element's properties change: it and its old group. */
	beforeElementPropsChange(model: Model, elementId: string): void {
		this.add(elementId);
		this.addUniquenessGroupOf(model, elementId);
	}

	/** After an element's properties changed: its new group. */
	afterElementPropsChange(model: Model, elementId: string): void {
		this.addUniquenessGroupOf(model, elementId);
	}

	/**
	 * Before an element is deleted, for every element of its cascade: the
	 * element, each incident relationship with its other end, its referencers
	 * and its group, read while they still exist; then the old group of each
	 * other end whose key names the relationship, which the delete re-keys.
	 * Returns those ends, for `afterElementDelete`.
	 */
	beforeElementDelete(
		model: Model,
		elementId: string,
		closure: readonly ElementRec[] = containmentClosure(model, elementId)
	): string[] {
		const keyed: string[] = [];
		for (const element of closure) {
			const out = element.out.toSorted(byId);
			const into = element.in.toSorted(byId);
			this.add(element.id);
			for (const rel of out) this.add(rel.id, rel.target.id);
			for (const rel of into) this.add(rel.id, rel.source.id);
			this.update([...model.indexes.referencersOf(element.id)].sort(cmpCodePoint));
			this.addUniquenessGroupOf(model, element.id);
			for (const rel of out) {
				if (keysOn(model, rel.target.id, rel.typeName, 'in')) {
					this.addUniquenessGroupOf(model, rel.target.id);
					keyed.push(rel.target.id);
				}
			}
			for (const rel of into) {
				if (keysOn(model, rel.source.id, rel.typeName, 'out')) {
					this.addUniquenessGroupOf(model, rel.source.id);
					keyed.push(rel.source.id);
				}
			}
		}
		return keyed;
	}

	/** After an element is deleted: the new groups of the ends `beforeElementDelete` returned. */
	afterElementDelete(model: Model, keyed: readonly string[]): void {
		for (const id of keyed) this.addUniquenessGroupOf(model, id);
	}

	/** Before a connect: both ends, for containment the target's old group, and the keyed ends' old groups. */
	beforeConnect(model: Model, relType: string, sourceId: string, targetId: string): void {
		this.add(sourceId, targetId);
		if (model.metamodel.isContainment(relType)) this.addUniquenessGroupOf(model, targetId);
		this.addKeyedEnds(model, relType, sourceId, targetId);
	}

	/** After a connect: the relationship, for containment the target's new group, and the keyed ends' new groups. */
	afterConnect(model: Model, relId: string): void {
		this.add(relId);
		const rel = model.getRelationship(relId);
		if (model.metamodel.isContainment(rel.typeName)) {
			this.addUniquenessGroupOf(model, rel.target.id);
		}
		this.addKeyedEnds(model, rel.typeName, rel.source.id, rel.target.id);
	}

	/**
	 * Before a disconnect: the relationship, both ends, for containment the
	 * target's old group, and the keyed ends' old groups.
	 */
	beforeDisconnect(model: Model, relId: string): void {
		const rel = model.getRelationship(relId);
		this.add(rel.id, rel.source.id, rel.target.id);
		if (model.metamodel.isContainment(rel.typeName)) {
			this.addUniquenessGroupOf(model, rel.target.id);
		}
		this.addKeyedEnds(model, rel.typeName, rel.source.id, rel.target.id);
	}

	/** After a disconnect: for containment the target's new group, and the keyed ends' new groups. */
	afterDisconnect(model: Model, relType: string, sourceId: string, targetId: string): void {
		if (model.metamodel.isContainment(relType)) this.addUniquenessGroupOf(model, targetId);
		this.addKeyedEnds(model, relType, sourceId, targetId);
	}

	/** A relationship's properties changed: only its own verdict moves. */
	afterRelationshipPropsChange(relId: string): void {
		this.add(relId);
	}
}

function sortedIds(entities: readonly (ElementRec | RelRec)[]): string[] {
	return entities.map((entity) => entity.id).sort(cmpCodePoint);
}

/**
 * Adds, per id in order, everything whose verdict can read that entity: for
 * an element itself, its sorted uniqueness group, its sorted referencers, then
 * each sorted outgoing relationship with its target and each sorted incoming
 * one with its source; for a relationship itself, its ends, and for
 * containment its target's sorted group; for an id naming nothing the id
 * alone. Taken over the ids a change may touch, on the states before and
 * after it, this covers every entity whose verdict inputs moved, but for a
 * containment chain past its first link, which the hooks miss as well.
 */
export function addNeighbourhood(model: Model, ids: Iterable<string>, into: DirtyCollector): void {
	const indexes = model.indexes;
	for (const id of ids) {
		const element = model.findElement(id);
		if (element !== undefined) {
			into.add(id);
			into.update(sortedIds(indexes.uniqGroupOf(element)));
			into.update([...indexes.referencersOf(id)].sort(cmpCodePoint));
			for (const rel of element.out.toSorted(byId)) into.add(rel.id, rel.target.id);
			for (const rel of element.in.toSorted(byId)) into.add(rel.id, rel.source.id);
			continue;
		}
		const rel = model.findRelationship(id);
		if (rel === undefined) {
			into.add(id);
			continue;
		}
		into.add(id, rel.source.id, rel.target.id);
		if (model.metamodel.isContainment(rel.typeName)) {
			into.update(sortedIds(indexes.uniqGroupOf(rel.target)));
		}
	}
}
