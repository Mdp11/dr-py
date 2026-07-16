// Pure helpers that mirror the Python `Metamodel` operations in
// `src/data_rover/core/metamodel/schema.py`. Kept Svelte-free so they can be
// unit-tested in isolation.

import type {
	ElementType,
	Metamodel,
	PathNavigation,
	PropertyDef,
	RelationshipType
} from '$lib/api/types';

/** Look up a concrete or abstract element type by name. */
export function elementType(mm: Metamodel, name: string): ElementType | undefined {
	return mm.elements.find((e) => e.name === name);
}

/** Look up a concrete or abstract relationship type by name. */
export function relationshipType(mm: Metamodel, name: string): RelationshipType | undefined {
	return mm.relationships.find((r) => r.name === name);
}

/**
 * Walk the element `extends` chain starting at `name` (inclusive). Returns
 * `[]` if the starting type is unknown.
 */
export function elementAncestors(mm: Metamodel, name: string): ElementType[] {
	const chain: ElementType[] = [];
	const seen = new Set<string>();
	let current: string | null = name;
	while (current && !seen.has(current)) {
		const et = elementType(mm, current);
		if (!et) break;
		chain.push(et);
		seen.add(current);
		current = et.extends ?? null;
	}
	return chain;
}

/** Walk the relationship `extends` chain starting at `name` (inclusive). */
export function relationshipAncestors(mm: Metamodel, name: string): RelationshipType[] {
	const chain: RelationshipType[] = [];
	const seen = new Set<string>();
	let current: string | null = name;
	while (current && !seen.has(current)) {
		const rt = relationshipType(mm, current);
		if (!rt) break;
		chain.push(rt);
		seen.add(current);
		current = rt.extends ?? null;
	}
	return chain;
}

/**
 * Effective properties for `typeName` — own properties plus inherited ones,
 * deduped by name. When the same property name is declared by both an
 * ancestor and a descendant, the descendant (closer-to-leaf) definition wins.
 *
 * Result order: ancestor properties first, then own — keeping a stable shape
 * for form/inspector rendering.
 */
export function effectiveProperties(mm: Metamodel, typeName: string): PropertyDef[] {
	// chain is leaf -> root; reverse it so we iterate root -> leaf, then later
	// declarations replace earlier ones (child wins).
	const byName = new Map<string, PropertyDef>();
	const order: string[] = [];
	const rootToLeaf = elementAncestors(mm, typeName).slice().reverse();
	for (const et of rootToLeaf) {
		for (const p of et.properties) {
			if (!byName.has(p.name)) order.push(p.name);
			byName.set(p.name, p);
		}
	}
	return order.map((n) => byName.get(n)!);
}

/** True if `sub` is the same type as `sup` or descends from it. */
export function isSubtype(mm: Metamodel, sub: string, sup: string): boolean {
	return elementAncestors(mm, sub).some((et) => et.name === sup);
}

/**
 * Effective properties for a relationship `typeName` — own properties plus
 * those inherited through the relationship `extends` chain. Same algorithm as
 * `effectiveProperties` but walks `RelationshipType.extends`. Child overrides
 * win over ancestor declarations of the same property name.
 */
export function effectiveRelationshipProperties(mm: Metamodel, typeName: string): PropertyDef[] {
	const byName = new Map<string, PropertyDef>();
	const order: string[] = [];
	const rootToLeaf = relationshipAncestors(mm, typeName).slice().reverse();
	for (const rt of rootToLeaf) {
		for (const p of rt.properties) {
			if (!byName.has(p.name)) order.push(p.name);
			byName.set(p.name, p);
		}
	}
	return order.map((n) => byName.get(n)!);
}

/**
 * Relationship types that are containment, either directly or via inheritance
 * (mirrors `Metamodel.is_containment` in the backend). Returns all
 * relationship types whose ancestor chain contains at least one type marked
 * `containment: true`.
 */
export function containmentRelTypes(mm: Metamodel): RelationshipType[] {
	return mm.relationships.filter((rt) =>
		relationshipAncestors(mm, rt.name).some((a) => a.containment)
	);
}

/**
 * Parse a multiplicity string. Accepts `"N"`, `"L..U"`, `"L..*"`. Returns
 * `{lower: 0, upper: null}` (i.e. `0..*`) for malformed inputs so callers can
 * keep going without throwing.
 */
export function parseMultiplicity(spec: string): {
	lower: number;
	upper: number | null;
} {
	const fallback = { lower: 0, upper: null };
	if (typeof spec !== 'string') return fallback;
	const trimmed = spec.trim();
	if (trimmed === '') return fallback;
	if (trimmed === '*') return { lower: 0, upper: null };

	if (!trimmed.includes('..')) {
		const n = Number.parseInt(trimmed, 10);
		if (!Number.isFinite(n) || n < 0 || String(n) !== trimmed) return fallback;
		return { lower: n, upper: n };
	}

	const parts = trimmed.split('..');
	if (parts.length !== 2) return fallback;
	const [loStr, upStr] = parts;
	const lo = Number.parseInt(loStr, 10);
	if (!Number.isFinite(lo) || lo < 0 || String(lo) !== loStr) return fallback;

	if (upStr === '*') return { lower: lo, upper: null };
	const up = Number.parseInt(upStr, 10);
	if (!Number.isFinite(up) || up < lo || String(up) !== upStr) return fallback;
	return { lower: lo, upper: up };
}

