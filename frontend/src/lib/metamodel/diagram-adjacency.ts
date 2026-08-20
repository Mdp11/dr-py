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

const TETHER_IN = 'assoc-in:';
const TETHER_OUT = 'assoc-out:';

/** The id of the OTHER half of a boxed relationship's tether pair, or null if
 * the id is not a tether half at all.
 *
 * The two halves of one mapping differ by their prefix alone
 * (`assoc-in:<Rel>:<i>` / `assoc-out:<Rel>:<i>` in `diagram-build.ts`), so
 * swapping it is exact — no parsing of the rel name, which may itself contain
 * a colon, and no re-deriving of the mapping index. */
function siblingTetherId(id: string): string | null {
	if (id.startsWith(TETHER_IN)) return TETHER_OUT + id.slice(TETHER_IN.length);
	if (id.startsWith(TETHER_OUT)) return TETHER_IN + id.slice(TETHER_OUT.length);
	return null;
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
 *   the same `Rel: Source → Target`, recovered ACROSS the box.
 *   `buildDiagram` splits a boxed relationship's mapping into two edges —
 *   `source → rel:Name` and `rel:Name → target` — so reading a single half's
 *   own endpoints would print the box as one side (`Monitors: Building →
 *   Monitors`). {@link siblingTetherId} pairs the halves instead, and the
 *   mapping's real ends are the IN half's source and the OUT half's target.
 *   Falls back to the bare rel name when the pair is incomplete: a half is
 *   emitted only when both of ITS ends exist, so a mapping onto an undeclared
 *   type leaves one half with no partner and there is no second endpoint to
 *   name.
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
		const siblingId = siblingTetherId(hover.id);
		const siblingEnds = siblingId === null ? undefined : adj.edgeEndpoints.get(siblingId);
		if (siblingEnds === undefined) return hover.relName;
		const isIn = hover.id.startsWith(TETHER_IN);
		const outer = {
			source: selectionForNodeId((isIn ? ends : siblingEnds)[0]),
			target: selectionForNodeId((isIn ? siblingEnds : ends)[1])
		};
		// Both outer ends are element boxes in every shape `buildDiagram` emits;
		// the kind check is what keeps a future edge shape from printing a box's
		// name as an endpoint rather than degrading to the bare name.
		if (
			outer.source === null ||
			outer.target === null ||
			outer.source.kind === 'relationship' ||
			outer.target.kind === 'relationship'
		) {
			return hover.relName;
		}
		return `${hover.relName}: ${outer.source.name} → ${outer.target.name}`;
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
