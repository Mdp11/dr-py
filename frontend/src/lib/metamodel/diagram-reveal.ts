import type { Metamodel } from '$lib/api/types';
import { buildDiagram, nodeIdFor, nodeSize, type DiagramSelection } from './diagram-build';

/**
 * Where the canvas should GO to show a selection: the
 * pure geometry half of the shared reveal path — search and the panel TOC
 * both route through it, so the two can never pan differently.
 *
 * Element / enum → center on the box. Relationship → the union rect of every
 * box it involves: its assoc-class box (when boxed) plus every mapping
 * endpoint that is actually drawn — fitting ALL the stereotype pairs a
 * multi-mapping relationship connects on screen at once. `none` when nothing
 * is drawn (a plain mapless relationship): the caller selects without
 * panning, and the form panel is the destination.
 *
 * Positions default to (0,0) exactly like `specToNode`, and sizes come from
 * `nodeSize`, so this works for nodes the viewport has never rendered.
 */

export type RevealTarget =
	| { kind: 'center'; x: number; y: number }
	| { kind: 'bounds'; rect: { x: number; y: number; width: number; height: number } }
	| { kind: 'none' };

export function revealTarget(
	sel: DiagramSelection,
	mm: Metamodel,
	positions: Record<string, { x: number; y: number }>,
	collapsed: ReadonlySet<string>
): RevealTarget {
	const built = buildDiagram(mm);
	const specById = new Map(built.nodes.map((n) => [n.id, n]));
	const rectFor = (id: string): { x: number; y: number; width: number; height: number } | null => {
		const spec = specById.get(id);
		if (spec === undefined) return null;
		const pos = positions[id] ?? { x: 0, y: 0 };
		const size = nodeSize(spec, collapsed.has(id));
		return { x: pos.x, y: pos.y, width: size.width, height: size.height };
	};

	if (sel.kind !== 'relationship') {
		const rect = rectFor(nodeIdFor(sel));
		if (rect === null) return { kind: 'none' };
		return { kind: 'center', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	}

	const rel = mm.relationships.find((r) => r.name === sel.name);
	if (rel === undefined) return { kind: 'none' };
	const ids = new Set<string>([nodeIdFor({ kind: 'relationship', name: sel.name })]);
	for (const m of rel.mappings) {
		ids.add(nodeIdFor({ kind: 'element', name: m.source }));
		ids.add(nodeIdFor({ kind: 'element', name: m.target }));
	}
	const rects = [...ids].map(rectFor).filter((r) => r !== null);
	if (rects.length === 0) return { kind: 'none' };
	const minX = Math.min(...rects.map((r) => r.x));
	const minY = Math.min(...rects.map((r) => r.y));
	const maxX = Math.max(...rects.map((r) => r.x + r.width));
	const maxY = Math.max(...rects.map((r) => r.y + r.height));
	return { kind: 'bounds', rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
}
