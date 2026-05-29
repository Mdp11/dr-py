import { describe, expect, it } from 'vitest';
import type { Metamodel } from '$lib/api/types';
import { compatibleOps, resolvePropertyKind } from '../property-ops';

const mm: Metamodel = {
	enums: { Status: ['open', 'closed'] },
	elements: [
		{ name: 'Requirement', abstract: false, extends: null, properties: [], key: null },
		{ name: 'Block', abstract: false, extends: null, properties: [], key: null }
	],
	relationships: []
};

describe('resolvePropertyKind', () => {
	it('maps built-in scalar datatypes', () => {
		expect(resolvePropertyKind('string', mm)).toBe('string');
		expect(resolvePropertyKind('date', mm)).toBe('string'); // dates handled as ISO strings
		expect(resolvePropertyKind('integer', mm)).toBe('numeric');
		expect(resolvePropertyKind('float', mm)).toBe('numeric');
		expect(resolvePropertyKind('boolean', mm)).toBe('boolean');
	});
	it('maps enum and element datatypes via the metamodel', () => {
		expect(resolvePropertyKind('Status', mm)).toBe('enum');
		expect(resolvePropertyKind('Requirement', mm)).toBe('element');
	});
	it('falls back to unknown for null or unrecognised datatypes', () => {
		expect(resolvePropertyKind(null, mm)).toBe('unknown');
		expect(resolvePropertyKind('Mystery', mm)).toBe('unknown');
		expect(resolvePropertyKind('string', null)).toBe('string');
		expect(resolvePropertyKind('Status', null)).toBe('unknown');
	});
});

describe('compatibleOps', () => {
	it('excludes numeric comparisons for strings', () => {
		const ops = compatibleOps('string');
		expect(ops).toContain('contains');
		expect(ops).toContain('matches');
		expect(ops).not.toContain('gt');
		expect(ops).not.toContain('lte');
	});
	it('excludes contains/matches for numerics', () => {
		const ops = compatibleOps('numeric');
		expect(ops).toContain('gt');
		expect(ops).toContain('lte');
		expect(ops).not.toContain('contains');
		expect(ops).not.toContain('matches');
	});
	it('restricts boolean/enum/element to equality and presence', () => {
		expect(compatibleOps('boolean')).toEqual(['equals', 'not_equals', 'exists', 'is_empty']);
		expect(compatibleOps('enum')).toEqual(['equals', 'not_equals', 'exists', 'is_empty']);
		expect(compatibleOps('element')).toEqual(['equals', 'not_equals', 'exists', 'is_empty']);
	});
	it('offers all operators for unknown datatypes', () => {
		expect(compatibleOps('unknown')).toHaveLength(10);
	});
	it('always includes equals (safe default across every kind)', () => {
		for (const kind of ['string', 'numeric', 'boolean', 'enum', 'element', 'unknown'] as const) {
			expect(compatibleOps(kind)).toContain('equals');
		}
	});
});
