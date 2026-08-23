import { describe, expect, it } from 'vitest';
import { applyEdit, parseDraft, serializeDraft, type YamlEditCommand } from '../yaml-edit';
import { FIXTURE } from './fixtures';

function run(buffer: string, cmds: YamlEditCommand[]): string {
	const { doc } = parseDraft(buffer);
	for (const c of cmds) applyEdit(doc, c);
	return serializeDraft(doc);
}

describe('relationship commands', () => {
	it('addRelationshipType with a first mapping uses the shorthand', () => {
		const out = run(FIXTURE, [
			{
				kind: 'addRelationshipType',
				name: 'Powers',
				containment: false,
				mapping: { source: 'Zone', target: 'Building' }
			}
		]);
		expect(out).toMatch(/- name: Powers\n\s+source: Zone\n\s+target: Building/);
	});

	it('addRelationshipType with no mapping emits only the name (abstract-authorable)', () => {
		const out = run(FIXTURE, [
			{ kind: 'addRelationshipType', name: 'Feeds', containment: false, mapping: null }
		]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Feeds')!;
		expect(rel.mappings).toEqual([]);
	});

	it('a second mapping materializes an explicit mappings list, shorthand mirrors first', () => {
		const out = run(FIXTURE, [
			{ kind: 'addMapping', name: 'Contains', mapping: { source: 'Zone', target: 'Zone' } }
		]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Contains')!;
		expect(rel.mappings).toEqual([
			{ source: 'Zone', target: 'Building' },
			{ source: 'Zone', target: 'Zone' }
		]);
		expect(out).toContain('mappings:');
	});

	it('removeMapping on the shorthand-only pair drops the endpoint keys', () => {
		const out = run(FIXTURE, [
			{ kind: 'removeMapping', name: 'Monitors', mapping: { source: 'Building', target: 'Zone' } }
		]);
		const rel = parseDraft(out).mm!.relationships.find((r) => r.name === 'Monitors')!;
		expect(rel.mappings).toEqual([]);
	});

	it('renameRelationshipType cascades rel extends and key DSL entries', () => {
		const withDsl = FIXTURE.replace('key: [name]', 'key: [name, out:Monitors]');
		const out = run(withDsl, [{ kind: 'renameRelationshipType', from: 'Monitors', to: 'Watches' }]);
		expect(out).toContain('key: [name, out:Watches]');
		const child = parseDraft(out).mm!.relationships.find((r) => r.name === 'Watches')!;
		expect(child.extends).toBe('Observes');
		const renamedBase = run(out, [
			{ kind: 'renameRelationshipType', from: 'Observes', to: 'Sees' }
		]);
		expect(
			parseDraft(renamedBase).mm!.relationships.find((r) => r.name === 'Watches')!.extends
		).toBe('Sees');
	});

	it('setEndMultiplicity and containment toggles round-trip', () => {
		const out = run(FIXTURE, [
			{ kind: 'setEndMultiplicity', name: 'Contains', end: 'target', value: '1..*' },
			{ kind: 'setRelationshipContainment', name: 'Monitors', value: true }
		]);
		const mm = parseDraft(out).mm!;
		expect(mm.relationships.find((r) => r.name === 'Contains')!.target_multiplicity).toBe('1..*');
		expect(mm.relationships.find((r) => r.name === 'Monitors')!.containment).toBe(true);
	});

	it('removeRelationshipType leaves key DSL references for lint', () => {
		const withDsl = FIXTURE.replace('key: [name]', 'key: [name, out:Contains]');
		const out = run(withDsl, [{ kind: 'removeRelationshipType', name: 'Contains' }]);
		expect(out).toContain('out:Contains'); // deliberate: lint flags the dangling reference
		expect(parseDraft(out).mm!.relationships.some((r) => r.name === 'Contains')).toBe(false);
	});
});
