import { describe, expect, it } from 'vitest';
import {
	EMPTY_RULES,
	FacetPatterns,
	liveStructure,
	Metamodel,
	Model,
	validateScoped,
	validateSplit,
	Validators,
	type ElementRec,
	type Structure
} from '../../src/index.ts';
import { smartCity } from '../service/helpers.ts';
import { NODE_DOC, nodeMetamodel } from './fixtures.ts';

/** A copy of the model's first root element, so that one group has two members. */
function withDuplicate(model = smartCity().model): {
	model: Model;
	original: ElementRec;
	copy: ElementRec;
} {
	const original = [...model.elements()].find((el) => el.parents.length === 0)!;
	const copy = model.insertElement('dup-1', original.typeName, { ...original.props }, 0);
	return { model, original, copy };
}

const allIds = (model: Model) => [
	...[...model.elements()].map((el) => el.id),
	...[...model.relationships()].map((rel) => rel.id)
];

describe('liveStructure', () => {
	it('is the model own view, once per model', () => {
		const { model } = smartCity();
		const structure = liveStructure(model);
		expect(liveStructure(model)).toBe(structure);
		expect(structure.metamodel).toBe(model.metamodel);
	});

	it('answers the records own parents', () => {
		const { model } = smartCity();
		const structure = liveStructure(model);
		for (const el of model.elements()) expect(structure.parentsOf(el)).toBe(el.parents);
	});

	it('answers the uniqueness key the indexes hold', () => {
		const { model } = withDuplicate();
		const structure = liveStructure(model);
		for (const el of model.elements()) {
			expect(structure.keyOf(el), el.id).toBe(model.indexes.uniqKey(el));
		}
	});

	it('answers no group for an element alone, and the index group for a duplicate', () => {
		const { model, original, copy } = withDuplicate();
		const structure = liveStructure(model);
		const alone = [...model.elements()].find((el) => el !== original && el !== copy)!;
		expect(structure.groupOf(alone)).toBeNull();
		for (const el of [original, copy]) {
			expect(new Set(structure.groupOf(el))).toEqual(new Set(model.indexes.uniqGroupOf(el)));
			expect(new Set(structure.groupOf(el))).toEqual(new Set([original, copy]));
		}
	});

	it('groups by key text when different keys share a bucket', () => {
		const model = new Model(nodeMetamodel(), { hashKey: () => 0 });
		const a = model.createElement('Node', 'a');
		const b = model.createElement('Node', 'b');
		model.setProperty(a, 'name', 'A');
		model.setProperty(b, 'name', 'B');
		const structure = liveStructure(model);
		expect(structure.groupOf(a)).toEqual([a]);
		expect(structure.groupOf(b)).toEqual([b]);
		const mm = model.metamodel;
		const issues = validateScoped(model, ['a', 'b'], new Validators(mm), new FacetPatterns(mm));
		expect(issues.filter((i) => i.check === 'uniqueness')).toEqual([]);

		const c = model.createElement('Node', 'c');
		model.setProperty(c, 'name', 'A');
		expect(new Set(structure.groupOf(a))).toEqual(new Set([a, c]));
		expect(structure.groupOf(b)).toEqual([b]);
	});
});

describe('validateSplit', () => {
	it.each([
		['no rules', null],
		['empty rules', EMPTY_RULES]
	] as const)(
		'with %s, is validateScoped split into entity and per-validator global',
		(_, rules) => {
			// A containment cycle and a duplicate, so that both global hooks answer.
			const { model } = smartCity();
			const contains = model.metamodel.relationships.find((type) => type.containment)!;
			const child = [...model.elements()].find((el) => el.parents.length > 0)!;
			model.insertRelationship(
				'cycle-1',
				contains.name,
				child.id,
				child.parents[0]!.source.id,
				{},
				0
			);
			withDuplicate(model);
			const mm = model.metamodel;
			const v = new Validators(mm);
			const p = new FacetPatterns(mm);
			const ids = allIds(model);
			const split = validateSplit(model, ids, v, p, rules, liveStructure(model));
			expect(split.global).toHaveLength(v.list.length + (rules === null ? 0 : 1));
			expect(split.global.flat().some((i) => i.check === 'uniqueness')).toBe(true);
			expect(split.global.flat().some((i) => i.check === 'containment')).toBe(true);
			expect([...split.entity, ...split.global.flat()]).toEqual(
				validateScoped(model, ids, v, p, rules)
			);
		}
	);
});

describe('validateScoped', () => {
	it('refuses a structure whose metamodel is not the validators', () => {
		const { model } = smartCity();
		const mm = model.metamodel;
		const live = liveStructure(model);
		const other: Structure = {
			metamodel: Metamodel.fromJSON(NODE_DOC),
			parentsOf: (el) => live.parentsOf(el),
			groupOf: (el) => live.groupOf(el),
			keyOf: (el) => live.keyOf(el)
		};
		expect(() =>
			validateScoped(model, allIds(model), new Validators(mm), new FacetPatterns(mm), null, other)
		).toThrow('validators built for another metamodel');
	});
});
