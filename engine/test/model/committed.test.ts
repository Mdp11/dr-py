import { describe, expect, it } from 'vitest';
import { dumpIndexes, Model, modelLines, verifyConsistent } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

describe('committed state enters unchecked and uncounted', () => {
	it('inserts an element of a type the metamodel does not have, with its properties and rev', () => {
		const model = new Model(nodeMetamodel());
		model.insertElement('x', 'Gone', { anything: 1 }, 7);
		expect(modelLines(model)).toEqual([
			'{"id":"x","type_name":"Gone","properties":{"anything":1},"rev":7}'
		]);
		expect(dumpIndexes(model).roots).toEqual([['x', 'x']]);
		verifyConsistent(model);
	});

	it('indexes what the properties say at once: references and the root name', () => {
		const model = new Model(nodeMetamodel());
		model.insertElement('b', 'Node', { name: 'B', peer: 'a' }, 2);
		model.insertElement('a', 'Node', { name: 'A' }, 1);
		expect([...model.indexes.referencersOf('a')]).toEqual(['b']);
		expect(dumpIndexes(model).roots).toEqual([
			['A', 'a'],
			['B', 'b']
		]);
		verifyConsistent(model);
	});

	it('inserts a relationship with its rev, and refuses missing ends and a taken id', () => {
		const model = new Model(nodeMetamodel());
		model.insertElement('a', 'Node', {}, 0);
		model.insertElement('b', 'Node', {}, 0);
		model.insertRelationship('r', 'NoSuchType', 'a', 'b', {}, 3);
		expect(model.getRelationship('r').rev).toBe(3);
		expect(() => model.insertRelationship('s', 'Refers', 'ghost', 'b', {}, 0)).toThrow(
			"No source element 'ghost'"
		);
		expect(() => model.insertRelationship('s', 'Refers', 'a', 'ghost', {}, 0)).toThrow(
			"No target element 'ghost'"
		);
		expect(() => model.insertRelationship('a', 'Refers', 'a', 'b', {}, 0)).toThrow(
			"Id 'a' is already in use"
		);
		expect(() => model.insertElement('r', 'Node', {}, 0)).toThrow("Id 'r' is already in use");
		verifyConsistent(model);
	});

	it('puts a record back at its old place when given its ord', () => {
		const model = new Model(nodeMetamodel());
		const first = model.insertElement('first', 'Node', {}, 0);
		model.insertElement('second', 'Node', {}, 0);
		model.deleteElement('first');
		model.insertElement('first', 'Node', { name: 'back' }, 9, first.ord);
		expect([...model.elements()].map((e) => e.id)).toEqual(['first', 'second']);
		verifyConsistent(model);
	});

	it('overwrites properties and rev whole, checking no name and counting nothing', () => {
		const model = new Model(nodeMetamodel());
		const a = model.insertElement('a', 'Node', { name: 'A', peer: 'x' }, 4);
		model.overwrite(a, { undeclared: true, name: 'Z' }, 2);
		expect(modelLines(model)).toEqual([
			'{"id":"a","type_name":"Node","properties":{"undeclared":true,"name":"Z"},"rev":2}'
		]);
		expect([...model.indexes.referencersOf('x')]).toEqual([]);
		verifyConsistent(model);
	});
});
