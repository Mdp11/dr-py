import type { KeyRel, KeySpec } from '../metamodel/key.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyKey } from '../value/key.ts';
import type { Value } from '../value/types.ts';
import type { Model } from './model.ts';
import { displayName } from './naming.ts';
import { ElementRec, getProp, type Props, type RelRec } from './records.ts';
import { RootOrder } from './root-order.ts';

function attach(list: RelRec[], rel: RelRec, at: 'outAt' | 'inAt'): void {
	rel[at] = list.length;
	list.push(rel);
}

/** Swap-remove: the record's stored position makes it O(1) on any degree. */
function detach(list: RelRec[], rel: RelRec, at: 'outAt' | 'inAt'): void {
	const last = list.pop()!;
	if (last !== rel) {
		list[rel[at]] = last;
		last[at] = rel[at];
	}
	rel[at] = -1;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}

const NO_REFS: ReadonlySet<string> = new Set();

/**
 * The global indexes of one model — by exact type, uniqueness, references,
 * root order — and the hooks that keep them, and the adjacency arrays on the
 * records, in step with the mutation boundary. Every structure is sparse: a
 * key whose set becomes empty is removed. Anything a set or an adjacency
 * array holds has no specified order; whatever is observable sorts.
 *
 * Uniqueness mirrors the oracle: two elements are identical when they share
 * the type, the first containment parent (or both have none) and either the
 * type's effective key (property values, then per relationship key the sorted
 * endpoint ids of exact-type edges) or, without a key, every property.
 * Buckets are keyed by a hash of that key's canonical text, so members of one
 * bucket are only candidates: the queries confirm with the exact text.
 */
export class IndexSet {
	/** Exact type name → its elements. */
	readonly byType = new Map<string, Set<ElementRec>>();
	/** Uniqueness hash → the one element filed under it, or a set of two or more. */
	readonly buckets = new Map<number, ElementRec | Set<ElementRec>>();
	/** Entity id → the element ids its reference-typed properties name. */
	readonly refsOf = new Map<string, ReadonlySet<string>>();
	/** Element id → the entities naming it; a dangling target stays indexed. */
	readonly referencers = new Map<string, Set<string>>();
	readonly roots = new RootOrder();

	private readonly model: Model;
	private readonly hashKey: (key: string) => number;
	private readonly elementRefProps = new Map<string, string[]>();
	private readonly relationshipRefProps = new Map<string, string[]>();
	private readonly keySpecs = new Map<string, KeySpec | null>();
	private outKeyRelTypes: Set<string> | null = null;
	private inKeyRelTypes: Set<string> | null = null;

	constructor(model: Model, hashKey: (key: string) => number) {
		this.model = model;
		this.hashKey = hashKey;
	}

	// -- queries -------------------------------------------------------------

	countOut(element: ElementRec, relTypeName: string): number {
		let n = 0;
		for (const rel of element.out) if (rel.typeName === relTypeName) n++;
		return n;
	}

	countIn(element: ElementRec, relTypeName: string): number {
		let n = 0;
		for (const rel of element.in) if (rel.typeName === relTypeName) n++;
		return n;
	}

	/** The ids of the entities whose properties reference this element id. */
	referencersOf(elementId: string): ReadonlySet<string> {
		return this.referencers.get(elementId) ?? NO_REFS;
	}

	/** The elements identical to this one, itself included. */
	uniqGroupOf(element: ElementRec): ElementRec[] {
		const bucket = this.buckets.get(element.uniq);
		if (!(bucket instanceof Set)) return [element];
		const key = this.uniqKey(element);
		return [...bucket].filter((other) => other === element || this.uniqKey(other) === key);
	}

	/** Every group of identical elements; `duplicatesOnly` drops the groups of one. */
	uniqGroups(duplicatesOnly: boolean): ElementRec[][] {
		const groups: ElementRec[][] = [];
		for (const bucket of this.buckets.values()) {
			if (!(bucket instanceof Set)) {
				if (!duplicatesOnly) groups.push([bucket]);
				continue;
			}
			const byKey = new Map<string, ElementRec[]>();
			for (const element of bucket) {
				const key = this.uniqKey(element);
				const group = byKey.get(key);
				if (group === undefined) byKey.set(key, [element]);
				else group.push(element);
			}
			for (const group of byKey.values()) {
				if (!duplicatesOnly || group.length >= 2) groups.push(group);
			}
		}
		return groups;
	}

	// -- hooks, called from the mutation boundary ----------------------------

	onElementCreated(element: ElementRec): void {
		let ofType = this.byType.get(element.typeName);
		if (ofType === undefined) this.byType.set(element.typeName, (ofType = new Set()));
		ofType.add(element);
		this.addToGroup(element);
		this.updateRefs(element.id, this.refsIn(element.props, this.refProps(element.typeName, true)));
		// A fresh element has no containment parent: it is a root.
		this.roots.add(element, displayName(element));
	}

