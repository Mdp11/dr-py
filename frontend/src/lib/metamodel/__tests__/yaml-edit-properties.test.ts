import { describe, expect, it } from 'vitest';
import { applyEdit, parseDraft, serializeDraft, type YamlEditCommand } from '../yaml-edit';
import { FIXTURE } from './fixtures';

function run(buffer: string, cmds: YamlEditCommand[]): string {
	const { doc } = parseDraft(buffer);
	for (const c of cmds) applyEdit(doc, c);
	return serializeDraft(doc);
}

const P = (over: Record<string, unknown> = {}) => ({
	name: 'height',
	datatype: 'float',
	multiplicity: '0..1',
	min: null,
	max: null,
	pattern: null,
	max_length: null,
	...over
});

describe('property commands', () => {
	it('addProperty writes a flow map without default-valued fields', () => {
		const out = run(FIXTURE, [
			{ kind: 'addProperty', owner: { kind: 'element', name: 'Building' }, prop: P({ min: 0 }) }
		]);
		expect(out).toContain('- {name: height, datatype: float, min: 0}');
		expect(out).not.toContain('multiplicity: 0..1'); // default omitted
	});

	it('addProperty creates the properties seq when absent', () => {
		const out = run(FIXTURE, [
			{ kind: 'addProperty', owner: { kind: 'relationship', name: 'Contains' }, prop: P() }
		]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Contains')!;
		expect(rel.properties.map((p) => p.name)).toEqual(['height']);
	});

	it('updateProperty renames and adjusts facets in place', () => {
		const out = run(FIXTURE, [
			{
				kind: 'updateProperty',
				owner: { kind: 'element', name: 'Zone' },
				propName: 'area',
				prop: P({ name: 'surface', datatype: 'float', min: 1, max: 9000 })
			}
		]);
		const zone = parseDraft(out).mm!.elements.find((e) => e.name === 'Zone')!;
		expect(zone.properties[0]).toMatchObject({ name: 'surface', min: 1, max: 9000 });
		expect(out).toContain('# the abstract root'); // untouched comment survives
	});

	it('updateProperty deletes facets set back to null', () => {
		const out = run(FIXTURE, [
			{
				kind: 'updateProperty',
				owner: { kind: 'element', name: 'Zone' },
				propName: 'area',
				prop: P({ name: 'area', min: null })
			}
		]);
		expect(out).not.toMatch(/name: area[^}]*min/);
	});

	it('removeProperty drops only the named row', () => {
		const out = run(FIXTURE, [
			{ kind: 'removeProperty', owner: { kind: 'element', name: 'NamedElement' }, propName: 'name' }
		]);
		const root = parseDraft(out).mm!.elements.find((e) => e.name === 'NamedElement')!;
		expect(root.properties).toEqual([]);
	});

	it('unknown property throws', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(() =>
			applyEdit(doc, {
				kind: 'removeProperty',
				owner: { kind: 'element', name: 'Zone' },
				propName: 'nope'
			})
		).toThrow();
	});
});
