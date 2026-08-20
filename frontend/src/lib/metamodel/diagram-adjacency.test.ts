import { describe, expect, it } from 'vitest';

import type { DiagramEdgeSpec } from './diagram-build';
import {
	buildAdjacency,
	highlightFor,
	hoverLabel,
	visualState,
	type DiagramHover
} from './diagram-adjacency';

/** Hand-built edge list mirroring the FIXTURE metamodel's shapes: one
 * generalization, one plain association, one boxed relationship whose two
 * tether halves must read as ONE relationship, and one association whose
 * endpoint ids are deliberately unresolvable (neither `nope` nor `also-nope`
 * carries a recognized `el:`/`rel:`/`enum:` prefix) to exercise `hoverLabel`'s
 * unresolvable-endpoint fallback without disturbing any other fixture node's
 * adjacency. */
const EDGES: DiagramEdgeSpec[] = [
	{
		id: 'gen:el:Zone',
		source: 'el:Zone',
		target: 'el:NamedElement',
		type: 'generalization',
		data: {}
	},
	{
		id: 'assoc:Contains:0',
		source: 'el:Zone',
		target: 'el:Building',
		type: 'association',
		data: { relName: 'Contains' }
	},
	{
		id: 'assoc-in:Monitors:0',
		source: 'el:Building',
		target: 'rel:Monitors',
		type: 'association',
		data: { relName: 'Monitors' }
	},
	{
		id: 'assoc-out:Monitors:0',
		source: 'rel:Monitors',
		target: 'el:Zone',
		type: 'association',
		data: { relName: 'Monitors' }
	},
	{
		id: 'assoc:Weird:0',
		source: 'nope',
		target: 'also-nope',
		type: 'association',
		data: { relName: 'Weird' }
	}
];

describe('buildAdjacency', () => {
	const adj = buildAdjacency(EDGES);

	it('indexes every edge (generalizations included) under both endpoints', () => {
		expect(adj.nodeEdges.get('el:Zone')).toEqual(
			new Set(['gen:el:Zone', 'assoc:Contains:0', 'assoc-out:Monitors:0'])
		);
		expect(adj.nodeEdges.get('el:NamedElement')).toEqual(new Set(['gen:el:Zone']));
	});

	it('groups a boxed relationship’s tether halves under one rel name', () => {
		expect(adj.relEdges.get('Monitors')).toEqual(
			new Set(['assoc-in:Monitors:0', 'assoc-out:Monitors:0'])
		);
		expect(adj.relNodes.get('Monitors')).toEqual(
			new Set(['el:Building', 'rel:Monitors', 'el:Zone'])
		);
	});

	it('records each edge’s two endpoints', () => {
		expect(adj.edgeEndpoints.get('gen:el:Zone')).toEqual(['el:Zone', 'el:NamedElement']);
	});
});

describe('highlightFor', () => {
	const adj = buildAdjacency(EDGES);

	it('node hover lights the node, every incident edge, and each other endpoint', () => {
		const hover: DiagramHover = { kind: 'node', id: 'el:Zone' };
		const h = highlightFor(hover, adj);
		expect(h.nodes).toEqual(new Set(['el:Zone', 'el:NamedElement', 'el:Building', 'rel:Monitors']));
		expect(h.edges).toEqual(new Set(['gen:el:Zone', 'assoc:Contains:0', 'assoc-out:Monitors:0']));
	});

	it('association hover lights ALL edges of the relationship plus every endpoint', () => {
		const hover: DiagramHover = { kind: 'edge', id: 'assoc-in:Monitors:0', relName: 'Monitors' };
		const h = highlightFor(hover, adj);
		expect(h.edges).toEqual(new Set(['assoc-in:Monitors:0', 'assoc-out:Monitors:0']));
		expect(h.nodes).toEqual(new Set(['el:Building', 'rel:Monitors', 'el:Zone']));
	});

	it('generalization hover (no relName) lights just that edge and its two boxes', () => {
		const hover: DiagramHover = { kind: 'edge', id: 'gen:el:Zone', relName: null };
		const h = highlightFor(hover, adj);
		expect(h.edges).toEqual(new Set(['gen:el:Zone']));
		expect(h.nodes).toEqual(new Set(['el:Zone', 'el:NamedElement']));
	});

	it('a hover over something no longer indexed yields an empty set, not a crash', () => {
		const hover: DiagramHover = { kind: 'node', id: 'el:Gone' };
		const h = highlightFor(hover, adj);
		expect(h.nodes).toEqual(new Set(['el:Gone']));
		expect(h.edges).toEqual(new Set());
	});
});