	/** Called once the element's relationships are gone and it has left the model. */
	onElementDeleted(element: ElementRec): void {
		const ofType = this.byType.get(element.typeName);
		if (ofType !== undefined) {
			ofType.delete(element);
			if (ofType.size === 0) this.byType.delete(element.typeName);
		}
		this.removeFromGroup(element);
		this.updateRefs(element.id, NO_REFS);
		this.roots.remove(element);
	}

	onRelationshipCreated(rel: RelRec): void {
		attach(rel.source.out, rel, 'outAt');
		attach(rel.target.in, rel, 'inAt');
		this.updateRefs(rel.id, this.refsIn(rel.props, this.refProps(rel.typeName, false)));
		if (this.model.metamodel.isContainment(rel.typeName)) {
			// Kept in relationship order: a relationship restored with its old
			// sequence number goes back between its neighbours.
			const parents = rel.target.parents;
			let at = parents.length;
			while (at > 0 && parents[at - 1]!.ord > rel.ord) at--;
			parents.splice(at, 0, rel);
			// The first containment parent ends the target's time as a root.
			if (parents.length === 1) this.roots.remove(rel.target);
			this.rekeyIfPresent(rel.target);
		}
		this.rekeyKeyRelEndpoints(rel);
	}

	onRelationshipDeleted(rel: RelRec): void {
		detach(rel.source.out, rel, 'outAt');
		detach(rel.target.in, rel, 'inAt');
		this.updateRefs(rel.id, NO_REFS);
		if (this.model.metamodel.isContainment(rel.typeName)) {
			const parents = rel.target.parents;
			const at = parents.indexOf(rel);
			if (at >= 0) {
				parents.splice(at, 1);
				// The last containment parent gone: the target is a root again.
				if (parents.length === 0 && this.isPresent(rel.target)) {
					this.roots.add(rel.target, displayName(rel.target));
				}
			}
			this.rekeyIfPresent(rel.target);
		}
		this.rekeyKeyRelEndpoints(rel);
	}

	/** Re-derives what one entity's properties drive: references, uniqueness, root position. */
	onPropertyChanged(entity: ElementRec | RelRec): void {
		const isElement = entity instanceof ElementRec;
		this.updateRefs(
			entity.id,
			this.refsIn(entity.props, this.refProps(entity.typeName, isElement))
		);
		if (!isElement) return;
		this.rekey(entity);
		if (entity.rootName === null) return;
		const name = displayName(entity);
		if (name !== entity.rootName) {
			this.roots.remove(entity);
			this.roots.add(entity, name);
		}
	}

	// -- bulk load -----------------------------------------------------------

	/** Recomputes every index, and the adjacency arrays, from the model's entities. */
	rebuild(): void {
		this.byType.clear();
		this.buckets.clear();
		this.refsOf.clear();
		this.referencers.clear();
		for (const element of this.model.elements()) {
			element.out.length = 0;
			element.in.length = 0;
			element.parents.length = 0;
		}
		// Relationships first, in order, so that owners are known before grouping.
		for (const rel of this.model.relationships()) {
			attach(rel.source.out, rel, 'outAt');
			attach(rel.target.in, rel, 'inAt');
			this.updateRefs(rel.id, this.refsIn(rel.props, this.refProps(rel.typeName, false)));
			if (this.model.metamodel.isContainment(rel.typeName)) rel.target.parents.push(rel);
		}
		const roots: ElementRec[] = [];
		for (const element of this.model.elements()) {
			let ofType = this.byType.get(element.typeName);
			if (ofType === undefined) this.byType.set(element.typeName, (ofType = new Set()));
			ofType.add(element);
			this.addToGroup(element);
			this.updateRefs(
				element.id,
				this.refsIn(element.props, this.refProps(element.typeName, true))
			);
			element.rootName = element.parents.length === 0 ? displayName(element) : null;
			if (element.rootName !== null) roots.push(element);
		}
		this.roots.reset(roots);
	}

	// -- uniqueness ----------------------------------------------------------

	/** The canonical text of the element's identity; equal texts mean identical elements. */
	uniqKey(element: ElementRec): string {
		const owner = element.parents.length > 0 ? element.parents[0]!.source.id : null;
		const spec = this.keySpec(element.typeName);
		const signature: Value =
			spec === null
				? element.props
				: [
						spec.properties.map((name) => getProp(element.props, name) ?? null),
						spec.relationships.map((keyRel) => this.relEndpoints(element, keyRel))
					];
		return pyKey([element.typeName, owner, signature]);
	}

