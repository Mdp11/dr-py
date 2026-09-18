import { parseKey, type KeySpec } from './key.ts';
import { Multiplicity } from './multiplicity.ts';
import type { ElementType, MetamodelDoc, PropertyDef, RelationshipType } from './types.ts';

/**
 * A relationship-end multiplicity binding an element type. `end: 'target'`:
 * the type is a subtype of a mapping source, and the relationship type's target
 * multiplicity bounds the element's OUTGOING count. `end: 'source'`: the type
 * is a subtype of a mapping target, and the source multiplicity bounds its
 * INCOMING count.
 */
export type EndConstraint = {
	relTypeName: string;
	end: 'source' | 'target';
	multiplicity: Multiplicity;
};

type Typed = { name: string; extends: string | null; properties: PropertyDef[] };

const NO_NAMES: ReadonlySet<string> = new Set();
const NONE: readonly never[] = [];

/** The first type of each name wins, as a linear scan would find it. */
function byName<T extends Typed>(types: readonly T[]): Map<string, T> {
	const out = new Map<string, T>();
	for (const type of types) if (!out.has(type.name)) out.set(type.name, type);
	return out;
}

/** The type itself first, then up its `extends` chain; stops at a cycle or an unknown name. */
function ancestorChain(name: string, types: ReadonlyMap<string, Typed>): string[] {
	const chain: string[] = [];
	const seen = new Set<string>();
	let current: string | null = name;
	while (current && !seen.has(current)) {
		const type = types.get(current);
		if (type === undefined) break;
		chain.push(current);
		seen.add(current);
		current = type.extends;
	}
	return chain;
}

/** Root first; on a name clash the definition nearest the root stays. */
function effectiveProps(
	chain: readonly string[],
	types: ReadonlyMap<string, Typed>
): PropertyDef[] {
	const props: PropertyDef[] = [];
	const seen = new Set<string>();
	for (let i = chain.length - 1; i >= 0; i--) {
		for (const prop of types.get(chain[i]!)!.properties) {
			if (seen.has(prop.name)) continue;
			props.push(prop);
			seen.add(prop.name);
		}
	}
	return props;
}

/** The parsed multiplicity, or `null` when it is invalid or can never be violated. */
function bindingMultiplicity(spec: string): Multiplicity | null {
	let parsed: Multiplicity;
	try {
		parsed = Multiplicity.parse(spec);
	} catch {
		return null;
	}
	return parsed.lower === 0 && parsed.upper === null ? null : parsed;
}

function overlaps(names: ReadonlySet<string>, ancestors: ReadonlySet<string>): boolean {
	for (const name of names) if (ancestors.has(name)) return true;
	return false;
}

function descendantsOf(ancestorSets: ReadonlyMap<string, ReadonlySet<string>>) {
	const out = new Map<string, Set<string>>();
	for (const name of ancestorSets.keys()) out.set(name, new Set());
	for (const [name, ancestors] of ancestorSets) {
		for (const ancestor of ancestors) out.get(ancestor)!.add(name);
	}
	return out;
}

function mapValues<A, B>(source: ReadonlyMap<string, A>, fn: (value: A) => B): Map<string, B> {
	const out = new Map<string, B>();
	for (const [key, value] of source) out.set(key, fn(value));
	return out;
}

/**
 * An immutable metamodel with every derived lookup built up front. The
 * document is trusted: the server validates a metamodel before serving it.
 * Returned arrays and sets are shared — do not mutate them.
 */
export class Metamodel {
	readonly enums: { readonly [name: string]: readonly string[] };
	readonly elements: readonly ElementType[];
	readonly relationships: readonly RelationshipType[];

	private readonly typesByName: Map<string, ElementType>;
	private readonly relTypesByName: Map<string, RelationshipType>;
	private readonly elementChains: Map<string, string[]>;
	private readonly relationshipChains: Map<string, string[]>;
	private readonly elementAncestorSets: Map<string, Set<string>>;
	private readonly relationshipAncestorSets: Map<string, Set<string>>;
	private readonly elementProps: Map<string, PropertyDef[]>;
	private readonly relationshipProps: Map<string, PropertyDef[]>;
	private readonly elementPropNames: Map<string, Set<string>>;
	private readonly relationshipPropNames: Map<string, Set<string>>;
	private readonly elementKeys: Map<string, string[] | null>;
	private readonly elementKeySpecs: Map<string, KeySpec | null>;
	private readonly containment: Map<string, boolean>;
	private readonly constraints: Map<string, EndConstraint[]>;
	private readonly elementDescendantSets: Map<string, Set<string>>;
	private readonly relationshipDescendantSets: Map<string, Set<string>>;
	private readonly relTypesFrom: Map<string, string[]>;
	private readonly relTypesTo: Map<string, string[]>;

