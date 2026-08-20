import type { Metamodel } from '$lib/api/types';
import type { DiagramSelection } from './diagram-build';

/**
 * Client-side type search for the metamodel canvas (spec 2026-08-20 §6).
 * Purely over the parsed draft — the metamodel is fully client-side, so
 * unlike element search there is no API call and no debounce-vs-staleness
 * protocol to manage. Case-insensitive substring; prefix matches rank first,
 * alphabetical within a rank. Mapless relationships are included (search is
 * one of only two ways to reach them) and flagged so the row can say so.
 * Each hit also carries the matched substring's position within `name` so
 * the dropdown can render it highlighted (spec §6) without re-deriving the
 * match itself.
 */

export interface TypeSearchHit {
	sel: DiagramSelection;
	kind: 'element' | 'relationship' | 'enum';
	name: string;
	/** Relationships only; always false for the other kinds. */
	mapless: boolean;
	/** Index in `name` where the query matched — for the dropdown's substring
	 * highlight (spec §6). Always a real index: a hit only exists on a match. */
	matchStart: number;
	/** Length of the matched run, i.e. the trimmed query's length. */
	matchLength: number;
}

export function searchTypes(mm: Metamodel, query: string, limit = 20): TypeSearchHit[] {
	const q = query.trim().toLowerCase();
	if (q === '') return [];
	// `rank` is a sort-only key, kept out of the returned hit shape rather than
	// destructured off it, so eslint's no-unused-vars has nothing to flag.
	const ranked: { hit: TypeSearchHit; rank: number }[] = [];
	const consider = (name: string, kind: TypeSearchHit['kind'], mapless = false): void => {
		const at = name.toLowerCase().indexOf(q);
		if (at < 0) return;
		ranked.push({
			hit: { sel: { kind, name }, kind, name, mapless, matchStart: at, matchLength: q.length },
			rank: at === 0 ? 0 : 1
		});
	};
	for (const el of mm.elements) consider(el.name, 'element');
	for (const rel of mm.relationships) consider(rel.name, 'relationship', rel.mappings.length === 0);
	for (const name of Object.keys(mm.enums)) consider(name, 'enum');
	ranked.sort((a, b) => a.rank - b.rank || a.hit.name.localeCompare(b.hit.name));
	return ranked.slice(0, limit).map((r) => r.hit);
}
