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
});
