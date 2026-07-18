import { describe, expect, it } from 'vitest';
import { MetamodelSchema } from '$lib/api/types';
import {
	elementTypeRows,
	formatBytes,
	formatSeconds,
	groupFacade,
	relationshipRows
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
			{ name: 'dr.NotFoundError', kind: 'exception', signature: 's', doc: 'd', example: null }
		]);
		expect(g.dr.map((e) => e.name)).toEqual(['dr.create']);
		expect(g.element.map((e) => e.name)).toEqual(['Element.set']);
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
