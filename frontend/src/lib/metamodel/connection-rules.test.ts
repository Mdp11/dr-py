import { describe, expect, it } from 'vitest';

import type { Metamodel, Relationship, RelationshipType } from '$lib/api/types';
import {
	allowedTargetTypes,
	buildPickerTypeOptions,
	outCountsByType,
	relationshipTypesFromScope,
	relationshipTypesFromSource,
	scopeAllowedTargetTypes,
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
		rel({
			name: 'Abstract',
			abstract: true,
			mappings: [{ source: 'Component', target: 'Database' }]
		}),
		// bounded out-degree
		rel({
			name: 'OwnsOne',
			source: 'Component',
			target: 'Database',
			mappings: [{ source: 'Component', target: 'Database' }],
			target_multiplicity: '0..1'
		}),
		// sourced ONLY from a strict descendant of Component — mirrors
		// smart-city's UsesDatabase, whose sole mapping is Microservice-sourced.
		// Under creation semantics its NAME is invisible from Component; under
		// scope semantics it must appear (the reported symptom was whole names
		// vanishing from the hop picker).
		rel({
			name: 'UsesDb',
			mappings: [{ source: 'Microservice', target: 'Database' }]
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

describe('scopeAllowedTargetTypes', () => {
	it('matches mappings whose source is an ancestor OR a descendant of the scope type', () => {
		const multi = mm.relationships.find((r) => r.name === 'Multi')!;
		// Component is an ancestor of Microservice's mapping source (Component->Requirement
		// matches directly) AND an ancestor of Microservice itself, so the descendant
		// mapping (Microservice->Database) also matches under scope semantics.
		expect(scopeAllowedTargetTypes(mm, 'Component', multi).sort()).toEqual(
			['Database', 'Requirement'].sort()
		);
		// Requirement is on an unrelated inheritance line from both mapping sources.
		expect(scopeAllowedTargetTypes(mm, 'Requirement', multi)).toEqual([]);
	});

	it('falls back to source/target shorthand when mappings is empty', () => {
		const sh = mm.relationships.find((r) => r.name === 'Shorthand')!;
		expect(scopeAllowedTargetTypes(mm, 'Requirement', sh)).toEqual(['Requirement']);
	});
});

describe('relationshipTypesFromScope', () => {
	it('includes Multi for scope Component via the descendant-sourced mapping', () => {
		// This is the reported bug: the backend evaluator matches a scope type
		// against instances of the scope type AND ALL ITS DESCENDANTS (see
		// evaluate.py's element_descendants usage), so a mapping sourced from a
		// descendant of the scope type (Microservice->Database) is a valid hop
		// from scope Component even though no plain Component instance could
		// have created that edge under CREATION semantics.
		const fromComponent = relationshipTypesFromScope(mm, 'Component');
		expect(fromComponent.map((e) => e.rt.name)).toEqual(['Multi', 'OwnsOne', 'UsesDb']);

		// Pin that the creation-semantics helper deliberately still excludes it:
		// relationshipTypesFromSource only walks ancestors of the concrete type,
		// so it never sees the Microservice->Database mapping from Component.
		const creationFromComponent = relationshipTypesFromSource(mm, 'Component');
		expect(creationFromComponent.map((e) => e.rt.name)).toEqual(['Multi', 'OwnsOne']);
		const multiEntry = creationFromComponent.find((e) => e.rt.name === 'Multi')!;
		expect(multiEntry.targetTypes).toEqual(['Requirement']);
		expect(multiEntry.targetTypes).not.toContain('Database');
	});

	it('restores a whole NAME sourced only from a strict descendant (the reported symptom)', () => {
		// UsesDb's only mapping is Microservice->Database. Under creation
		// semantics its name never appears from Component (targetTypes is empty,
		// so the entry.targetTypes.length > 0 filter drops it) — exactly how
		// smart-city's UsesDatabase vanished from the hop picker for scope
		// Component. Scope semantics must surface the name.
		const creationNames = relationshipTypesFromSource(mm, 'Component').map((e) => e.rt.name);
		expect(creationNames).not.toContain('UsesDb');

		const scopeEntries = relationshipTypesFromScope(mm, 'Component');
		const scopeNames = scopeEntries.map((e) => e.rt.name);
		expect(scopeNames).toContain('UsesDb');
		expect(scopeEntries.find((e) => e.rt.name === 'UsesDb')!.targetTypes).toEqual(['Database']);
	});

	it('shorthand fallback still works from scope Requirement', () => {
		const fromRequirement = relationshipTypesFromScope(mm, 'Requirement');
		expect(fromRequirement.map((e) => e.rt.name)).toEqual(['Shorthand']);
	});

	it('excludes abstract relationship types', () => {
		const fromComponent = relationshipTypesFromScope(mm, 'Component');
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

function relInstance(p: Partial<Relationship> & { id: string; type_name: string }): Relationship {
	return {
		id: p.id,
		type_name: p.type_name,
		source_id: p.source_id ?? '',
		target_id: p.target_id ?? '',
		properties: p.properties ?? {},
		rev: p.rev ?? 0
	};
}

describe('outCountsByType', () => {
	it('counts only outgoing edges of the given source, grouped by type', () => {
		const rels = [
			relInstance({ id: 'r1', type_name: 'OwnsOne', source_id: 'a', target_id: 'd1' }),
			relInstance({ id: 'r2', type_name: 'Multi', source_id: 'a', target_id: 'q1' }),
			relInstance({ id: 'r3', type_name: 'Multi', source_id: 'a', target_id: 'q2' }),
			relInstance({ id: 'r4', type_name: 'Multi', source_id: 'OTHER', target_id: 'q3' })
		];
		const counts = outCountsByType(rels, 'a');
		expect(counts.get('OwnsOne')).toBe(1);
		expect(counts.get('Multi')).toBe(2);
		expect(counts.has('OTHER')).toBe(false);
	});
});

describe('buildPickerTypeOptions', () => {
	it('filtered mode: only allowed types; disables a maxed type', () => {
		const counts = new Map([['OwnsOne', 1]]);
		const opts = buildPickerTypeOptions(mm, 'Component', counts, false);
		expect(opts.map((o) => o.rt.name)).toEqual(['Multi', 'OwnsOne']);
		const ownsOne = opts.find((o) => o.rt.name === 'OwnsOne')!;
		expect(ownsOne.allowed).toBe(true);
		expect(ownsOne.atMax).toBe(true);
		expect(ownsOne.disabled).toBe(true);
		expect(ownsOne.outCount).toBe(1);
		expect(ownsOne.max).toBe(1);
		const multi = opts.find((o) => o.rt.name === 'Multi')!;
		expect(multi.atMax).toBe(false);
		expect(multi.disabled).toBe(false);
	});

	it('show-all mode: includes disallowed types and downgrades the maxed disable', () => {
		const counts = new Map([['OwnsOne', 1]]);
		const opts = buildPickerTypeOptions(mm, 'Component', counts, true);
		// Shorthand (Requirement->Requirement) is NOT allowed from Component but shows in show-all.
		const shorthand = opts.find((o) => o.rt.name === 'Shorthand')!;
		expect(shorthand.allowed).toBe(false);
		expect(shorthand.targetTypes).toEqual(['Requirement']);
		// Abstract types are excluded even in show-all.
		expect(opts.find((o) => o.rt.name === 'Abstract')).toBeUndefined();
		// Maxed type still flagged atMax but NOT disabled (escape hatch overrides).
		const ownsOne = opts.find((o) => o.rt.name === 'OwnsOne')!;
		expect(ownsOne.atMax).toBe(true);
		expect(ownsOne.disabled).toBe(false);
	});
});
