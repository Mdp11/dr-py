import { describe, expect, it } from 'vitest';
import { applyEdit, parseDraft, serializeDraft } from '../yaml-edit';
import { FIXTURE } from './fixtures';

function run(buffer: string, cmds: Parameters<typeof applyEdit>[1][]): string {
	const { doc, errors } = parseDraft(buffer);
	expect(errors).toEqual([]);
	for (const c of cmds) applyEdit(doc, c);
	return serializeDraft(doc);
}

describe('element type commands', () => {
	it('addElementType appends a named block and preserves every other line', () => {
		const out = run(FIXTURE, [{ kind: 'addElementType', name: 'Sensor' }]);
		expect(out).toContain('- name: Sensor');
		for (const line of FIXTURE.split('\n')) expect(out).toContain(line);
	});

	it('setElementAbstract / setElementExtends write and clear attrs', () => {
		let out = run(FIXTURE, [{ kind: 'setElementAbstract', name: 'Zone', value: true }]);
		expect(parseDraft(out).mm!.elements.find((e) => e.name === 'Zone')!.abstract).toBe(true);
		out = run(FIXTURE, [{ kind: 'setElementExtends', name: 'Zone', value: null }]);
		expect(out).not.toMatch(/name: Zone\n\s+extends:/);
	});

	it('renameElementType cascades extends, mappings, shorthand and datatypes', () => {
		const withRef = FIXTURE.replace(
			'- {name: area, datatype: float, min: 0}',
			'- {name: area, datatype: float, min: 0}\n      - {name: main_building, datatype: Building}'
		);
		const out = run(withRef, [{ kind: 'renameElementType', from: 'Building', to: 'Facility' }]);
		const mm = parseDraft(out).mm!;
		expect(mm.elements.some((e) => e.name === 'Facility')).toBe(true);
		expect(out).not.toContain('Building');
		const contains = mm.relationships.find((r) => r.name === 'Contains')!;
		expect(contains.mappings[0]).toEqual({ source: 'Zone', target: 'Facility' });
	});

	it('renameElementType keeps the # comment above the renamed block', () => {
		const out = run(FIXTURE, [{ kind: 'renameElementType', from: 'NamedElement', to: 'Root' }]);
		expect(out).toContain('# the abstract root');
	});

	it('removeElementType drops mappings touching it and clears extends to it', () => {
		const out = run(FIXTURE, [{ kind: 'removeElementType', name: 'Building' }]);
		const mm = parseDraft(out).mm!;
		expect(mm.elements.some((e) => e.name === 'Building')).toBe(false);
		const contains = mm.relationships.find((r) => r.name === 'Contains')!;
		expect(contains.mappings).toEqual([]); // its only pair touched Building
		const monitors = mm.relationships.find((r) => r.name === 'Monitors')!;
		expect(monitors.mappings).toEqual([]);
	});

	it('removeElementType throws without mutating when there is no elements section', () => {
		const buffer = 'enums:\n  Status: [Draft, Active]\n';
		const { doc } = parseDraft(buffer);
		expect(() => applyEdit(doc, { kind: 'removeElementType', name: 'Zone' })).toThrow();
		expect(serializeDraft(doc)).toBe(buffer);
	});

	it('setElementKey writes a flow list and null removes it', () => {
		let out = run(FIXTURE, [
			{ kind: 'setElementKey', name: 'Zone', key: ['name', 'out:Contains'] }
		]);
		expect(out).toContain('key: [name, out:Contains]');
		out = run(out, [{ kind: 'setElementKey', name: 'Zone', key: null }]);
		expect(out).not.toMatch(/name: Zone[\s\S]*?key:/);
	});

	it('throws YamlEditError for an unknown target', () => {
		const { doc } = parseDraft(FIXTURE);
		expect(() =>
			applyEdit(doc, { kind: 'setElementAbstract', name: 'Nope', value: true })
		).toThrow();
	});
});

describe('enum commands', () => {
	it('addEnum / setEnumLiterals / removeEnum', () => {
		let out = run(FIXTURE, [{ kind: 'addEnum', name: 'Health', literals: ['Ok', 'Bad'] }]);
		expect(parseDraft(out).mm!.enums.Health).toEqual(['Ok', 'Bad']);
		out = run(out, [{ kind: 'setEnumLiterals', name: 'Health', literals: ['Ok'] }]);
		expect(parseDraft(out).mm!.enums.Health).toEqual(['Ok']);
		out = run(out, [{ kind: 'removeEnum', name: 'Health' }]);
		expect(parseDraft(out).mm!.enums.Health).toBeUndefined();
	});

	it('renameEnum keeps the inline comment and cascades datatypes', () => {
		const withEnumProp = FIXTURE.replace(
			'- {name: area, datatype: float, min: 0}',
			'- {name: status, datatype: Status}'
		);
		const out = run(withEnumProp, [{ kind: 'renameEnum', from: 'Status', to: 'State' }]);
		expect(out).toContain('State: [Draft, Active] # inline comment');
		expect(
			parseDraft(out).mm!.elements.find((e) => e.name === 'Zone')!.properties[0].datatype
		).toBe('State');
	});
});
