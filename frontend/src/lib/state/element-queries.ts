// Paged element lookups for picker UIs (NewRelationshipPicker,
// ElementRefPicker). The /model/elements type filter is EXACT-type, so a
// metamodel base type is expanded into its concrete subtypes client-side and
// fetched type by type, capped so a huge model can't flood a <select>.

import type { Element, Metamodel } from '$lib/api/types';
import { listElementsPage } from '../api/model-read';
import { isSubtype } from '../metamodel/helpers';
import { seedElements } from './model.svelte';

export interface ElementsOfTypeResult {
	/** Fetched candidates (display-name sorted), at most `cap`. */
	elements: Element[];
	/** Total matching elements server-side (across all subtypes). */
	total: number;
	/** True when `total > elements.length` (the picker should say so). */
	truncated: boolean;
}

function displayName(el: Element): string {
	const n = el.properties?.name;
	return typeof n === 'string' && n.length > 0 ? n : el.id;
}

/**
 * Fetch up to `cap` elements whose type is `baseTypeName` or a subtype of it.
 * Results are seeded into the model store cache and sorted by display name.
 */
export async function fetchElementsOfType(
	mm: Metamodel,
	baseTypeName: string,
	cap = 200
): Promise<ElementsOfTypeResult> {
	const typeNames = mm.elements
		.filter((t) => !t.abstract && isSubtype(mm, t.name, baseTypeName))
		.map((t) => t.name);

	const out: Element[] = [];
	let total = 0;
	for (const typeName of typeNames) {
		const remaining = cap - out.length;
		const page = await listElementsPage({
			type: typeName,
			limit: Math.max(1, remaining)
		});
		total += page.total;
		if (remaining > 0) out.push(...page.items.slice(0, remaining));
	}
	seedElements(out);
	out.sort((a, b) => displayName(a).localeCompare(displayName(b)));
	return { elements: out, total, truncated: total > out.length };
}
