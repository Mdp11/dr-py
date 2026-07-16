import { describe, expect, it } from 'vitest';

import type { Metamodel, PathNavigation } from '$lib/api/types';
import {
	containmentRelTypes,
	effectiveProperties,
	effectivePropertiesForTypes,
	effectiveRelationshipProperties,
	elementAncestors,
	elementType,
	frontierTypesAt,
	isSubtype,
	parseMultiplicity,
	propertyStepTargetTypes,
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
		},
		{
			name: 'Component',
			abstract: true,
			extends: null,
			properties: [
				{
					name: 'cost',
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
			name: 'Service',
			abstract: false,
			extends: 'Component',
			properties: [
				{
					name: 'sla',
					datatype: 'string',
					multiplicity: '0..1',
					min: null,
					max: null,
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
			mappings: [],
			source_multiplicity: '0..*',
			target_multiplicity: '0..*',
			properties: [
				{
					name: 'note',
					datatype: 'string',
					multiplicity: '0..1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			]
		},
		{
			name: 'BlockHasPart',
			abstract: false,
			extends: null,
			containment: true,
			source: 'Block',
			target: 'Block',
			mappings: [],
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
			mappings: [],
			source_multiplicity: '0..*',
			target_multiplicity: '0..*',
			properties: [
				{
					name: 'weight',
					datatype: 'float',
					multiplicity: '0..1',
					min: 0,
					max: null,
					pattern: null,
					max_length: null
				}
			]
		},
		{
			name: 'Satisfies',
			abstract: false,
			extends: null,
			containment: false,
			source: 'Block',
			target: 'Requirement',
			mappings: [],
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

describe('effectiveRelationshipProperties', () => {
	it('combines own + inherited relationship properties (ancestor order)', () => {
		const ps = effectiveRelationshipProperties(mm, 'RoomHasFurniture').map((p) => p.name);
		expect(ps).toEqual(['note', 'weight']);
	});
	it('returns own properties when the type has no parent', () => {
		const ps = effectiveRelationshipProperties(mm, 'Contains').map((p) => p.name);
		expect(ps).toEqual(['note']);
	});
	it('returns [] for unknown relationship types', () => {
		expect(effectiveRelationshipProperties(mm, 'Ghost')).toEqual([]);
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

describe('effectivePropertiesForTypes', () => {
	it('effectivePropertiesForTypes unions props over subtypes; [] = all', () => {
		// mm: Component (abstract) with prop `cost`; Service extends Component adds `sla`.
		const named = effectivePropertiesForTypes(mm, ['Component']).map((p) => p.name);
		expect(named).toContain('cost'); // own
		expect(named).toContain('sla'); // subtype-only, unioned
		const all = effectivePropertiesForTypes(mm, []).map((p) => p.name);
		expect(all).toContain('cost');
	});
});

const smartCityMm: Metamodel = {
	enums: {},
	elements: [
		{
			name: 'Building',
			abstract: false,
			extends: null,
			properties: [],
			key: null
		},
		{
			name: 'Sensor',
			abstract: false,
			extends: null,
			properties: [
				{
					name: 'building',
					datatype: 'Building',
					multiplicity: '1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				},
				{
					name: 'tags',
					datatype: 'string',
					multiplicity: '0..*',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			],
			key: null
		},
		{
			name: 'SmartSensor',
			abstract: false,
			extends: 'Sensor',
			properties: [],
			key: null
		}
	],
	relationships: []
};

describe('propertyStepTargetTypes', () => {
	it('resolves element-typed datatypes across subtypes', () => {
		expect(propertyStepTargetTypes(smartCityMm, ['Sensor'], 'building')).toEqual(['Building']);
	});

	it('includes inherited properties from subtypes', () => {
		expect(propertyStepTargetTypes(smartCityMm, ['SmartSensor'], 'building')).toEqual(['Building']);
	});

	it('returns empty for non-element properties', () => {
		expect(propertyStepTargetTypes(smartCityMm, ['Sensor'], 'tags')).toEqual([]);
	});

	it('returns empty for undeclared properties', () => {
		expect(propertyStepTargetTypes(smartCityMm, ['Sensor'], 'nope')).toEqual([]);
	});

	it('returns all element types when typeNames is empty (any type)', () => {
		expect(propertyStepTargetTypes(smartCityMm, [], 'building')).toEqual(['Building']);
	});
});

describe('frontierTypesAt', () => {
	const node: PathNavigation = {
		kind: 'path',
		schema_version: 2,
		start: { kind: 'scope', types: ['Sensor'], criteria: [] },
		steps: [
			{ kind: 'property', property_name: 'building' },
			{ kind: 'filter', criteria: [] },
			{ kind: 'property', property_name: 'tags' }
		],
		exclude_visited: true
	};

	it('returns the starting types at index 0', () => {
		expect(frontierTypesAt(smartCityMm, node, 0)).toEqual(['Sensor']);
	});

	it('walks property steps forward to their target types', () => {
		expect(frontierTypesAt(smartCityMm, node, 1)).toEqual(['Building']);
	});

	it('filter steps do not change the frontier', () => {
		expect(frontierTypesAt(smartCityMm, node, 2)).toEqual(['Building']);
	});

	it('returns any type past a dead-end property step', () => {
		expect(frontierTypesAt(smartCityMm, node, 3)).toEqual([]);
	});

	it('clamps index to steps.length when index exceeds it', () => {
		expect(frontierTypesAt(smartCityMm, node, 5)).toEqual([]);
	});
});
