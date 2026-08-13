import type { Metamodel, PropertyDef, RelationshipType } from '$lib/api/types';

/** Metamodel → UML diagram shapes (spec §2). Pure: positions, collapse state
 * and styling are the caller's concern; this module decides only WHAT exists.
 * Association-class rule: a relationship type that carries properties, is
 * abstract, extends another, or is extended, gets a `rel:` box node and its
 * mappings render as two-half edges THROUGH the box (source→box→target) —
 * the flow-graph rendering of UML's line-tethered association class. A plain
 * relationship (none of the above) renders as a single boxless edge instead,
 * since a diamond-and-line association needs no third node to anchor a label
 * or a containment marker. */

export type DiagramSelection =
	| { kind: 'element'; name: string }
	| { kind: 'relationship'; name: string }
	| { kind: 'enum'; name: string };

const PREFIX: Record<DiagramSelection['kind'], string> = {
	element: 'el',
	relationship: 'rel',
	enum: 'enum'
};

export function nodeIdFor(sel: DiagramSelection): string {
	return `${PREFIX[sel.kind]}:${sel.name}`;
}

/** Inverse of {@link nodeIdFor}. Node ids are the layout blob's position
 * keys too (see api/metamodel.ts), so this is also how a stored position
 * gets attributed back to a metamodel type when rendering. */
export function selectionForNodeId(id: string): DiagramSelection | null {
	const i = id.indexOf(':');
	if (i < 0) return null;
	const prefix = id.slice(0, i);
	const name = id.slice(i + 1);
	if (prefix === 'el') return { kind: 'element', name };
	if (prefix === 'rel') return { kind: 'relationship', name };
	if (prefix === 'enum') return { kind: 'enum', name };
	return null;
}

export interface DiagramNodeSpec {
	id: string;
	type: 'elementType' | 'enumType' | 'assocClass';
	data: Record<string, unknown>;
}

export interface DiagramEdgeSpec {
	id: string;
	source: string;
	target: string;
	type: 'generalization' | 'association';
	data: {
		relName?: string;
		label?: string;
		containment?: boolean;
		sourceMult?: string;
		targetMult?: string;
		arrow?: boolean;
	};
}

/** A relationship needs its own box node (rather than a plain edge) whenever
 * it carries information a two-endpoint line can't: own properties, or a
 * place in a generalization hierarchy (either side). */
export function needsAssocBox(rel: RelationshipType, mm: Metamodel): boolean {
	return (
		rel.properties.length > 0 ||
		rel.abstract ||
		rel.extends !== null ||
		mm.relationships.some((o) => o.extends === rel.name)
	);
}

/** The type's OWN `key` entries that name a property, i.e. excluding the
 * `out:<Rel>`/`in:<Rel>` DSL entries that key on a relationship end instead
 * — those belong to a property-list-adjacent form concern, not the canvas.
 * Effective (inherited) keys are likewise out of scope here: the canvas
 * shows what a type itself declares, not what it resolves to. */
function ownKeyProps(key: string[] | null): string[] {
	return (key ?? []).filter((k) => !k.startsWith('out:') && !k.startsWith('in:'));
}

