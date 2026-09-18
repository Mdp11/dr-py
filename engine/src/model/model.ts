import type { Metamodel } from '../metamodel/metamodel.ts';
import { pyRepr } from '../value/repr.ts';
import type { Value } from '../value/types.ts';
import { ModelError, SnapshotError } from './errors.ts';
import { hashKey } from './hash.ts';
import { IndexSet } from './indexes.ts';
import { asEntity, readProps, readRev, requireStr, TEMP_ID_PREFIX } from './load.ts';
import { ElementRec, RelRec, setProp, type Props } from './records.ts';

export type ModelOptions = {
	/** Replaces the uniqueness-bucket hash; tests force collisions with it. */
	hashKey?: (key: string) => number;
};

function byOrd<T extends { id: string; ord: number }>(map: Map<string, T>): void {
	const sorted = [...map.values()].sort((a, b) => a.ord - b.ord);
	map.clear();
	for (const rec of sorted) map.set(rec.id, rec);
}

/**
 * The elements and relationships of one project, conforming to one metamodel.
 *
 * Every mutation goes through this object's methods — the mutation boundary —
 * which keep `indexes` and the records' adjacency in step. Whatever adds
 * entities behind it, as the bulk loader does, calls `rebuildIndexes()` after.
 *
 * Entity order is state. It is the order of insertion, held by each record's
 * `ord`; an entity restored with its old `ord` goes back to its old place.
 * Element and relationship ids share one namespace.
 */
export class Model {
	readonly metamodel: Metamodel;
	readonly indexes: IndexSet;

	private readonly elementMap = new Map<string, ElementRec>();
	private readonly relationshipMap = new Map<string, RelRec>();
	private nextOrd = 0;
	// Set when a record came back with an old `ord`: the map is then out of
	// order until the next ordered iteration sorts it, once.
	private elementsShuffled = false;
	private relationshipsShuffled = false;

	constructor(metamodel: Metamodel, options: ModelOptions = {}) {
		this.metamodel = metamodel;
		this.indexes = new IndexSet(this, options.hashKey ?? hashKey);
	}

	// -- reading -------------------------------------------------------------

	get elementCount(): number {
		return this.elementMap.size;
	}

	get relationshipCount(): number {
		return this.relationshipMap.size;
	}

	/** The elements in state order. */
	elements(): IterableIterator<ElementRec> {
		if (this.elementsShuffled) {
			byOrd(this.elementMap);
			this.elementsShuffled = false;
		}
		return this.elementMap.values();
	}

	/** The relationships in state order. */
	relationships(): IterableIterator<RelRec> {
		if (this.relationshipsShuffled) {
			byOrd(this.relationshipMap);
			this.relationshipsShuffled = false;
		}
		return this.relationshipMap.values();
	}

	findElement(id: string): ElementRec | undefined {
		return this.elementMap.get(id);
	}

	findRelationship(id: string): RelRec | undefined {
		return this.relationshipMap.get(id);
	}

	getElement(id: string): ElementRec {
		const element = this.elementMap.get(id);
		if (element === undefined) throw new ModelError('key', `No element with id ${pyRepr(id)}`);
		return element;
	}

	getRelationship(id: string): RelRec {
		const rel = this.relationshipMap.get(id);
		if (rel === undefined) throw new ModelError('key', `No relationship with id ${pyRepr(id)}`);
		return rel;
	}

	/** Outgoing relationships, in no specified order. Live — do not mutate. */
	relationshipsFrom(elementId: string): readonly RelRec[] {
		return this.elementMap.get(elementId)?.out ?? [];
	}

	/** Incoming relationships, in no specified order. Live — do not mutate. */
	relationshipsTo(elementId: string): readonly RelRec[] {
		return this.elementMap.get(elementId)?.in ?? [];
	}

	/** The id of the first containment parent, or `null`. */
	containerOf(elementId: string): string | null {
		return this.elementMap.get(elementId)?.parents[0]?.source.id ?? null;
	}

	// -- mutation boundary: elements -----------------------------------------

	/** The caller supplies the id: the engine never mints one. */
	createElement(typeName: string, id: string): ElementRec {
		return this.restoreElement(id, typeName);
	}

	/** Inserts an element under a fixed id, and at its old place when `ord` is given. */
	restoreElement(id: string, typeName: string, ord?: number): ElementRec {
		const type = this.metamodel.elementType(typeName);
		if (type === undefined) {
			throw new ModelError('key', `Unknown element type ${pyRepr(typeName)}`);
		}
		if (type.abstract) {
			throw new ModelError('value', `Cannot instantiate abstract type ${pyRepr(typeName)}`);
		}
		return this.insertElement(id, typeName, {}, 0, ord);
	}

