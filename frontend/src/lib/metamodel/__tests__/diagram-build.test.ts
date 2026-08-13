import { describe, expect, it } from 'vitest';
import { buildDiagram, needsAssocBox, nodeIdFor } from '../diagram-build';
import { parseDraft } from '../yaml-edit';
import { FIXTURE } from './fixtures';

const mm = () => parseDraft(FIXTURE).mm!;

describe('buildDiagram', () => {
	it('emits an element node per type and an enum node per enum', () => {
		const { nodes } = buildDiagram(mm());
		expect(nodes.filter((n) => n.type === 'elementType').map((n) => n.id)).toEqual([
			'el:NamedElement',
			'el:Zone',
			'el:Building'
		]);
		expect(nodes.some((n) => n.id === 'enum:Status' && n.type === 'enumType')).toBe(true);
	});

	it('marks key properties on the node data', () => {
		const { nodes } = buildDiagram(mm());
		const root = nodes.find((n) => n.id === 'el:NamedElement')!;
		expect(root.data.keyProps).toEqual(['name']);
	});

	it('emits generalization edges for element extends', () => {
		const { edges } = buildDiagram(mm());
		expect(edges).toContainEqual(
			expect.objectContaining({ id: 'gen:el:Zone', source: 'el:Zone', target: 'el:NamedElement', type: 'generalization' })
		);
	});

	it('a plain relationship renders as one association edge per mapping', () => {
		const { edges, nodes } = buildDiagram(mm());
		const contains = edges.find((e) => e.data.relName === 'Contains')!;
		expect(contains).toMatchObject({ source: 'el:Zone', target: 'el:Building', type: 'association' });
		expect(contains.data.containment).toBe(true);
		expect(contains.data.sourceMult).toBe('1');
		expect(nodes.some((n) => n.id === 'rel:Contains')).toBe(false);
	});

	it('a relationship with properties or hierarchy gets an assoc box and two-half edges', () => {
		expect(needsAssocBox(mm().relationships.find((r) => r.name === 'Monitors')!, mm())).toBe(true);
		const { nodes, edges } = buildDiagram(mm());
		expect(nodes.some((n) => n.id === 'rel:Monitors' && n.type === 'assocClass')).toBe(true);
		const inHalf = edges.find((e) => e.id === 'assoc-in:Monitors:0')!;
		const outHalf = edges.find((e) => e.id === 'assoc-out:Monitors:0')!;
		expect(inHalf).toMatchObject({ source: 'el:Building', target: 'rel:Monitors' });
		expect(outHalf).toMatchObject({ source: 'rel:Monitors', target: 'el:Zone' });
		expect(outHalf.data.arrow).toBe(true);
	});

	it('an abstract mapless relationship renders as a floating box + rel generalization edge', () => {
		const { nodes, edges } = buildDiagram(mm());
		expect(nodes.some((n) => n.id === 'rel:Observes')).toBe(true);
		expect(edges).toContainEqual(
			expect.objectContaining({ id: 'gen:rel:Monitors', source: 'rel:Monitors', target: 'rel:Observes' })
		);
	});

	it('skips edges whose endpoint types do not exist (mid-edit dangling refs)', () => {
		const broken = { ...mm(), relationships: mm().relationships.map((r) =>
			r.name === 'Contains' ? { ...r, mappings: [{ source: 'Zone', target: 'Ghost' }] } : r
		)};
		const { edges } = buildDiagram(broken);
		expect(edges.some((e) => e.data.relName === 'Contains')).toBe(false);
	});
});

describe('nodeIdFor', () => {
	it('prefixes by kind', () => {
		expect(nodeIdFor({ kind: 'element', name: 'Zone' })).toBe('el:Zone');
		expect(nodeIdFor({ kind: 'relationship', name: 'M' })).toBe('rel:M');
		expect(nodeIdFor({ kind: 'enum', name: 'S' })).toBe('enum:S');
	});
});