describe('hoverLabel', () => {
	const adj = buildAdjacency(EDGES);

	it('names the hovered thing: node name, a mapping edge as `Rel: Source → Target`, or sub ▷ super', () => {
		expect(hoverLabel({ kind: 'node', id: 'el:Zone' }, adj)).toBe('Zone');
		expect(hoverLabel({ kind: 'edge', id: 'assoc:Contains:0', relName: 'Contains' }, adj)).toBe(
			'Contains: Zone → Building'
		);
		expect(hoverLabel({ kind: 'edge', id: 'gen:el:Zone', relName: null }, adj)).toBe(
			'Zone ▷ NamedElement'
		);
	});

	/**
	 * A boxed relationship's mapping is drawn as two edges through the
	 * association-class box, and either half alone names the BOX as one of its
	 * endpoints — `Monitors: Building → Monitors` reading off the in-half. So
	 * the label crosses the box: the in-half's source and the out-half's target
	 * are the mapping's real endpoints, and the two halves are the same id with
	 * the prefix swapped.
	 */
	it('names both outer endpoints of a boxed relationship from either half', () => {
		expect(hoverLabel({ kind: 'edge', id: 'assoc-in:Monitors:0', relName: 'Monitors' }, adj)).toBe(
			'Monitors: Building → Zone'
		);
		expect(hoverLabel({ kind: 'edge', id: 'assoc-out:Monitors:0', relName: 'Monitors' }, adj)).toBe(
			'Monitors: Building → Zone'
		);
	});

	it('falls back to the bare rel name when the other tether half is missing', () => {
		// `buildDiagram` emits a half only when BOTH its ends exist, so a mapping
		// onto a type the draft does not declare yields one half and no partner —
		// there is no second endpoint to name, and inventing one would be worse
		// than saying less.
		const halfOnly = buildAdjacency([
			{
				id: 'assoc-in:Monitors:0',
				source: 'el:Building',
				target: 'rel:Monitors',
				type: 'association',
				data: { relName: 'Monitors' }
			}
		]);
		expect(
			hoverLabel({ kind: 'edge', id: 'assoc-in:Monitors:0', relName: 'Monitors' }, halfOnly)
		).toBe('Monitors');
	});

	it('returns null for an unindexed generalization edge', () => {
		const hover: DiagramHover = { kind: 'edge', id: 'gen:el:Gone', relName: null };
		expect(hoverLabel(hover, adj)).toBeNull();
	});

	it('returns null, not the bare rel name, for a relName edge the index never saw', () => {
		const hover: DiagramHover = { kind: 'edge', id: 'assoc:Ghost:0', relName: 'Ghost' };
		expect(hoverLabel(hover, adj)).toBeNull();
	});

	it('returns null, not the bare rel name, for a relName edge whose endpoint ids do not resolve to a selection', () => {
		const hover: DiagramHover = { kind: 'edge', id: 'assoc:Weird:0', relName: 'Weird' };
		expect(hoverLabel(hover, adj)).toBeNull();
	});
});

describe('visualState', () => {
	const hl = { nodes: new Set(['el:A']), edges: new Set(['e1']) };

	it('is normal with no highlight active', () => {
		expect(visualState('el:A', 'node', false, null)).toBe('normal');
	});
	it('is hot inside the set, dim outside it', () => {
		expect(visualState('el:A', 'node', false, hl)).toBe('hot');
		expect(visualState('el:B', 'node', false, hl)).toBe('dim');
		expect(visualState('e1', 'edge', false, hl)).toBe('hot');
		expect(visualState('e2', 'edge', false, hl)).toBe('dim');
	});
	it('a selected element outside the set stays normal, never dim (spec §5)', () => {
		expect(visualState('el:B', 'node', true, hl)).toBe('normal');
	});
});