	/** Contained children go first, recursively; then every relationship left; then the element. */
	deleteElement(elementId: string): void {
		this.deleteCascade(this.getElement(elementId), new Set());
	}

	private deleteCascade(element: ElementRec, visiting: Set<ElementRec>): void {
		if (visiting.has(element)) return;
		visiting.add(element);
		const contained = element.out.filter((rel) => this.metamodel.isContainment(rel.typeName));
		for (const rel of contained) {
			if (this.relationshipMap.get(rel.id) === rel) this.disconnect(rel.id);
			if (this.elementMap.get(rel.target.id) === rel.target) {
				this.deleteCascade(rel.target, visiting);
			}
		}
		// A self-loop sits in both arrays; the set names it once.
		for (const rel of new Set([...element.out, ...element.in])) this.disconnect(rel.id);
		this.elementMap.delete(element.id);
		this.indexes.onElementDeleted(element);
	}

	// -- mutation boundary: properties ---------------------------------------

	/**
	 * Every write bumps `rev`, a write of the same value included. Values are
	 * replaced whole, never mutated in place: recorded inverses alias them.
	 */
	setProperty(target: ElementRec | RelRec, prop: string, value: Value): void {
		this.requireDeclared(target, prop);
		setProp(target.props, prop, value);
		target.rev += 1;
		this.indexes.onPropertyChanged(target);
	}

	/** Removing a key that is not set changes nothing, `rev` included. */
	deleteProperty(target: ElementRec | RelRec, prop: string): void {
		this.requireDeclared(target, prop);
		if (!Object.hasOwn(target.props, prop)) return;
		delete target.props[prop];
		target.rev += 1;
		this.indexes.onPropertyChanged(target);
	}

	/** The entity must be this model's own record, and its type must declare the property. */
	private requireDeclared(target: ElementRec | RelRec, prop: string): void {
		const isElement = target instanceof ElementRec;
		const attached = isElement
			? this.elementMap.get(target.id)
			: this.relationshipMap.get(target.id);
		if (attached !== target) {
			throw new ModelError('key', `Entity ${pyRepr(target.id)} is not part of this model`);
		}
		const names = isElement
			? this.metamodel.effectiveElementPropertyNames(target.typeName)
			: this.metamodel.effectiveRelationshipPropertyNames(target.typeName);
		if (!names.has(prop)) {
			throw new ModelError('key', `${pyRepr(target.typeName)} has no property ${pyRepr(prop)}`);
		}
	}

	// -- mutation boundary: relationships ------------------------------------

	connect(relType: string, sourceId: string, targetId: string, id: string): RelRec {
		return this.restoreRelationship(id, relType, sourceId, targetId);
	}

	/** Inserts a relationship under a fixed id, and at its old place when `ord` is given. */
	restoreRelationship(
		id: string,
		relType: string,
		sourceId: string,
		targetId: string,
		ord?: number
	): RelRec {
		if (this.metamodel.relationshipType(relType) === undefined) {
			throw new ModelError('key', `Unknown relationship type ${pyRepr(relType)}`);
		}
		return this.insertRelationship(id, relType, sourceId, targetId, {}, 0, ord);
	}

	disconnect(relId: string): void {
		const rel = this.getRelationship(relId);
		this.relationshipMap.delete(relId);
		this.indexes.onRelationshipDeleted(rel);
	}

	// -- committed state -----------------------------------------------------
	//
	// What the server committed, and what a rewind puts back, arrives whole:
	// its types are not checked (a model may hold a type its metamodel no
	// longer has) and its `rev` is given, not counted.

	/** Inserts an element as it is, at its old place when `ord` is given. Takes over `props`. */
	insertElement(id: string, typeName: string, props: Props, rev: number, ord?: number): ElementRec {
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.elementsShuffled = true;
		const element = new ElementRec(id, typeName, props, rev, this.takeOrd(ord));
		this.elementMap.set(id, element);
		this.indexes.onElementCreated(element);
		return element;
	}

