import { expect, it } from 'vitest';
import { elementLine, Model, verifyConsistent } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

it('treats property names that live on Object.prototype as plain keys', () => {
	const model = new Model(nodeMetamodel());
	const a = model.createElement('Node', 'a');
	const b = model.createElement('Node', 'b');
	model.setProperty(a, 'name', 'x');
	model.setProperty(a, '__proto__', 'p');
	model.setProperty(a, 'constructor', 'c');
	expect(Object.getPrototypeOf(a.props)).toBe(Object.prototype);
	expect(elementLine(a)).toBe(
		'{"id":"a","type_name":"Node","properties":{"name":"x","__proto__":"p","constructor":"c"},"rev":3}'
	);
	// An unset `constructor` is absent, not the inherited function.
	model.setProperty(b, 'name', 'x');
	expect(model.indexes.uniqGroupOf(a)).toEqual([a]);
	model.deleteProperty(a, '__proto__');
	model.deleteProperty(a, 'constructor');
	expect(model.indexes.uniqGroupOf(a)).toHaveLength(2);
	expect(model.indexes.uniqGroupOf(a)).toContain(b);
	verifyConsistent(model);
});

it('keeps the place of a rewritten key and appends a new one', () => {
	const model = new Model(nodeMetamodel());
	const a = model.createElement('Node', 'a');
	model.setProperty(a, 'name', 'x');
	model.setProperty(a, 'peer', 'b');
	model.setProperty(a, 'name', 'y');
	expect(Object.keys(a.props)).toEqual(['name', 'peer']);
	model.deleteProperty(a, 'name');
	model.setProperty(a, 'name', 'z');
	expect(Object.keys(a.props)).toEqual(['peer', 'name']);
});