	private keySpec(typeName: string): KeySpec | null {
		let spec = this.keySpecs.get(typeName);
		if (spec === undefined) {
			spec = this.model.metamodel.effectiveElementKeySpec(typeName);
			this.keySpecs.set(typeName, spec);
		}
		return spec;
	}

	/** Sorted endpoint ids of the element's edges of exactly this type; subtypes do not count. */
	private relEndpoints(element: ElementRec, keyRel: KeyRel): string[] {
		const ids: string[] = [];
		if (keyRel.direction === 'out') {
			for (const rel of element.out) if (rel.typeName === keyRel.relType) ids.push(rel.target.id);
		} else {
			for (const rel of element.in) if (rel.typeName === keyRel.relType) ids.push(rel.source.id);
		}
		return ids.sort(cmpCodePoint);
	}

	private addToGroup(element: ElementRec): void {
		const hash = this.hashKey(this.uniqKey(element));
		element.uniq = hash;
		const bucket = this.buckets.get(hash);
		if (bucket === undefined) this.buckets.set(hash, element);
		else if (bucket instanceof Set) bucket.add(element);
		else this.buckets.set(hash, new Set([bucket, element]));
	}

	private removeFromGroup(element: ElementRec): void {
		const bucket = this.buckets.get(element.uniq);
		if (bucket === element) {
			this.buckets.delete(element.uniq);
		} else if (bucket instanceof Set && bucket.delete(element) && bucket.size === 1) {
			for (const last of bucket) this.buckets.set(element.uniq, last);
		}
	}

	private rekey(element: ElementRec): void {
		// An unchanged hash is an unchanged bucket, whatever the key texts are.
		if (this.hashKey(this.uniqKey(element)) === element.uniq) return;
		this.removeFromGroup(element);
		this.addToGroup(element);
	}

	private isPresent(element: ElementRec): boolean {
		return this.model.findElement(element.id) === element;
	}

	private rekeyIfPresent(element: ElementRec): void {
		if (this.isPresent(element)) this.rekey(element);
	}

	/**
	 * Rekeys an edge's endpoints when its type takes part in some key. Runs
	 * after adjacency is updated, so the key sees the graph as it now is.
	 */
	private rekeyKeyRelEndpoints(rel: RelRec): void {
		if (this.outKeyRelTypes === null || this.inKeyRelTypes === null) {
			this.outKeyRelTypes = new Set();
			this.inKeyRelTypes = new Set();
			const mm = this.model.metamodel;
			for (const type of mm.elements) {
				for (const keyRel of mm.effectiveElementKeySpec(type.name)?.relationships ?? []) {
					(keyRel.direction === 'out' ? this.outKeyRelTypes : this.inKeyRelTypes).add(
						keyRel.relType
					);
				}
			}
		}
		if (this.outKeyRelTypes.has(rel.typeName)) this.rekeyIfPresent(rel.source);
		if (this.inKeyRelTypes.has(rel.typeName)) this.rekeyIfPresent(rel.target);
	}

	// -- references ----------------------------------------------------------

	/** Names of the type's effective properties whose datatype is an element type. */
	private refProps(typeName: string, ofElement: boolean): string[] {
		const cache = ofElement ? this.elementRefProps : this.relationshipRefProps;
		let names = cache.get(typeName);
		if (names === undefined) {
			const mm = this.model.metamodel;
			const defs = ofElement
				? mm.effectiveElementProperties(typeName)
				: mm.effectiveRelationshipProperties(typeName);
			names = defs.filter((p) => mm.isElementType(p.datatype)).map((p) => p.name);
			cache.set(typeName, names);
		}
		return names;
	}

	/** A scalar or a list; only strings are references. */
	private refsIn(props: Props, refProps: readonly string[]): ReadonlySet<string> {
		if (refProps.length === 0) return NO_REFS;
		const refs = new Set<string>();
		for (const name of refProps) {
			const value = getProp(props, name);
			if (value === undefined || value === null) continue;
			for (const item of Array.isArray(value) ? value : [value]) {
				if (typeof item === 'string') refs.add(item);
			}
		}
		return refs;
	}

	private updateRefs(entityId: string, next: ReadonlySet<string>): void {
		const prev = this.refsOf.get(entityId) ?? NO_REFS;
		if (sameSet(prev, next)) return;
		for (const target of prev) {
			if (next.has(target)) continue;
			const from = this.referencers.get(target);
			if (from !== undefined) {
				from.delete(entityId);
				if (from.size === 0) this.referencers.delete(target);
			}
		}
		for (const target of next) {
			if (prev.has(target)) continue;
			let from = this.referencers.get(target);
			if (from === undefined) this.referencers.set(target, (from = new Set()));
			from.add(entityId);
		}
		if (next.size > 0) this.refsOf.set(entityId, next);
		else this.refsOf.delete(entityId);
	}
}
