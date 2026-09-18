import { describe, expect, it } from 'vitest';
import { Model, verifyConsistent } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

const elementIds = (model: Model) => [...model.elements()].map((e) => e.id);
const relationshipIds = (model: Model) => [...model.relationships()].map((r) => r.id);

function chain(): Model {
	const model = new Model(nodeMetamodel());
	for (const id of ['a', 'b', 'c']) model.createElement('Node', id);
	model.connect('Contains', 'a', 'c', 'a-c');
	model.connect('Contains', 'b', 'c', 'b-c');
	return model;
}

describe('state order', () => {
	it('appends a restored entity when no ord is given, as the oracle does', () => {
		const model = chain();
		model.disconnect('a-c');
		model.deleteElement('a');
		model.restoreElement('a', 'Node');
		model.restoreRelationship('a-c', 'Contains', 'a', 'c');
		expect(elementIds(model)).toEqual(['b', 'c', 'a']);
		expect(relationshipIds(model)).toEqual(['b-c', 'a-c']);
		expect(model.containerOf('c')).toBe('b');
		verifyConsistent(model);
	});

	it('puts an element restored with its old ord back in its place', () => {
		const model = chain();
		const ord = model.getElement('a').ord;
		model.deleteElement('a');
		expect(elementIds(model)).toEqual(['b']);
		model.restoreElement('a', 'Node', ord);
		expect(elementIds(model)).toEqual(['a', 'b']);
		model.createElement('Node', 'd');
		expect(elementIds(model)).toEqual(['a', 'b', 'd']);
		verifyConsistent(model);
	});

	it('puts a relationship restored with its old ord back in its place, owner included', () => {
		const model = chain();
		const ord = model.getRelationship('a-c').ord;
		model.disconnect('a-c');
		expect(model.containerOf('c')).toBe('b');
		model.restoreRelationship('a-c', 'Contains', 'a', 'c', ord);
		expect(relationshipIds(model)).toEqual(['a-c', 'b-c']);
		expect(model.containerOf('c')).toBe('a');
		expect(model.getElement('c').parents.map((rel) => rel.id)).toEqual(['a-c', 'b-c']);
		verifyConsistent(model);
	});

	it('keeps minting ords above a restored one', () => {
		const model = new Model(nodeMetamodel());
		model.restoreElement('late', 'Node', 40);
		model.createElement('Node', 'later');
		expect(model.getElement('later').ord).toBe(41);
		expect(elementIds(model)).toEqual(['late', 'later']);
	});
});

describe('ids', () => {
	it('refuses an id in use by either kind, on create as on restore', () => {
		const model = chain();
		expect(() => model.createElement('Node', 'a')).toThrow("Id 'a' is already in use");
		expect(() => model.createElement('Node', 'a-c')).toThrow("Id 'a-c' is already in use");
		expect(() => model.connect('Refers', 'a', 'b', 'c')).toThrow("Id 'c' is already in use");
	});
});
