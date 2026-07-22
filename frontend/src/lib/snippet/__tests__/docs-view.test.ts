import { describe, expect, it } from 'vitest';
import { MetamodelSchema, type FacadeDocEntry } from '$lib/api/types';
import {
	elementTypeRows,
	filterFacade,
	filterRelRows,
	filterTypeRows,
	formatBytes,
	formatSeconds,
	groupFacade,
	relationshipRows,
	type RelRow,
	type TypeRow
} from '../docs-view';

const MM = MetamodelSchema.parse({
	elements: [
		{ name: 'Asset', abstract: true, properties: [{ name: 'name', datatype: 'string' }] },
		{
			name: 'Building',
			extends: 'Asset',
			properties: [{ name: 'height', datatype: 'number', multiplicity: '0..1' }]
		}
	],
	relationships: [{ name: 'Owns', source: 'Asset', target: 'Asset', containment: true }]
});

describe('docs-view', () => {
	it('formats units', () => {
		expect(formatSeconds(10)).toBe('10 s');
		expect(formatSeconds(3.5)).toBe('3.5 s');
		expect(formatBytes(268435456)).toBe('256 MiB');
		expect(formatBytes(262144)).toBe('256 KiB');
		expect(formatBytes(1000)).toBe('1000 B');
	});

	it('groups facade entries by owner', () => {
		const g = groupFacade([
			{ name: 'dr.create', kind: 'function', signature: 's', doc: 'd', example: null },
			{ name: 'Element.set', kind: 'method', signature: 's', doc: 'd', example: null },
			{ name: 'Relationship.source', kind: 'method', signature: 's', doc: 'd', example: null },
			{ name: 'dr.NotFoundError', kind: 'exception', signature: 's', doc: 'd', example: null }
		]);
		expect(g.dr.map((e) => e.name)).toEqual(['dr.create']);
		expect(g.element.map((e) => e.name)).toEqual(['Element.set']);
		expect(g.relationship.map((e) => e.name)).toEqual(['Relationship.source']);
		expect(g.errors.map((e) => e.name)).toEqual(['dr.NotFoundError']);
	});

	it('renders element type rows with effective (inherited) properties', () => {
		const rows = elementTypeRows(MM);
		const building = rows.find((r) => r.name === 'Building');
		expect(building?.properties.map((p) => p.name)).toEqual(['name', 'height']);
		expect(rows.find((r) => r.name === 'Asset')?.abstract).toBe(true);
		expect(elementTypeRows(null)).toEqual([]);
	});

	it('renders relationship rows', () => {
		expect(relationshipRows(MM)).toEqual([
			{ name: 'Owns', abstract: false, source: 'Asset', target: 'Asset', containment: true }
		]);
		expect(relationshipRows(null)).toEqual([]);
	});
});

describe('filterFacade', () => {
	const entries: FacadeDocEntry[] = [
		{
			name: 'dr.create',
			kind: 'function',
			signature: 'dr.create(type_name)',
			doc: 'Record a create.',
			example: null
		},
		{
			name: 'Element.set',
			kind: 'method',
			signature: 'Element.set(key, value)',
			doc: 'Update a property.',
			example: null
		}
	];

	it('blank query returns input unchanged', () => {
		expect(filterFacade(entries, '')).toEqual(entries);
		expect(filterFacade(entries, '   ')).toEqual(entries);
	});

	it('matches name, signature, and doc, case-insensitively', () => {
		expect(filterFacade(entries, 'CREATE').map((e) => e.name)).toEqual(['dr.create']);
		expect(filterFacade(entries, 'key, value').map((e) => e.name)).toEqual(['Element.set']);
		expect(filterFacade(entries, 'property').map((e) => e.name)).toEqual(['Element.set']);
		expect(filterFacade(entries, 'zzz')).toEqual([]);
	});
});

describe('filterTypeRows / filterRelRows', () => {
	const types: TypeRow[] = [
		{
			name: 'Building',
			abstract: false,
			properties: [{ name: 'height', datatype: 'integer', multiplicity: '0..1' }]
		},
		{ name: 'Sensor', abstract: false, properties: [] }
	];
	const rels: RelRow[] = [
		{ name: 'Owns', abstract: false, source: 'Building', target: 'Sensor', containment: true }
	];

	it('matches type name or property name', () => {
		expect(filterTypeRows(types, 'sens').map((t) => t.name)).toEqual(['Sensor']);
		expect(filterTypeRows(types, 'height').map((t) => t.name)).toEqual(['Building']);
		expect(filterTypeRows(types, '')).toEqual(types);
	});

	it('blank query returns input unchanged', () => {
		expect(filterTypeRows(types, '   ')).toEqual(types);
	});

	it('matches relationship name or endpoints', () => {
		expect(filterRelRows(rels, 'owns')).toEqual(rels);
		expect(filterRelRows(rels, 'sensor')).toEqual(rels);
		expect(filterRelRows(rels, 'zzz')).toEqual([]);
	});

	it('blank query returns input unchanged', () => {
		expect(filterRelRows(rels, '   ')).toEqual(rels);
	});
});