	/** Inserts a relationship as it is, at its old place when `ord` is given. Takes over `props`. */
	insertRelationship(
		id: string,
		relType: string,
		sourceId: string,
		targetId: string,
		props: Props,
		rev: number,
		ord?: number
	): RelRec {
		const source = this.elementMap.get(sourceId);
		if (source === undefined) {
			throw new ModelError('key', `No source element ${pyRepr(sourceId)}`);
		}
		const target = this.elementMap.get(targetId);
		if (target === undefined) {
			throw new ModelError('key', `No target element ${pyRepr(targetId)}`);
		}
		this.requireFreeId(id);
		if (ord !== undefined && ord < this.nextOrd) this.relationshipsShuffled = true;
		const rel = new RelRec(id, relType, source, target, props, rev, this.takeOrd(ord));
		this.relationshipMap.set(id, rel);
		this.indexes.onRelationshipCreated(rel);
		return rel;
	}

	/** Replaces an attached entity's properties and `rev` whole. Takes over `props`. */
	overwrite(target: ElementRec | RelRec, props: Props, rev: number): void {
		target.props = props;
		target.rev = rev;
		this.indexes.onPropertyChanged(target);
	}

	private requireFreeId(id: string): void {
		if (this.elementMap.has(id) || this.relationshipMap.has(id)) {
			throw new ModelError('value', `Id ${pyRepr(id)} is already in use`);
		}
	}

	private takeOrd(ord: number | undefined): number {
		if (ord === undefined) return this.nextOrd++;
		if (ord >= this.nextOrd) this.nextOrd = ord + 1;
		return ord;
	}

	// -- bulk load -----------------------------------------------------------

	/**
	 * Adds one element of a snapshot, in snapshot order, unindexed. Lenient
	 * about types — an unknown one loads, and validation reports it — and
	 * strict about structure.
	 */
	loadElement(doc: Value): void {
		const where = `elements[${this.elementMap.size}]`;
		const entity = asEntity(doc, where);
		const id = requireStr(entity, 'id', where);
		const typeName = requireStr(entity, 'type_name', where);
		if (id.startsWith(TEMP_ID_PREFIX)) throw new SnapshotError(reservedId('Element', id));
		if (this.metamodel.elementType(typeName)?.abstract) {
			throw new SnapshotError(
				`Element type ${pyRepr(typeName)} is abstract and cannot be instantiated`
			);
		}
		if (this.elementMap.has(id)) {
			throw new SnapshotError(`Duplicate element id ${pyRepr(id)} in snapshot`);
		}
		const element = new ElementRec(
			id,
			typeName,
			readProps(entity, where),
			readRev(entity, where),
			this.nextOrd++
		);
		this.elementMap.set(id, element);
	}

	/** Adds one relationship of a snapshot; every element must be loaded before the first one. */
	loadRelationship(doc: Value): void {
		const where = `relationships[${this.relationshipMap.size}]`;
		const entity = asEntity(doc, where);
		const id = requireStr(entity, 'id', where);
		const typeName = requireStr(entity, 'type_name', where);
		const sourceId = requireStr(entity, 'source_id', where);
		const targetId = requireStr(entity, 'target_id', where);
		if (id.startsWith(TEMP_ID_PREFIX)) throw new SnapshotError(reservedId('Relationship', id));
		const source = this.elementMap.get(sourceId);
		if (source === undefined) {
			throw new SnapshotError(
				`Relationship ${pyRepr(id)} references unknown source ${pyRepr(sourceId)}`
			);
		}
		const target = this.elementMap.get(targetId);
		if (target === undefined) {
			throw new SnapshotError(
				`Relationship ${pyRepr(id)} references unknown target ${pyRepr(targetId)}`
			);
		}
		if (this.relationshipMap.has(id)) {
			throw new SnapshotError(`Duplicate relationship id ${pyRepr(id)} in snapshot`);
		}
		if (this.elementMap.has(id)) {
			throw new SnapshotError(`Relationship id ${pyRepr(id)} is already an element id`);
		}
		const rel = new RelRec(
			id,
			typeName,
			source,
			target,
			readProps(entity, where),
			readRev(entity, where),
			this.nextOrd++
		);
		this.relationshipMap.set(id, rel);
	}

	/** Recomputes every index and the records' adjacency from the entities. */
	rebuildIndexes(): void {
		this.indexes.rebuild();
	}
}

function reservedId(kind: string, id: string): string {
	return (
		`${kind} id ${pyRepr(id)} uses the reserved ${pyRepr(TEMP_ID_PREFIX)} prefix ` +
		'(client-side temporary ids of the ops protocol); loaded models must not contain such ids'
	);
}
