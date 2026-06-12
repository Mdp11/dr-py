import { describe, expect, it } from 'vitest';
import type { Element, Metamodel, Relationship, RelationshipType } from '$lib/api/types';
import type { Snapshot } from '$lib/state/ops';
import { buildGraph } from './graph-data';

function el(id: string, properties: Record<string, unknown> = {}, type_name = 'Thing'): Element {
	return { id, type_name, properties, rev: 1 };
}

function rel(
	id: string,
	source_id: string,
	target_id: string,
	type_name = 'Link',
	properties: Record<string, unknown> = {}
): Relationship {
	return { id, type_name, source_id, target_id, properties, rev: 1 };
}

function snap(elements: Element[], relationships: Relationship[] = []): Snapshot {
	return { elements, relationships };
}

function rt(
	name: string,
	containment = false,
	extendsName: string | null = null
): RelationshipType {
	return {
		name,
		abstract: false,
		extends: extendsName,
		containment,
		source: 'Thing',
		target: 'Thing',
		mappings: [],
		source_multiplicity: '0..*',
		target_multiplicity: '0..*',
		properties: []
	};
}

function mm(rels: RelationshipType[] = []): Metamodel {
	return { enums: {}, elements: [], relationships: rels };
}

describe('buildGraph', () => {
	it('returns empty result when center is not in the working set', () => {
		const out = buildGraph({
			metamodel: mm(),
			working: snap([], []),
			centerId: 'nope'
		});
		expect(out.nodes).toEqual([]);
		expect(out.edges).toEqual([]);
		expect(out.truncated).toBe(false);
	});

	it('returns one node and no edges for an isolated center', () => {
		const out = buildGraph({
			metamodel: mm(),
			working: snap([el('a', { name: 'Alpha' })]),
			centerId: 'a'
		});
		expect(out.nodes).toEqual([{ id: 'a', type_name: 'Thing', label: 'Alpha', hops: 0 }]);
		expect(out.edges).toEqual([]);
		expect(out.truncated).toBe(false);
	});

	it('walks one hop and labels via name property, marks containment', () => {
		const metamodel = mm([rt('Owns', true)]);
		const out = buildGraph({
			metamodel,
			working: snap(
				[el('a', { name: 'Alpha' }), el('b', { name: 'Beta' })],
				[rel('r1', 'a', 'b', 'Owns')]
			),
			centerId: 'a'
		});
		expect(out.nodes).toHaveLength(2);
		expect(out.nodes.find((n) => n.id === 'a')?.hops).toBe(0);
		expect(out.nodes.find((n) => n.id === 'b')?.hops).toBe(1);
		expect(out.nodes.find((n) => n.id === 'b')?.label).toBe('Beta');
		expect(out.edges).toHaveLength(1);
		expect(out.edges[0]).toMatchObject({
			id: 'r1',
			source: 'a',
			target: 'b',
			type_name: 'Owns',
			containment: true
		});
	});

	it('honours maxHops on a chain: maxHops=2 yields hops 0..2 only', () => {
		// Chain: a -> b -> c -> d -> e
		const elements = ['a', 'b', 'c', 'd', 'e'].map((id) => el(id));
		const rels = [
			rel('r1', 'a', 'b'),
			rel('r2', 'b', 'c'),
			rel('r3', 'c', 'd'),
			rel('r4', 'd', 'e')
		];
		const out = buildGraph({
			metamodel: mm(),
			working: snap(elements, rels),
			centerId: 'a',
			maxHops: 2
		});
		const ids = out.nodes.map((n) => n.id).sort();
		expect(ids).toEqual(['a', 'b', 'c']);
		// Edges only among included nodes — r1 (a-b) and r2 (b-c), not r3/r4.
		const edgeIds = out.edges.map((e) => e.id).sort();
		expect(edgeIds).toEqual(['r1', 'r2']);
		expect(out.truncated).toBe(false);
	});

	it('marks truncated and respects nodeCap', () => {
		// Star: center a connected to b..f (6 neighbors).
		const elements = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => el(id));
		const rels = ['b', 'c', 'd', 'e', 'f'].map((t, i) => rel(`r${i}`, 'a', t));
		const out = buildGraph({
			metamodel: mm(),
			working: snap(elements, rels),
			centerId: 'a',
			nodeCap: 3
		});
		expect(out.nodes).toHaveLength(3);
		expect(out.truncated).toBe(true);
		// Every emitted edge must connect two included nodes.
		const ids = new Set(out.nodes.map((n) => n.id));
		for (const e of out.edges) {
			expect(ids.has(e.source)).toBe(true);
			expect(ids.has(e.target)).toBe(true);
		}
	});

	it('classifies containment vs non-containment per relationship type', () => {
		const metamodel = mm([rt('Owns', true), rt('Refs', false)]);
		const out = buildGraph({
			metamodel,
			working: snap(
				[el('a'), el('b'), el('c')],
				[rel('r1', 'a', 'b', 'Owns'), rel('r2', 'a', 'c', 'Refs')]
			),
			centerId: 'a'
		});
		const byId = new Map(out.edges.map((e) => [e.id, e] as const));
		expect(byId.get('r1')?.containment).toBe(true);
		expect(byId.get('r2')?.containment).toBe(false);
	});

	it('falls back to a truncated id label when name is missing', () => {
		const out = buildGraph({
			metamodel: mm(),
			working: snap([el('0123456789abcdef')]),
			centerId: '0123456789abcdef'
		});
		expect(out.nodes[0].label).toBe('01234567…');
	});
});
