import { describe, expect, it } from 'vitest';
import type { Element, Relationship } from '$lib/api/types';
import type { AdvancedQuery, SearchModel } from '../types';
import { isValidRegex, runQuery } from '../evaluate';

function el(id: string, type_name = 'Thing', properties: Record<string, unknown> = {}): Element {
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
function model(elements: Element[] = [], relationships: Relationship[] = []): SearchModel {
	return { elements, relationships };
}
function ids(q: AdvancedQuery, m: SearchModel): string[] {
	return runQuery(q, m)
		.map((r) => r.id)
		.sort();
}

describe('runQuery — entity_type', () => {
	const m = model([el('e1', 'Block'), el('e2', 'Port'), el('e3', 'Block')]);
	it('matches elements whose type is in the set', () => {
		expect(
			ids({ target: 'element', criteria: [{ type: 'entity_type', names: ['Block'] }] }, m)
		).toEqual(['e1', 'e3']);
	});
	it('empty name set means no type constraint (all match)', () => {
		expect(ids({ target: 'element', criteria: [{ type: 'entity_type', names: [] }] }, m)).toEqual([
			'e1',
			'e2',
			'e3'
		]);
	});
});

describe('runQuery — property', () => {
	const m = model([
		el('e1', 'Block', { name: 'Alpha', size: 5 }),
		el('e2', 'Block', { name: 'Beta', size: 12 }),
		el('e3', 'Block', {})
	]);
	it('equals', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'equals', value: 'Alpha' }]
				},
				m
			)
		).toEqual(['e1']);
	});
	it('contains is case-insensitive', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'contains', value: 'a' }]
				},
				m
			)
		).toEqual(['e1', 'e2']);
	});
	it('gt coerces to number, non-numeric fails', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'size', op: 'gt', value: '10' }]
				},
				m
			)
		).toEqual(['e2']);
	});
	it('exists vs is_empty', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'exists', value: '' }]
				},
				m
			)
		).toEqual(['e1', 'e2']);
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'is_empty', value: '' }]
				},
				m
			)
		).toEqual(['e3']);
	});
	it('matches uses regex; invalid regex matches nothing', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'matches', value: '^A' }]
				},
				m
			)
		).toEqual(['e1']);
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'matches', value: '[' }]
				},
				m
			)
		).toEqual([]);
	});
});

describe('runQuery — name_id', () => {
	const m = model([
		el('block-1', 'Block', { name: 'Alpha' }),
		el('port-1', 'Port', { name: 'Beta' })
	]);
	it('matches on id contains', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'name_id', field: 'id', op: 'contains', value: 'block' }]
				},
				m
			)
		).toEqual(['block-1']);
	});
	it('matches on name regex', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'name_id', field: 'name', op: 'matches', value: '^Be' }]
				},
				m
			)
		).toEqual(['port-1']);
	});
});

describe('runQuery — relationships target & shared criteria', () => {
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port')],
		[rel('r1', 'e1', 'e2', 'Connects', { name: 'wire' })]
	);
	it('returns relationships filtered by type and property', () => {
		expect(
			runQuery(
				{
					target: 'relationship',
					criteria: [
						{ type: 'entity_type', names: ['Connects'] },
						{ type: 'property', name: 'name', op: 'equals', value: 'wire' }
					]
				},
				m
			)
		).toEqual([{ kind: 'relationship', id: 'r1' }]);
	});
});

describe('runQuery — empty criteria lists everything of the target kind', () => {
	const m = model([el('e1'), el('e2')], [rel('r1', 'e1', 'e2')]);
	it('elements', () => {
		expect(ids({ target: 'element', criteria: [] }, m)).toEqual(['e1', 'e2']);
	});
	it('relationships', () => {
		expect(ids({ target: 'relationship', criteria: [] }, m)).toEqual(['r1']);
	});
});

describe('isValidRegex', () => {
	it('true for valid, false for invalid', () => {
		expect(isValidRegex('^a.*')).toBe(true);
		expect(isValidRegex('[')).toBe(false);
	});
});

