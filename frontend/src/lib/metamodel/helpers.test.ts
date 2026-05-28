import { describe, expect, it } from 'vitest';

import type { Metamodel } from '$lib/api/types';
import {
	containmentRelTypes,
	effectiveProperties,
	elementAncestors,
	elementType,
	isSubtype,
	parseMultiplicity,
	relationshipAncestors
} from './helpers';

const mm: Metamodel = {
	enums: { Status: ['Draft', 'Reviewed', 'Approved'] },
	elements: [
		{
			name: 'NamedElement',
			abstract: true,
			extends: null,
			properties: [
				{
					name: 'name',
					datatype: 'string',
					multiplicity: '1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: ['name']
		},
		{
			name: 'Requirement',
			abstract: false,
			extends: 'NamedElement',
			properties: [
				{
					name: 'status',
					datatype: 'Status',
					multiplicity: '1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: null
		},
		{
			name: 'Block',
			abstract: false,
			extends: 'NamedElement',
			properties: [
				{
					name: 'mass',
					datatype: 'float',
					multiplicity: '0..1',
					min: 0,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: null
		},
		{
			name: 'SpecialBlock',
			abstract: false,
			extends: 'Block',
			properties: [
				{
					name: 'mass',
					datatype: 'float',
					multiplicity: '1',
					min: 0,
					max: 1000,
					pattern: null,
					max_length: null
				}
			],
			key: null
		}
	],
	relationships: [
		{
			name: 'Contains',
			abstract: true,
			extends: null,
			containment: true,
			source: 'NamedElement',
			target: 'NamedElement',
			source_multiplicity: '0..*',
			target_multiplicity: '0..*',
			properties: []
		},
		{
			name: 'BlockHasPart',
			abstract: false,
			extends: null,
			containment: true,
			source: 'Block',
			target: 'Block',
			source_multiplicity: '0..*',
			target_multiplicity: '0..*',
			properties: []
		},
		{
			name: 'RoomHasFurniture',
			abstract: false,
			extends: 'Contains',
			containment: false,
			source: 'Block',
			target: 'Block',
			source_multiplicity: '0..*',
			target_multiplicity: '0..*',
			properties: []
		},
		{
			name: 'Satisfies',
			abstract: false,
			extends: null,
			containment: false,
			source: 'Block',
			target: 'Requirement',
			source_multiplicity: '0..*',
			target_multiplicity: '0..*',
			properties: []
		}
	]
};

describe('elementType', () => {
	it('returns the named type', () => {
		expect(elementType(mm, 'Block')?.name).toBe('Block');
	});
	it('returns undefined for unknown names', () => {
		expect(elementType(mm, 'Ghost')).toBeUndefined();
	});
});

describe('elementAncestors', () => {
	it('returns the chain leaf -> root including self', () => {
		const names = elementAncestors(mm, 'SpecialBlock').map((e) => e.name);
		expect(names).toEqual(['SpecialBlock', 'Block', 'NamedElement']);
	});
	it('stops at unknown ancestors', () => {
		expect(elementAncestors(mm, 'Ghost')).toEqual([]);
	});
	it('returns just self for types without `extends`', () => {
		const names = elementAncestors(mm, 'NamedElement').map((e) => e.name);
		expect(names).toEqual(['NamedElement']);
	});
});

describe('effectiveProperties', () => {
	it('combines own + inherited properties (ancestor order)', () => {
		const ps = effectiveProperties(mm, 'Block').map((p) => p.name);
		expect(ps).toEqual(['name', 'mass']);
	});
	it('lets the child override parent property by name', () => {
		const ps = effectiveProperties(mm, 'SpecialBlock');
		const massProp = ps.find((p) => p.name === 'mass')!;
		expect(massProp.multiplicity).toBe('1');
		expect(massProp.max).toBe(1000);
	});
	it('returns [] for unknown types', () => {
		expect(effectiveProperties(mm, 'Ghost')).toEqual([]);
	});
});

describe('isSubtype', () => {
	it('treats a type as its own subtype', () => {
		expect(isSubtype(mm, 'Block', 'Block')).toBe(true);
	});
	it('detects transitive ancestry', () => {
		expect(isSubtype(mm, 'SpecialBlock', 'NamedElement')).toBe(true);
	});
	it('returns false for unrelated types', () => {
		expect(isSubtype(mm, 'Block', 'Requirement')).toBe(false);
	});
});

describe('relationshipAncestors', () => {
	it('walks the chain including self', () => {
		const names = relationshipAncestors(mm, 'RoomHasFurniture').map((r) => r.name);
		expect(names).toEqual(['RoomHasFurniture', 'Contains']);
	});
});

describe('containmentRelTypes', () => {
	it('includes types marked containment directly', () => {
		const names = containmentRelTypes(mm).map((r) => r.name);
		expect(names).toContain('BlockHasPart');
		expect(names).toContain('Contains');
	});
	it('includes types that inherit containment from an ancestor', () => {
		const names = containmentRelTypes(mm).map((r) => r.name);
		expect(names).toContain('RoomHasFurniture');
	});
	it('excludes non-containment types', () => {
		const names = containmentRelTypes(mm).map((r) => r.name);
		expect(names).not.toContain('Satisfies');
	});
});

describe('parseMultiplicity', () => {
	it('parses bare integers as fixed multiplicities', () => {
		expect(parseMultiplicity('1')).toEqual({ lower: 1, upper: 1 });
		expect(parseMultiplicity('0')).toEqual({ lower: 0, upper: 0 });
	});
	it('parses lower..upper ranges', () => {
		expect(parseMultiplicity('0..1')).toEqual({ lower: 0, upper: 1 });
		expect(parseMultiplicity('3..5')).toEqual({ lower: 3, upper: 5 });
	});
	it('treats * as unbounded upper', () => {
		expect(parseMultiplicity('0..*')).toEqual({ lower: 0, upper: null });
		expect(parseMultiplicity('1..*')).toEqual({ lower: 1, upper: null });
	});
	it('returns 0..* fallback for malformed input', () => {
		expect(parseMultiplicity('')).toEqual({ lower: 0, upper: null });
		expect(parseMultiplicity('garbage')).toEqual({ lower: 0, upper: null });
		expect(parseMultiplicity('5..2')).toEqual({ lower: 0, upper: null });
		expect(parseMultiplicity('-1')).toEqual({ lower: 0, upper: null });
	});
});