/**
 * Union of effective (inherited) properties across `typeNames` AND their
 * subtypes. `[]` means "any type" → union over every element type. Deduped by
 * name (first occurrence wins; order is stable for form rendering). Used to
 * scope a navigation filter step's property picker to the properties reachable
 * at that point — offered as a union because navigation property matching is
 * existence-gated (an element lacking a picked property simply drops out).
 */
/**
 * True when at least one type reachable from `typeNames` (themselves + all
 * subtypes; `[]` = every element type) declares `propName` with an upper bound
 * other than 1. Unlike {@link effectivePropertiesForTypes} this looks at EVERY
 * declaration of the name (that helper dedupes first-wins, losing multiplicity
 * variance across types). Used to grey out "split into rows" when splitting
 * provably has nothing to split; callers should treat an undeclared property
 * as splittable (instance data may still hold lists).
 */
export function propertyDeclaredMany(
	mm: Metamodel,
	typeNames: string[],
	propName: string
): boolean {
	const roots = typeNames.length === 0 ? mm.elements.map((e) => e.name) : typeNames;
	for (const t of mm.elements) {
		if (!roots.some((r) => isSubtype(mm, t.name, r))) continue;
		for (const p of effectiveProperties(mm, t.name)) {
			if (p.name === propName && parseMultiplicity(p.multiplicity).upper !== 1) return true;
		}
	}
	return false;
}

/** True when `propName` is declared on ANY type reachable from `typeNames`
 * (same reachability as {@link propertyDeclaredMany}). */
export function propertyDeclared(mm: Metamodel, typeNames: string[], propName: string): boolean {
	const roots = typeNames.length === 0 ? mm.elements.map((e) => e.name) : typeNames;
	for (const t of mm.elements) {
		if (!roots.some((r) => isSubtype(mm, t.name, r))) continue;
		if (effectiveProperties(mm, t.name).some((p) => p.name === propName)) return true;
	}
	return false;
}

export function effectivePropertiesForTypes(mm: Metamodel, typeNames: string[]): PropertyDef[] {
	const roots = typeNames.length === 0 ? mm.elements.map((e) => e.name) : typeNames;
	// Expand each requested type to itself + all its subtypes.
	const reachable = new Set<string>();
	for (const t of mm.elements) {
		if (roots.some((r) => isSubtype(mm, t.name, r))) reachable.add(t.name);
	}
	const byName = new Map<string, PropertyDef>();
	for (const name of reachable) {
		for (const p of effectiveProperties(mm, name)) {
			if (!byName.has(p.name)) byName.set(p.name, p);
		}
	}
	return [...byName.values()];
}

/**
 * Element-type datatypes `propName` resolves to across `typeNames`' reachable
 * types (themselves + all subtypes; `[]` = every element type), sorted.
 * Scans EVERY declaration of the name — like {@link propertyDeclaredMany},
 * NOT {@link effectivePropertiesForTypes}, whose first-wins dedupe would lose
 * datatype variance across same-named properties. An empty result means the
 * property is nowhere an element reference: a navigation "Go to property"
 * step over it is a dead end (the chain cannot continue).
 */
export function propertyStepTargetTypes(
	mm: Metamodel,
	typeNames: string[],
	propName: string
): string[] {
	const roots = typeNames.length === 0 ? mm.elements.map((e) => e.name) : typeNames;
	const out = new Set<string>();
	for (const t of mm.elements) {
		if (!roots.some((r) => isSubtype(mm, t.name, r))) continue;
		for (const p of effectiveProperties(mm, t.name)) {
			if (p.name === propName && mm.elements.some((e) => e.name === p.datatype)) {
				out.add(p.datatype);
			}
		}
	}
	return [...out].sort();
}

/**
 * The frontier types flowing INTO `steps[index]` — the metamodel-aware
 * upgrade of `precedingTargetTypes` (navigation/tree.ts): a forward walk that
 * resolves each property step's outgoing types via
 * {@link propertyStepTargetTypes} instead of giving up to "any type".
 * `[]` still means "any type" (combine/element starts, or an unresolvable
 * property step). Filter steps never change the frontier.
 */
export function frontierTypesAt(mm: Metamodel, node: PathNavigation, index: number): string[] {
	let frontier: string[] = node.start.kind === 'scope' ? node.start.types : [];
	for (let i = 0; i < Math.min(index, node.steps.length); i++) {
		const step = node.steps[i];
		if (step.kind === 'relationship') frontier = step.target_types;
		else if (step.kind === 'property') {
			frontier = step.property_name
				? propertyStepTargetTypes(mm, frontier, step.property_name)
				: [];
		}
	}
	return frontier;
}
