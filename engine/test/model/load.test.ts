import { describe, expect, it } from 'vitest';
import { Model, parseJson, SnapshotError } from '../../src/index.ts';
import { nodeMetamodel } from './fixtures.ts';

function loadElement(line: string): Model {
	const model = new Model(nodeMetamodel());
	model.loadElement(parseJson(line));
	return model;
}

describe('bulk load, where the engine is stricter than the oracle', () => {
	it('proves the reason: an object lists array-index keys first', () => {
		expect(Object.keys({ b: 1, 1: 2, a: 3, 0: 4 })).toEqual(['0', '1', 'b', 'a']);
		expect(Object.keys({ b: 1, '4294967295': 2, '01': 3 })).toEqual(['b', '4294967295', '01']);
	});

	it.each([
		['{"id":"a","type_name":"Node","properties":{"name":"x","0":1}}', "'0'"],
		['{"id":"a","type_name":"Node","properties":{"name":{"k":[{"42":1}]}}}', "'42'"],
		['{"id":"a","type_name":"Node","properties":{"4294967294":1}}', "'4294967294'"]
	])('refuses an array-index property key: %s', (line, key) => {
		expect(() => loadElement(line)).toThrow(SnapshotError);
		expect(() => loadElement(line)).toThrow(
			`elements[0]: property key ${key} is an array index, which cannot keep its place in insertion order`
		);
	});

	it('accepts numeric-looking keys that are not array indexes', () => {
		const model = loadElement(
			'{"id":"a","type_name":"Node","properties":{"b":1,"4294967295":2,"01":3,"-1":4,"1.5":5}}'
		);
		expect(Object.keys(model.getElement('a').props)).toEqual([
			'b',
			'4294967295',
			'01',
			'-1',
			'1.5'
		]);
	});

	it('refuses a relationship whose id an element holds', () => {
		const model = loadElement('{"id":"a","type_name":"Node"}');
		const rel = parseJson('{"id":"a","type_name":"Refers","source_id":"a","target_id":"a"}');
		expect(() => model.loadRelationship(rel)).toThrow(
			new SnapshotError("Relationship id 'a' is already an element id")
		);
	});

	it('refuses a rev too large to be a number', () => {
		expect(() => loadElement('{"id":"a","type_name":"Node","rev":9007199254740993}')).toThrow(
			"elements[0]: field 'rev' must be an integer"
		);
	});
});
