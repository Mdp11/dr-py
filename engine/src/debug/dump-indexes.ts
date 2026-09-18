import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { cmpCodePoint } from '../value/compare.ts';

/**
 * The canonical rendering of a model's indexes, as the oracle dumps its own:
 * everything unordered is sorted by code point, every mapping is a list of
 * pairs, and only non-empty entries appear.
 */
export type IndexDump = {
	by_type: [type: string, elementIds: string[]][];
	out: [elementId: string, relationshipIds: string[]][];
	in: [elementId: string, relationshipIds: string[]][];
	out_count: [elementId: string, relType: string, count: number][];
	in_count: [elementId: string, relType: string, count: number][];
	/** Parents, and the relationships holding them, in relationship order. */
	parents: [childId: string, parentIds: string[], relationshipIds: string[]][];
	refs: [entityId: string, targetIds: string[]][];
	referencers: [targetId: string, entityIds: string[]][];
	uniq_groups: string[][];
	duplicates: string[][];
	roots: [displayName: string, elementId: string][];
};

const ids = (recs: Iterable<{ id: string }>) => [...recs].map((rec) => rec.id).sort(cmpCodePoint);

function sortedPairs(map: ReadonlyMap<string, ReadonlySet<string>>): [string, string[]][] {
	return [...map.keys()]
		.sort(cmpCodePoint)
		.map((key) => [key, [...map.get(key)!].sort(cmpCodePoint)]);
}

function counts(element: ElementRec, rels: readonly RelRec[]): [string, string, number][] {
	const byType = new Map<string, number>();
	for (const rel of rels) byType.set(rel.typeName, (byType.get(rel.typeName) ?? 0) + 1);
	return [...byType.keys()].sort(cmpCodePoint).map((type) => [element.id, type, byType.get(type)!]);
}

function groups(found: ElementRec[][]): string[][] {
	return found.map(ids).sort((a, b) => cmpCodePoint(a[0]!, b[0]!));
}

export function dumpIndexes(model: Model): IndexDump {
	const ix = model.indexes;
	const elements = [...model.elements()].sort((a, b) => cmpCodePoint(a.id, b.id));
	return {
		by_type: [...ix.byType.keys()]
			.sort(cmpCodePoint)
			.map((type) => [type, ids(ix.byType.get(type)!)]),
		out: elements.filter((e) => e.out.length > 0).map((e) => [e.id, ids(e.out)]),
		in: elements.filter((e) => e.in.length > 0).map((e) => [e.id, ids(e.in)]),
		out_count: elements.flatMap((e) => counts(e, e.out)),
		in_count: elements.flatMap((e) => counts(e, e.in)),
		parents: elements
			.filter((e) => e.parents.length > 0)
			.map((e) => [e.id, e.parents.map((rel) => rel.source.id), e.parents.map((rel) => rel.id)]),
		refs: sortedPairs(ix.refsOf),
		referencers: sortedPairs(ix.referencers),
		uniq_groups: groups(ix.uniqGroups(false)),
		duplicates: groups(ix.uniqGroups(true)),
		roots: ix.roots.list().map((e) => [e.rootName!, e.id])
	};
}
