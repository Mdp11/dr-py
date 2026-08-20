import { selectionForNodeId, type DiagramEdgeSpec } from './diagram-build';

/**
 * Adjacency over a built diagram, derived ONCE per `buildDiagram` result and
 * read on every hover (spec 2026-08-20 §3.2). Pure and O(edges): hover
 * handling must never walk the metamodel, and — the load-bearing rule — must
 * never rebuild the flow's node/edge arrays, so everything a node or edge
 * component needs to style itself is precomputed here.
 *
 * Generalization edges participate but have no relationship NAME, so they are
 * reachable through `nodeEdges`/`edgeEndpoints` (keyed by edge id) rather
 * than `relEdges`/`relNodes` (keyed by rel name) — the invariant is that
 * hovering a node lights every incident edge of BOTH kinds.
 */

export type DiagramHover =
	| { kind: 'node'; id: string }
	| { kind: 'edge'; id: string; relName: string | null };

export interface DiagramAdjacency {
	/** edge id → its two endpoint node ids (assoc halves and gens alike). */
	edgeEndpoints: ReadonlyMap<string, readonly [string, string]>;
	/** node id → every incident edge id, both directions, gens included. */
	nodeEdges: ReadonlyMap<string, ReadonlySet<string>>;
	/** rel name → every edge id carrying it (all mappings, both tether halves). */
	relEdges: ReadonlyMap<string, ReadonlySet<string>>;
	/** rel name → every node id an edge of the rel touches (assoc box included). */
	relNodes: ReadonlyMap<string, ReadonlySet<string>>;
}

export function buildAdjacency(edges: DiagramEdgeSpec[]): DiagramAdjacency {
	const edgeEndpoints = new Map<string, readonly [string, string]>();
	const nodeEdges = new Map<string, Set<string>>();
	const relEdges = new Map<string, Set<string>>();
	const relNodes = new Map<string, Set<string>>();
	const addTo = <K>(map: Map<K, Set<string>>, key: K, value: string): void => {
		let set = map.get(key);
		if (set === undefined) {
			set = new Set();
			map.set(key, set);
		}
		set.add(value);
	};
	for (const e of edges) {
		edgeEndpoints.set(e.id, [e.source, e.target]);
		addTo(nodeEdges, e.source, e.id);
		addTo(nodeEdges, e.target, e.id);
		const rel = e.data.relName;
		if (rel !== undefined) {
			addTo(relEdges, rel, e.id);
			addTo(relNodes, rel, e.source);
			addTo(relNodes, rel, e.target);
		}
	}
	return { edgeEndpoints, nodeEdges, relEdges, relNodes };
}

export interface HighlightSet {
	nodes: ReadonlySet<string>;
	edges: ReadonlySet<string>;
}

/** The neighborhood a hover lights up (spec §5). Node → itself + incident
 * edges + their other endpoints. Edge with a rel name → the WHOLE relationship
 * (all mappings, both tether halves — consistent with click-selection: one
 * relationship reads as one thing). Generalization edge → itself + its two
 * boxes. Tolerant of ids the index doesn't know (mid-edit staleness): the
 * result just shrinks, it never throws. */
export function highlightFor(hover: DiagramHover, adj: DiagramAdjacency): HighlightSet {
	const nodes = new Set<string>();
	const edges = new Set<string>();
	if (hover.kind === 'node') {
		nodes.add(hover.id);
		for (const edgeId of adj.nodeEdges.get(hover.id) ?? []) {
			edges.add(edgeId);
			const ends = adj.edgeEndpoints.get(edgeId);
			if (ends !== undefined) {
				nodes.add(ends[0]);
				nodes.add(ends[1]);
			}
		}
	} else if (hover.relName !== null) {
		for (const edgeId of adj.relEdges.get(hover.relName) ?? []) edges.add(edgeId);
		for (const nodeId of adj.relNodes.get(hover.relName) ?? []) nodes.add(nodeId);
	} else {
		edges.add(hover.id);
		const ends = adj.edgeEndpoints.get(hover.id);
		if (ends !== undefined) {
			nodes.add(ends[0]);
			nodes.add(ends[1]);
		}
	}
	return { nodes, edges };
}

/** Tooltip copy for the LOD cursor tooltip (spec §4): the hovered thing's
 * name, at whatever level of detail its kind supports.
 *
 * - Node → the type's own name.
 * - Generalization edge (no rel name) → `Sub ▷ Super` (the triangle mirrors
 *   the canvas marker).
 * - An ORDINARY mapping edge (a plain association, or a boxed relationship's
 *   assoc-class box is NOT one of its own endpoints) → `Rel: Source → Target`.
 *   This is the one branch the LOD mode actually needs the extra detail for:
 *   with box labels hidden at low zoom, the tooltip is the only place a
 *   viewer can read what the edge connects.
 * - A TETHER HALF of a boxed relationship (either endpoint resolves to a
 *   `relationship`-kind selection, i.e. it's the `rel:<Name>` box itself) →
 *   just the bare rel name. `buildDiagram` splits a boxed relationship's
 *   mapping into two edges — `source → rel:Name` and `rel:Name → target` —
 *   so applying `Source → Target` to either HALF alone would print nonsense
 *   like `Monitors: Building → Monitors` (the box, not the real target,
 *   showing up as one side). Collapsing to the bare name keeps the tooltip
 *   honest about what a single tether half actually is: one leg of a
 *   three-node relationship, not a two-endpoint mapping in its own right.
 *
 * Null when nothing nameable (unindexed id, or an endpoint the index lost
 * track of) — the tooltip simply doesn't render. Never throws on an id the
 * index doesn't know. */
export function hoverLabel(hover: DiagramHover, adj: DiagramAdjacency): string | null {
	if (hover.kind === 'node') return selectionForNodeId(hover.id)?.name ?? null;
	if (hover.relName === null) {
		const ends = adj.edgeEndpoints.get(hover.id);
		if (ends === undefined) return null;
		const sub = selectionForNodeId(ends[0])?.name;
		const sup = selectionForNodeId(ends[1])?.name;
		return sub !== undefined && sup !== undefined ? `${sub} ▷ ${sup}` : null;
	}
	const ends = adj.edgeEndpoints.get(hover.id);
	if (ends === undefined) return null;
	const sourceSel = selectionForNodeId(ends[0]);
	const targetSel = selectionForNodeId(ends[1]);
	if (sourceSel?.kind === 'relationship' || targetSel?.kind === 'relationship') {
		return hover.relName;
	}
	if (sourceSel === null || targetSel === null) return null;
	return `${hover.relName}: ${sourceSel.name} → ${targetSel.name}`;
}

/** The one place the hot/dim/normal decision lives, so the five components
 * that apply it (three nodes, two edges) cannot drift. Selected-but-outside
 * stays 'normal': selection must never be dimmed away (spec §5). */
export function visualState(
	id: string,
	kind: 'node' | 'edge',
	selected: boolean,
	highlight: HighlightSet | null
): 'hot' | 'dim' | 'normal' {
	if (highlight === null) return 'normal';
	const set = kind === 'node' ? highlight.nodes : highlight.edges;
	if (set.has(id)) return 'hot';
	return selected ? 'normal' : 'dim';
}