describe('runQuery — relation_count & orphan', () => {
	// e1 -> e2 (Connects), e1 -> e3 (Owns), e4 isolated
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port'), el('e3', 'Port'), el('e4', 'Block')],
		[
			rel('r1', 'e1', 'e2', 'Connects'),
			rel('r2', 'e1', 'e3', 'Owns'),
			rel('r3', 'e2', 'e1', 'Connects')
		]
	);
	it('counts outgoing relations', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{
							type: 'relation_count',
							op: 'at_least',
							count: 2,
							direction: 'outgoing',
							relTypes: []
						}
					]
				},
				m
			)
		).toEqual(['e1']);
	});
	it('counts incoming relations', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{ type: 'relation_count', op: 'exactly', count: 1, direction: 'incoming', relTypes: [] }
					]
				},
				m
			)
		).toEqual(['e1', 'e2', 'e3']);
	});
	it('filters relation_count by relationship type', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{
							type: 'relation_count',
							op: 'at_least',
							count: 1,
							direction: 'either',
							relTypes: ['Owns']
						}
					]
				},
				m
			)
		).toEqual(['e1', 'e3']);
	});
	it('orphan finds elements with no relations', () => {
		expect(ids({ target: 'element', criteria: [{ type: 'orphan' }] }, m)).toEqual(['e4']);
	});
});

describe('runQuery — connected_to_type', () => {
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port'), el('e3', 'Block')],
		[rel('r1', 'e1', 'e2', 'Connects'), rel('r2', 'e3', 'e1', 'Connects')]
	);
	it('matches elements connected (either direction) to a Port', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'connected_to_type', direction: 'either', names: ['Port'] }]
				},
				m
			)
		).toEqual(['e1']);
	});
});

describe('runQuery — endpoint_type', () => {
	const m = model(
		[el('e1', 'Block'), el('e2', 'Port')],
		[rel('r1', 'e1', 'e2', 'Connects'), rel('r2', 'e2', 'e1', 'Connects')]
	);
	it('matches relationships whose source element is a Block', () => {
		expect(
			runQuery(
				{
					target: 'relationship',
					criteria: [{ type: 'endpoint_type', endpoint: 'source', names: ['Block'] }]
				},
				m
			).map((r) => r.id)
		).toEqual(['r1']);
	});
	it('matches relationships whose target element is a Block', () => {
		expect(
			runQuery(
				{
					target: 'relationship',
					criteria: [{ type: 'endpoint_type', endpoint: 'target', names: ['Block'] }]
				},
				m
			).map((r) => r.id)
		).toEqual(['r2']);
	});
});

describe('runQuery — multi-criterion AND', () => {
	const m = model(
		[el('e1', 'Block', { name: 'Alpha' }), el('e2', 'Block', { name: 'Beta' })],
		[rel('r1', 'e1', 'e2', 'Connects')]
	);
	it('requires all criteria to pass', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [
						{ type: 'entity_type', names: ['Block'] },
						{
							type: 'relation_count',
							op: 'at_least',
							count: 1,
							direction: 'outgoing',
							relTypes: []
						}
					]
				},
				m
			)
		).toEqual(['e1']);
	});
});

describe('runQuery — remaining property ops', () => {
	const m = model([
		el('e1', 'Block', { name: 'Alpha', size: 5 }),
		el('e2', 'Block', { name: 'Beta', size: 10 }),
		el('e3', 'Block', { name: 'Beta', size: 15 })
	]);
	it('not_equals', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'not_equals', value: 'Alpha' }]
				},
				m
			)
		).toEqual(['e2', 'e3']);
	});
	it('lt', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'size', op: 'lt', value: '10' }]
				},
				m
			)
		).toEqual(['e1']);
	});
	it('gte', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'size', op: 'gte', value: '10' }]
				},
				m
			)
		).toEqual(['e2', 'e3']);
	});
	it('lte', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'property', name: 'size', op: 'lte', value: '10' }]
				},
				m
			)
		).toEqual(['e1', 'e2']);
	});
});

describe('runQuery — cross-kind criteria are no-ops', () => {
	const m = model([el('e1', 'Block'), el('e2', 'Port')], [rel('r1', 'e1', 'e2', 'Connects')]);
	it('endpoint_type on an element query matches all elements', () => {
		expect(
			ids(
				{
					target: 'element',
					criteria: [{ type: 'endpoint_type', endpoint: 'source', names: ['Nope'] }]
				},
				m
			)
		).toEqual(['e1', 'e2']);
	});
	it('relation_count on a relationship query matches all relationships', () => {
		expect(
			runQuery(
				{
					target: 'relationship',
					criteria: [
						{ type: 'relation_count', op: 'at_least', count: 99, direction: 'either', relTypes: [] }
					]
				},
				m
			).map((r) => r.id)
		).toEqual(['r1']);
	});
});
