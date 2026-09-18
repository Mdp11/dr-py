import type { ElementRec, Props, RelRec } from '../model/records.ts';
import type { ModelOp } from './types.ts';

/** An element as it stood, its place in state order included. `props` is a copy of the bag, not of the values. */
export type ElementImage = {
	id: string;
	typeName: string;
	props: Props;
	rev: number;
	ord: number;
};

export type RelImage = ElementImage & { sourceId: string; targetId: string };

export function elementImage(element: ElementRec): ElementImage {
	return {
		id: element.id,
		typeName: element.typeName,
		props: { ...element.props },
		rev: element.rev,
		ord: element.ord
	};
}

export function relImage(rel: RelRec): RelImage {
	return {
		id: rel.id,
		typeName: rel.typeName,
		props: { ...rel.props },
		rev: rel.rev,
		ord: rel.ord,
		sourceId: rel.source.id,
		targetId: rel.target.id
	};
}

/**
 * Everything one batch application produced. The four id sets are in
 * first-touch order and the changed and deleted ones stay disjoint: deleting
 * an entity takes it out of the changed set, creating it again takes it out of
 * the deleted set.
 */
export class BatchResult {
	/** Temp id → the id the entity was created under. */
	readonly idMap = new Map<string, string>();
	/** One unit per completed mutation, in application order. A unit's own order matters. */
	readonly inverseUnits: ModelOp[][] = [];
	readonly changedElementIds = new Set<string>();
	readonly changedRelationshipIds = new Set<string>();
	readonly deletedElementIds = new Set<string>();
	readonly deletedRelationshipIds = new Set<string>();
	/**
	 * The state of every touched entity before its FIRST touch; `null` when it
	 * did not exist. Every id in the four sets has an entry.
	 */
	readonly beforeElements = new Map<string, ElementImage | null>();
	readonly beforeRelationships = new Map<string, RelImage | null>();

	/** The flat inverse batch: applied front to back, in restore mode, it undoes this one. */
	inverseOps(): ModelOp[] {
		return this.inverseUnits.toReversed().flat();
	}

	markElementChanged(id: string): void {
		this.changedElementIds.add(id);
		this.deletedElementIds.delete(id);
	}

	markRelationshipChanged(id: string): void {
		this.changedRelationshipIds.add(id);
		this.deletedRelationshipIds.delete(id);
	}

	markElementDeleted(id: string): void {
		this.deletedElementIds.add(id);
		this.changedElementIds.delete(id);
	}

	markRelationshipDeleted(id: string): void {
		this.deletedRelationshipIds.add(id);
		this.changedRelationshipIds.delete(id);
	}

	/** Call BEFORE mutating; a later touch never overwrites the first image. */
	noteElementBefore(id: string, element: ElementRec | null): void {
		if (!this.beforeElements.has(id)) {
			this.beforeElements.set(id, element === null ? null : elementImage(element));
		}
	}

	noteRelationshipBefore(id: string, rel: RelRec | null): void {
		if (!this.beforeRelationships.has(id)) {
			this.beforeRelationships.set(id, rel === null ? null : relImage(rel));
		}
	}
}
