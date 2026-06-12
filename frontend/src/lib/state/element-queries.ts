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
	/**
	 * Matching elements server-side across the QUERIED subtypes. Once the cap
	 * is reached, remaining subtypes are not queried at all (no request burst),
	 * so this is only a LOWER BOUND unless `totalIsExact` ("N+" in UIs).
	 */
	total: number;
	/** True when `total` covers every subtype (no query was skipped). */
	totalIsExact: boolean;
	/** True when more matches exist than were fetched (the picker should say so). */
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
	let totalIsExact = true;
	for (const typeName of typeNames) {
		const remaining = cap - out.length;
		if (remaining <= 0) {
			// cap reached: stop issuing requests; the skipped subtypes' counts are
			// unknown, so `total` degrades to a lower bound
			totalIsExact = false;
			break;
		}
		const page = await listElementsPage({ type: typeName, limit: remaining });
		total += page.total;
		out.push(...page.items.slice(0, remaining));
	}
	seedElements(out);
	out.sort((a, b) => displayName(a).localeCompare(displayName(b)));
	return { elements: out, total, totalIsExact, truncated: !totalIsExact || total > out.length };
}
