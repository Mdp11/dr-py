import { describe, expect, it } from 'vitest';
import { cmpCodePoint, Metamodel, Multiplicity, type MetamodelDoc } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { thrown } from '../golden/thrown.ts';

type PropRow = [name: string, datatype: string, multiplicity: string];

type ElementCase = {
	name: string;
	is_element_type: boolean;
	own_properties: PropRow[] | null;
	ancestors: string[];
	properties: PropRow[];
	property_names: string[];
	key: string[] | null;
	key_spec: { properties: string[]; relationships: [string, 'out' | 'in'][] } | null;
	end_constraints: [string, 'source' | 'target', number, number | null][];
	descendants: string[];
	from: string[];
	to: string[];
	supertypes: string[];
};

type RelationshipCase = {
	name: string;
	own_mappings: [string, string][] | null;
	ancestors: string[];
	properties: PropRow[];
	property_names: string[];
	containment: boolean;
	descendants: string[];
	supertypes: string[];
};

type MultiplicityCase =
	| { spec: string; error: string }
	| {
			spec: string;
			lower: number;
			upper: number | null;
			is_single: boolean;
			required: boolean;
			count_ok: boolean[];
	  };

type Fixture = {
	metamodel: MetamodelDoc;
	elements: ElementCase[];
	relationships: RelationshipCase[];
	multiplicities: MultiplicityCase[];
};

const fixture = loadFixture<Fixture>('metamodel_caches');
const mm = Metamodel.fromJSON(fixture.metamodel);
const elementNames = fixture.elements.map((c) => c.name);
const relationshipNames = fixture.relationships.map((c) => c.name);

const rows = (props: readonly { name: string; datatype: string; multiplicity: string }[]) =>
	props.map((p) => [p.name, p.datatype, p.multiplicity]);
const sorted = (names: ReadonlySet<string>) => [...names].sort(cmpCodePoint);

describe('Metamodel lookups match the oracle', () => {
	it.each(fixture.elements)('element type $name', (c) => {
		const found = mm.elementType(c.name);
		expect(mm.isElementType(c.name)).toBe(c.is_element_type);
		expect(found === undefined ? null : rows(found.properties)).toEqual(c.own_properties);
		expect(mm.elementAncestors(c.name)).toEqual(c.ancestors);
		expect(rows(mm.effectiveElementProperties(c.name))).toEqual(c.properties);
		expect(sorted(mm.effectiveElementPropertyNames(c.name))).toEqual(c.property_names);
		expect(mm.effectiveElementKey(c.name)).toEqual(c.key);
		const spec = mm.effectiveElementKeySpec(c.name);
		expect(
			spec === null
				? null
				: {
						properties: spec.properties,
						relationships: spec.relationships.map((r) => [r.relType, r.direction])
					}
		).toEqual(c.key_spec);
		expect(
			mm
				.endConstraints(c.name)
				.map((e) => [e.relTypeName, e.end, e.multiplicity.lower, e.multiplicity.upper])
		).toEqual(c.end_constraints);
		expect(sorted(mm.elementDescendants(c.name))).toEqual(c.descendants);
		expect(mm.relationshipTypesFrom(c.name)).toEqual(c.from);
		expect(mm.relationshipTypesTo(c.name)).toEqual(c.to);
		expect(elementNames.filter((s) => mm.isElementSubtype(c.name, s))).toEqual(c.supertypes);
	});

	it.each(fixture.relationships)('relationship type $name', (c) => {
		const found = mm.relationshipType(c.name);
		expect(found === undefined ? null : found.mappings.map((m) => [m.source, m.target])).toEqual(
			c.own_mappings
		);
		expect(mm.relationshipAncestors(c.name)).toEqual(c.ancestors);
		expect(rows(mm.effectiveRelationshipProperties(c.name))).toEqual(c.properties);
		expect(sorted(mm.effectiveRelationshipPropertyNames(c.name))).toEqual(c.property_names);
		expect(mm.isContainment(c.name)).toBe(c.containment);
		expect(sorted(mm.relationshipDescendants(c.name))).toEqual(c.descendants);
		expect(relationshipNames.filter((s) => mm.isRelationshipSubtype(c.name, s))).toEqual(
			c.supertypes
		);
	});
});

describe('Multiplicity.parse matches the oracle', () => {
	it.each(fixture.multiplicities)('spec "$spec"', (c) => {
		if ('error' in c) {
			const error = thrown(() => Multiplicity.parse(c.spec));
			expect(error).toBeInstanceOf(RangeError);
			expect((error as Error).message).toBe(c.error);
			return;
		}
		const parsed = Multiplicity.parse(c.spec);
		expect([parsed.lower, parsed.upper]).toEqual([c.lower, c.upper]);
		expect(parsed.isSingle).toBe(c.is_single);
		expect(parsed.required).toBe(c.required);
		expect([0, 1, 2, 3].map((n) => parsed.countOk(n))).toEqual(c.count_ok);
		expect(Multiplicity.parse(c.spec)).toBe(parsed);
	});
});
