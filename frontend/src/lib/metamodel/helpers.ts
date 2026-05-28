// Pure helpers that mirror the Python `Metamodel` operations in
// `src/data_rover/core/metamodel/schema.py`. Kept Svelte-free so they can be
// unit-tested in isolation.

import type {
	ElementType,
	Metamodel,
	PropertyDef,
	RelationshipType
} from '$lib/api/types';

/** Look up a concrete or abstract element type by name. */
export function elementType(mm: Metamodel, name: string): ElementType | undefined {
	return mm.elements.find((e) => e.name === name);
}

/** Look up a concrete or abstract relationship type by name. */
export function relationshipType(
	mm: Metamodel,
	name: string
): RelationshipType | undefined {
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
export function relationshipAncestors(
	mm: Metamodel,
	name: string
): RelationshipType[] {
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