export function buildDiagram(mm: Metamodel): {
	nodes: DiagramNodeSpec[];
	edges: DiagramEdgeSpec[];
} {
	const nodes: DiagramNodeSpec[] = [];

	for (const el of mm.elements) {
		nodes.push({
			id: nodeIdFor({ kind: 'element', name: el.name }),
			type: 'elementType',
			data: {
				name: el.name,
				abstract: el.abstract,
				properties: el.properties,
				keyProps: ownKeyProps(el.key),
				extendsName: el.extends
			}
		});
	}
	for (const [name, literals] of Object.entries(mm.enums)) {
		nodes.push({
			id: nodeIdFor({ kind: 'enum', name }),
			type: 'enumType',
			data: { name, literals }
		});
	}
	const boxed = new Set(mm.relationships.filter((r) => needsAssocBox(r, mm)).map((r) => r.name));
	for (const rel of mm.relationships) {
		if (!boxed.has(rel.name)) continue;
		nodes.push({
			id: nodeIdFor({ kind: 'relationship', name: rel.name }),
			type: 'assocClass',
			data: { name: rel.name, abstract: rel.abstract, properties: rel.properties }
		});
	}

	// Mid-edit metamodels can reference a type that was just renamed/deleted
	// in the same draft (yaml-edit's rename cascade doesn't reach every
	// referent — see its docstrings). Every edge below is built ONLY once
	// both its endpoint node ids are confirmed present, so the canvas never
	// hands Svelte Flow an edge it can't anchor.
	const nodeIds = new Set(nodes.map((n) => n.id));
	const hasBoth = (a: string, b: string): boolean => nodeIds.has(a) && nodeIds.has(b);

	const edges: DiagramEdgeSpec[] = [];

	for (const el of mm.elements) {
		if (el.extends === null) continue;
		const source = nodeIdFor({ kind: 'element', name: el.name });
		const target = nodeIdFor({ kind: 'element', name: el.extends });
		if (hasBoth(source, target)) {
			edges.push({ id: `gen:${source}`, source, target, type: 'generalization', data: {} });
		}
	}
	for (const rel of mm.relationships) {
		if (rel.extends === null) continue;
		const source = nodeIdFor({ kind: 'relationship', name: rel.name });
		const target = nodeIdFor({ kind: 'relationship', name: rel.extends });
		if (hasBoth(source, target)) {
			edges.push({ id: `gen:${source}`, source, target, type: 'generalization', data: {} });
		}
	}

	// Endpoints come from `mappings` ONLY, never the `source`/`target`
	// shorthand: the shorthand is a serialization mirror that can go stale
	// mid-edit (see yaml-edit's syncShorthand), and a mapless relationship
	// carries that shorthand as `''`/`''` rather than being absent — using it
	// here would try to anchor an edge on a node id like `el:` that never
	// exists. Iterating `mappings` (empty for a mapless relationship) sidesteps
	// the sentinel entirely rather than special-casing it.
	for (const rel of mm.relationships) {
		const isBoxed = boxed.has(rel.name);
		const relNodeId = nodeIdFor({ kind: 'relationship', name: rel.name });
		rel.mappings.forEach((mapping, i) => {
			const srcId = nodeIdFor({ kind: 'element', name: mapping.source });
			const tgtId = nodeIdFor({ kind: 'element', name: mapping.target });
			if (!isBoxed) {
				if (hasBoth(srcId, tgtId)) {
					edges.push({
						id: `assoc:${rel.name}:${i}`,
						source: srcId,
						target: tgtId,
						type: 'association',
						data: {
							relName: rel.name,
							label: rel.name,
							containment: rel.containment,
							sourceMult: rel.source_multiplicity,
							targetMult: rel.target_multiplicity,
							arrow: true
						}
					});
				}
				return;
			}
			if (hasBoth(srcId, relNodeId)) {
				edges.push({
					id: `assoc-in:${rel.name}:${i}`,
					source: srcId,
					target: relNodeId,
					type: 'association',
					data: {
						relName: rel.name,
						label: rel.name,
						containment: rel.containment,
						sourceMult: rel.source_multiplicity
					}
				});
			}
			if (hasBoth(relNodeId, tgtId)) {
				edges.push({
					id: `assoc-out:${rel.name}:${i}`,
					source: relNodeId,
					target: tgtId,
					type: 'association',
					data: { relName: rel.name, arrow: true, targetMult: rel.target_multiplicity }
				});
			}
		});
	}

	return { nodes, edges };
}

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 40;
const MAX_ROWS = 12;

/** Box footprint for elkjs layout and canvas rendering alike (Task 8 imports
 * this so the two never compute different sizes for the same node). Row
 * count is capped so a type with dozens of properties doesn't blow out the
 * layout — the node scrolls internally past the cap rather than growing. */
export function nodeSize(
	spec: DiagramNodeSpec,
	collapsed: boolean
): { width: number; height: number } {
	const width = spec.type === 'enumType' ? 200 : 240;
	if (collapsed) return { width, height: HEADER_HEIGHT };
	const rows =
		spec.type === 'enumType'
			? ((spec.data.literals as unknown[] | undefined)?.length ?? 0)
			: ((spec.data.properties as PropertyDef[] | undefined)?.length ?? 0);
	const height = HEADER_HEIGHT + ROW_HEIGHT * Math.min(rows, MAX_ROWS);
	return { width, height };
}