	private constructor(doc: MetamodelDoc) {
		this.enums = doc.enums;
		this.elements = doc.elements;
		this.relationships = doc.relationships;

		const types = (this.typesByName = byName(doc.elements));
		const relTypes = (this.relTypesByName = byName(doc.relationships));
		this.elementChains = mapValues(types, (t) => ancestorChain(t.name, types));
		this.relationshipChains = mapValues(relTypes, (t) => ancestorChain(t.name, relTypes));
		this.elementAncestorSets = mapValues(this.elementChains, (chain) => new Set(chain));
		this.relationshipAncestorSets = mapValues(this.relationshipChains, (chain) => new Set(chain));
		this.elementProps = mapValues(this.elementChains, (chain) => effectiveProps(chain, types));
		this.relationshipProps = mapValues(this.relationshipChains, (chain) =>
			effectiveProps(chain, relTypes)
		);
		this.elementPropNames = mapValues(this.elementProps, (ps) => new Set(ps.map((p) => p.name)));
		this.relationshipPropNames = mapValues(
			this.relationshipProps,
			(ps) => new Set(ps.map((p) => p.name))
		);

		// The nearest declared key wins, walking from the type up; `[]` is a declared key.
		this.elementKeys = mapValues(this.elementChains, (chain) => {
			for (const name of chain) {
				const key = types.get(name)!.key;
				if (key !== null) return [...key];
			}
			return null;
		});
		this.elementKeySpecs = mapValues(this.elementKeys, (key) =>
			key === null ? null : parseKey(key)
		);
		this.containment = mapValues(this.relationshipChains, (chain) =>
			chain.some((name) => relTypes.get(name)!.containment)
		);
		this.elementDescendantSets = descendantsOf(this.elementAncestorSets);
		this.relationshipDescendantSets = descendantsOf(this.relationshipAncestorSets);

		// Every declared relationship type counts here, a repeated name included.
		this.constraints = mapValues(types, (): EndConstraint[] => []);
		this.relTypesFrom = mapValues(types, (): string[] => []);
		this.relTypesTo = mapValues(types, (): string[] => []);
		for (const rt of doc.relationships) {
			if (rt.abstract || rt.mappings.length === 0) continue;
			const targetMult = bindingMultiplicity(rt.target_multiplicity);
			const sourceMult = bindingMultiplicity(rt.source_multiplicity);
			const sources = new Set(rt.mappings.map((m) => m.source));
			const targets = new Set(rt.mappings.map((m) => m.target));
			for (const [typeName, ancestors] of this.elementAncestorSets) {
				if (overlaps(sources, ancestors)) {
					this.relTypesFrom.get(typeName)!.push(rt.name);
					if (targetMult !== null) {
						this.constraints
							.get(typeName)!
							.push({ relTypeName: rt.name, end: 'target', multiplicity: targetMult });
					}
				}
				if (overlaps(targets, ancestors)) {
					this.relTypesTo.get(typeName)!.push(rt.name);
					if (sourceMult !== null) {
						this.constraints
							.get(typeName)!
							.push({ relTypeName: rt.name, end: 'source', multiplicity: sourceMult });
					}
				}
			}
		}
	}

	static fromJSON(doc: MetamodelDoc): Metamodel {
		return new Metamodel(doc);
	}

	elementType(name: string): ElementType | undefined {
		return this.typesByName.get(name);
	}

	isElementType(name: string): boolean {
		return this.typesByName.has(name);
	}

	relationshipType(name: string): RelationshipType | undefined {
		return this.relTypesByName.get(name);
	}

	/** The type itself first, then its ancestors; empty for an unknown name. */
	elementAncestors(name: string): readonly string[] {
		return this.elementChains.get(name) ?? NONE;
	}

	relationshipAncestors(name: string): readonly string[] {
		return this.relationshipChains.get(name) ?? NONE;
	}

	isElementSubtype(sub: string, sup: string): boolean {
		return this.elementAncestorSets.get(sub)?.has(sup) ?? false;
	}

	isRelationshipSubtype(sub: string, sup: string): boolean {
		return this.relationshipAncestorSets.get(sub)?.has(sup) ?? false;
	}

	/** Inherited properties first; on a name clash the ancestor's definition stays. */
	effectiveElementProperties(name: string): readonly PropertyDef[] {
		return this.elementProps.get(name) ?? NONE;
	}

	effectiveElementPropertyNames(name: string): ReadonlySet<string> {
		return this.elementPropNames.get(name) ?? NO_NAMES;
	}

	/** The nearest key declared up the `extends` chain, or `null`. */
	effectiveElementKey(name: string): readonly string[] | null {
		return this.elementKeys.get(name) ?? null;
	}

	effectiveElementKeySpec(name: string): KeySpec | null {
		return this.elementKeySpecs.get(name) ?? null;
	}

	effectiveRelationshipProperties(name: string): readonly PropertyDef[] {
		return this.relationshipProps.get(name) ?? NONE;
	}

	effectiveRelationshipPropertyNames(name: string): ReadonlySet<string> {
		return this.relationshipPropNames.get(name) ?? NO_NAMES;
	}

	/** True when the type or any ancestor is flagged `containment`. */
	isContainment(relTypeName: string): boolean {
		return this.containment.get(relTypeName) ?? false;
	}

	/** Constraints that can be violated; a `0..*` end binds nothing and is left out. */
	endConstraints(typeName: string): readonly EndConstraint[] {
		return this.constraints.get(typeName) ?? NONE;
	}

	/** The type plus every transitive subtype; empty for an unknown name. */
	elementDescendants(name: string): ReadonlySet<string> {
		return this.elementDescendantSets.get(name) ?? NO_NAMES;
	}

	relationshipDescendants(name: string): ReadonlySet<string> {
		return this.relationshipDescendantSets.get(name) ?? NO_NAMES;
	}

	/** Non-abstract relationship types accepting the type, or an ancestor, as a mapping source. */
	relationshipTypesFrom(name: string): readonly string[] {
		return this.relTypesFrom.get(name) ?? NONE;
	}

	/** Non-abstract relationship types accepting the type, or an ancestor, as a mapping target. */
	relationshipTypesTo(name: string): readonly string[] {
		return this.relTypesTo.get(name) ?? NONE;
	}
}
