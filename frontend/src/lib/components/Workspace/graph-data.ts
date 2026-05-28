// Pure data builder for the Graph tab.
//
// Walks the working snapshot's relationship graph outward from a center
// element via BFS, capping the result at `nodeCap` nodes and `maxHops` hops.
// Edges marked as "containment" if their relationship type (or one of its
// ancestors) is containment in the supplied metamodel.

import type { Metamodel } from '$lib/api/types';
import type { Snapshot } from '$lib/state/ops';
import { containmentRelTypes } from '../../metamodel/helpers';

export interface GraphNode {
	id: string;
	type_name: string;
	/** name property if string, else first 8 chars of id + "…". */
	label: string;
	/** Distance from center: 0 for center, 1, 2, ... */
	hops: number;
}

export interface GraphEdge {
	/** == relationship.id */
	id: string;
	source: string;
	target: string;
	type_name: string;
	containment: boolean;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** True if some neighbors were dropped due to nodeCap. */
	truncated: boolean;
}

export interface BuildGraphOpts {
	metamodel: Metamodel;
	working: Snapshot;
	centerId: string;
	maxHops?: number;
	nodeCap?: number;
}

function labelFor(el: { id: string; properties: Record<string, unknown> }): string {
	const n = el.properties?.name;
	if (typeof n === 'string' && n.length > 0) return n;
	if (el.id.length <= 8) return el.id;
	return el.id.slice(0, 8) + '…';
}

export function buildGraph(opts: BuildGraphOpts): GraphData {
	const { metamodel, working, centerId } = opts;
	const maxHops = opts.maxHops ?? 2;
	const nodeCap = opts.nodeCap ?? 60;

	const empty: GraphData = { nodes: [], edges: [], truncated: false };
	const elementById = new Map(working.elements.map((e) => [e.id, e] as const));
	const center = elementById.get(centerId);
	if (!center) return empty;

	const containmentNames = new Set(containmentRelTypes(metamodel).map((rt) => rt.name));

	// BFS frontier-by-frontier, so we can attach `hops` cleanly and respect
	// `maxHops` as a hard cap on traversal depth.
	const hopsById = new Map<string, number>();
	hopsById.set(centerId, 0);
	const nodes: GraphNode[] = [
		{ id: center.id, type_name: center.type_name, label: labelFor(center), hops: 0 }
	];
	let truncated = false;

	let frontier: string[] = [centerId];
	for (let depth = 0; depth < maxHops; depth++) {
		const nextFrontier: string[] = [];
		const addedThisHop = new Set<string>();
		// Find every relationship touching the current frontier; the other
		// endpoint becomes a candidate for the next hop.
		const inFrontier = new Set(frontier);
		for (const rel of working.relationships) {
			const sourceIn = inFrontier.has(rel.source_id);
			const targetIn = inFrontier.has(rel.target_id);
			if (!sourceIn && !targetIn) continue;
			const candidates: string[] = [];
			if (sourceIn && !hopsById.has(rel.target_id)) candidates.push(rel.target_id);
			if (targetIn && !hopsById.has(rel.source_id)) candidates.push(rel.source_id);
			for (const candId of candidates) {
				if (hopsById.has(candId) || addedThisHop.has(candId)) continue;
				const candEl = elementById.get(candId);
				if (!candEl) continue;
				if (nodes.length >= nodeCap) {
					truncated = true;
					continue;
				}
				addedThisHop.add(candId);
				hopsById.set(candId, depth + 1);
				nodes.push({
					id: candEl.id,
					type_name: candEl.type_name,
					label: labelFor(candEl),
					hops: depth + 1
				});
				nextFrontier.push(candId);
			}
		}
		if (nextFrontier.length === 0) break;
		frontier = nextFrontier;
	}

	// Emit only those edges where both endpoints made it into the final set.
	const includedIds = new Set(nodes.map((n) => n.id));
	const edges: GraphEdge[] = [];
	for (const rel of working.relationships) {
		if (!includedIds.has(rel.source_id) || !includedIds.has(rel.target_id)) continue;
		edges.push({
			id: rel.id,
			source: rel.source_id,
			target: rel.target_id,
			type_name: rel.type_name,
			containment: containmentNames.has(rel.type_name)
		});
	}

	return { nodes, edges, truncated };
}
