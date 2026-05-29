import { describe, expect, it } from 'vitest';
import { criteriaForKind, newCriterion, pruneCriteria, type Criterion } from '../types';

describe('criteriaForKind', () => {
	it('offers element-only criteria for elements', () => {
		expect(criteriaForKind('element')).toContain('relation_count');
		expect(criteriaForKind('element')).not.toContain('endpoint_type');
	});
	it('offers relationship-only criteria for relationships', () => {
		expect(criteriaForKind('relationship')).toContain('endpoint_type');
		expect(criteriaForKind('relationship')).not.toContain('relation_count');
	});
	it('returns the full ordered element criteria array', () => {
		expect(criteriaForKind('element')).toEqual([
			'entity_type',
			'property',
			'name_id',
			'relation_count',
			'orphan',
			'connected_to_type'
		]);
	});
	it('returns the full ordered relationship criteria array', () => {
		expect(criteriaForKind('relationship')).toEqual([
			'entity_type',
			'property',
			'name_id',
			'endpoint_type'
		]);
	});
});

describe('newCriterion', () => {
	it('builds a relation_count with defaults', () => {
		expect(newCriterion('relation_count')).toEqual({
			type: 'relation_count',
			op: 'at_least',
			count: 1,
			direction: 'either',
			relTypes: []
		});
	});
	it('builds a name_id with defaults', () => {
		expect(newCriterion('name_id')).toEqual({
			type: 'name_id',
			field: 'name',
			op: 'contains',
			value: ''
		});
	});
	it('builds an orphan criterion', () => {
		expect(newCriterion('orphan')).toEqual({ type: 'orphan' });
	});
});

describe('pruneCriteria', () => {
	it('removes criteria not valid for the new target', () => {
		const criteria: Criterion[] = [
			{ type: 'name_id', field: 'name', op: 'contains', value: 'x' },
			{ type: 'relation_count', op: 'at_least', count: 1, direction: 'either', relTypes: [] }
		];
		const pruned = pruneCriteria(criteria, 'relationship');
		expect(pruned.map((c) => c.type)).toEqual(['name_id']);
	});
	it('returns the input array unchanged when all criteria are valid for the target', () => {
		const criteria: Criterion[] = [
			{ type: 'name_id', field: 'name', op: 'contains', value: 'foo' },
			{ type: 'entity_type', names: ['Actor'] }
		];
		const pruned = pruneCriteria(criteria, 'element');
		expect(pruned).toEqual(criteria);
	});
});
