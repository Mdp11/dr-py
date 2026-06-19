import { describe, expect, it } from 'vitest';

import type { Metamodel, RelationshipType } from '$lib/api/types';
import {
	allowedTargetTypes,
	relationshipTypesFromSource,
	targetMultiplicityExceeded
} from './connection-rules';

// Minimal relationship-type factory (fills schema defaults).
function rel(p: Partial<RelationshipType> & { name: string }): RelationshipType {
	return {
		name: p.name,
		abstract: p.abstract ?? false,
		extends: p.extends ?? null,
		containment: p.containment ?? false,
		source: p.source ?? '',
		target: p.target ?? '',
		mappings: p.mappings ?? [],
		source_multiplicity: p.source_multiplicity ?? '0..*',
		target_multiplicity: p.target_multiplicity ?? '0..*',
		properties: p.properties ?? []
	};
}

const mm: Metamodel = {
	enums: {},
	elements: [
		{ name: 'Element', abstract: true, extends: null, properties: [], key: null },
		{ name: 'Component', abstract: false, extends: 'Element', properties: [], key: null },
		{ name: 'Microservice', abstract: false, extends: 'Component', properties: [], key: null },
		{ name: 'Requirement', abstract: false, extends: 'Element', properties: [], key: null },
		{ name: 'Database', abstract: false, extends: 'Element', properties: [], key: null }
	],
	relationships: [
		// multi-mapping: from Component->Requirement OR Microservice->Database
		rel({
			name: 'Multi',
			mappings: [
				{ source: 'Component', target: 'Requirement' },
				{ source: 'Microservice', target: 'Database' }
			]
		}),
		// single-pair via shorthand only (mappings empty -> fall back)
		rel({ name: 'Shorthand', source: 'Requirement', target: 'Requirement' }),
		rel({ name: 'Abstract', abstract: true, mappings: [{ source: 'Component', target: 'Database' }] }),
		// bounded out-degree
		rel({
			name: 'OwnsOne',
			source: 'Component',
			target: 'Database',
			mappings: [{ source: 'Component', target: 'Database' }],
			target_multiplicity: '0..1'
		})
	]
};

describe('allowedTargetTypes', () => {
	it('selects targets whose mapping source matches via inheritance', () => {
		const multi = mm.relationships.find((r) => r.name === 'Multi')!;
		// Microservice is a Component AND a Microservice -> both mappings match.
		expect(allowedTargetTypes(mm, 'Microservice', multi).sort()).toEqual(
			['Database', 'Requirement'].sort()
		);
		// A plain Component matches only the Component->Requirement mapping.
		expect(allowedTargetTypes(mm, 'Component', multi)).toEqual(['Requirement']);
		// Requirement matches neither mapping source.
		expect(allowedTargetTypes(mm, 'Requirement', multi)).toEqual([]);
	});

	it('falls back to source/target shorthand when mappings is empty', () => {
		const sh = mm.relationships.find((r) => r.name === 'Shorthand')!;
		expect(allowedTargetTypes(mm, 'Requirement', sh)).toEqual(['Requirement']);
		expect(allowedTargetTypes(mm, 'Component', sh)).toEqual([]);
	});
});

describe('relationshipTypesFromSource', () => {
	it('returns non-abstract types with a non-empty target set, sorted by name', () => {
		const fromComponent = relationshipTypesFromSource(mm, 'Component');
		expect(fromComponent.map((e) => e.rt.name)).toEqual(['Multi', 'OwnsOne']);
		// Abstract excluded even though its mapping matches Component.
		expect(fromComponent.find((e) => e.rt.name === 'Abstract')).toBeUndefined();
	});
});

describe('targetMultiplicityExceeded', () => {
	const ownsOne = mm.relationships.find((r) => r.name === 'OwnsOne')!;
	const unbounded = mm.relationships.find((r) => r.name === 'Multi')!;

	it('is true once count reaches a finite upper bound', () => {
		expect(targetMultiplicityExceeded(ownsOne, 0)).toBe(false);
		expect(targetMultiplicityExceeded(ownsOne, 1)).toBe(true);
		expect(targetMultiplicityExceeded(ownsOne, 2)).toBe(true);
	});

	it('is never true for an unbounded (..*) upper', () => {
		expect(targetMultiplicityExceeded(unbounded, 9999)).toBe(false);
	});

	it('treats a malformed spec as unbounded (parseMultiplicity returns 0..*)', () => {
		expect(targetMultiplicityExceeded(rel({ name: 'X', target_multiplicity: 'garbage' }), 5)).toBe(
			false
		);
	});
});
