import { describe, expect, it } from 'vitest';
import {
	candidateStructureSteps,
	drain,
	EMPTY_RULES,
	FacetPatterns,
	liveStructure,
	Metamodel,
	Model,
	PyFloat,
	validateScoped,
	validateSplit,
	Validators,
	type ElementRec,
	type KeySpec,
	type MetamodelDoc,
	type Progress,
	type RelRec,
	type Structure,
	uniqKeyText
} from '../../src/index.ts';
import { smartCity } from '../service/helpers.ts';
import { family, NODE_DOC, nodeMetamodel } from './fixtures.ts';

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

/** The model's copy under its own metamodel, with every uniqueness key in one bucket or not. */
function rehashed(source: Model, hashKey?: (key: string) => number): Model {
	const model = new Model(source.metamodel, hashKey === undefined ? {} : { hashKey });
	for (const el of source.elements()) model.insertElement(el.id, el.typeName, el.props, el.rev);
	for (const rel of source.relationships()) {
		model.insertRelationship(
			rel.id,
			rel.typeName,
			rel.source.id,
			rel.target.id,
			rel.props,
			rel.rev
		);
	}
	return model;
}

/** `withDuplicate`'s model, with a contained element given a second containment parent. */
function withTwoParents(): Model {
	const { model } = withDuplicate();
	const contains = model.metamodel.relationships.find((type) => type.containment)!;
	const child = [...model.elements()].find((el) => el.parents.length > 0)!;
	const other = [...model.elements()].find(
		(el) => el !== child && el !== child.parents[0]!.source && el.parents.length === 0
	)!;
	model.insertRelationship('second-parent', contains.name, other.id, child.id, {}, 0);
	return model;
}

/** Two keys sharing a bucket under a forced hash, and one real pair. */
function collisionModel(hashKey?: (key: string) => number): Model {
	const model = new Model(nodeMetamodel(), hashKey === undefined ? {} : { hashKey });
	for (const [id, name] of [
		['a', 'A'],
		['b', 'B'],
		['c', 'A']
	] as const) {
		model.setProperty(model.createElement('Node', id), 'name', name);
	}
	return model;
}

const candidateOf = (model: Model, mm = model.metamodel) =>
	drain(candidateStructureSteps(model, mm));

/** Uniqueness reads a null group and a group of one alike: the element is alone. */
const members = (group: readonly ElementRec[] | null) =>
	group === null || group.length < 2 ? null : new Set(group);

function expectSameStructure(model: Model, a: Structure, b: Structure): void {
	for (const el of model.elements()) {
		expect(b.parentsOf(el), el.id).toEqual(a.parentsOf(el));
		expect(
			b.parentsOf(el).every((rel, i) => rel === a.parentsOf(el)[i]),
			el.id
		).toBe(true);
		expect(members(b.groupOf(el)), el.id).toEqual(members(a.groupOf(el)));
		expect(b.keyOf(el), el.id).toBe(a.keyOf(el));
	}
}

const byOrd = (rels: readonly RelRec[]) =>
	rels.every((rel, i) => i === 0 || rels[i - 1]!.ord < rel.ord);

/** `NODE_DOC` with `Node`'s key. */
function keyedDoc(key: string[] | null): MetamodelDoc {
	const doc = structuredClone(NODE_DOC);
	doc.elements[0]!.key = key;
	return doc;
}

describe('candidateStructureSteps', () => {
	it.each([
		['the default hash', undefined],
		['one bucket', () => 0]
	] as const)('under the live metamodel equals the live structure, with %s', (_, hashKey) => {
		for (const model of [rehashed(withTwoParents(), hashKey), collisionModel(hashKey)]) {
			const candidate = candidateOf(model);
			expect(candidate.metamodel).toBe(model.metamodel);
			expectSameStructure(model, liveStructure(model), candidate);
		}
	});

	it('answers no group for an element alone, even when its bucket is shared', () => {
		const model = collisionModel(() => 0);
		const [a, b, c] = ['a', 'b', 'c'].map((id) => model.getElement(id));
		const candidate = candidateOf(model);
		expect(liveStructure(model).groupOf(b!)).toEqual([b]);
		expect(candidate.groupOf(b!)).toBeNull();
		expect(new Set(candidate.groupOf(a!))).toEqual(new Set([a, c]));
		expect(candidate.groupOf(c!)).toBe(candidate.groupOf(a!));
	});

	it('gives a turned-on containment type to its targets as parents, in relationship order', () => {
		const { model, doc } = smartCity();
		const mm = model.metamodel;
		// The type whose edges most often precede a target's containment parent, so
		// that the candidate's parents interleave the two kinds.
		const count = new Map<string, number>();
		const preceding = new Map<string, number>();
		for (const rel of model.relationships()) {
			count.set(rel.typeName, (count.get(rel.typeName) ?? 0) + 1);
			if (rel.target.parents.some((parent) => rel.ord < parent.ord)) {
				preceding.set(rel.typeName, (preceding.get(rel.typeName) ?? 0) + 1);
			}
		}
		const flipped = mm.relationships
			.filter(
				(type) =>
					!mm.isContainment(type.name) &&
					mm.relationshipDescendants(type.name).size === 1 &&
					preceding.has(type.name)
			)
			.sort((x, y) => preceding.get(y.name)! - preceding.get(x.name)!)[0]!;
		const candidateDoc = structuredClone(doc);
		candidateDoc.relationships.find((type) => type.name === flipped.name)!.containment = true;
		const before = new Map([...model.elements()].map((el) => [el, [...el.parents]] as const));

		const candidateMm = Metamodel.fromJSON(candidateDoc);
		const candidate = candidateOf(model, candidateMm);
		const specs = new Map<string, KeySpec | null>();
		let gained = 0;
		for (const el of model.elements()) {
			const parents = candidate.parentsOf(el);
			const added = el.in.filter((rel) => rel.typeName === flipped.name);
			gained += added.length;
			expect(new Set(parents), el.id).toEqual(new Set([...el.parents, ...added]));
			expect(parents, el.id).toHaveLength(el.parents.length + added.length);
			expect(byOrd(parents), el.id).toBe(true);
			expect(el.parents, el.id).toEqual(before.get(el));
			expect(candidate.keyOf(el), el.id).toBe(
				uniqKeyText(candidateMm, (of) => candidate.parentsOf(of), el, specs)
			);
		}
		expect(gained).toBe(count.get(flipped.name));
	});

	it('groups elements that differ only in the old key once the key moves', () => {
		const model = new Model(Metamodel.fromJSON(keyedDoc(['name'])));
		const values = [1, new PyFloat(1), true, '1'] as const;
		const els = values.map((value, i) => {
			const el = model.createElement('Node', `n${i}`);
			model.setProperty(el, 'name', `N${i}`);
			model.setProperty(el, 'constructor', value);
			return el;
		});
		const [int, float, bool, text] = els as [ElementRec, ElementRec, ElementRec, ElementRec];
		for (const el of els) expect(liveStructure(model).groupOf(el)).toBeNull();

		const candidate = candidateOf(model, Metamodel.fromJSON(keyedDoc(['constructor'])));
		for (const el of [int, float, bool]) {
			expect(new Set(candidate.groupOf(el)), el.id).toEqual(new Set([int, float, bool]));
			expect(candidate.keyOf(el), el.id).toBe(candidate.keyOf(int));
		}
		expect(candidate.groupOf(text)).toBeNull();
		expect(candidate.keyOf(text)).not.toBe(candidate.keyOf(int));
	});

	it('keys an owner by its candidate parent', () => {
		// `b` and `d` share every property; only a containment parent tells them apart.
		const model = family();
		model.setProperty(model.getElement('d'), 'name', 'B');
		const [b, d] = [model.getElement('b'), model.getElement('d')];
		const flat = structuredClone(NODE_DOC);
		flat.relationships[0]!.containment = false;
		expect(liveStructure(model).groupOf(b)).toBeNull();
		expect(new Set(candidateOf(model, Metamodel.fromJSON(flat)).groupOf(b))).toEqual(
			new Set([b, d])
		);
	});

	it('steps through at most 2,048 records a step, and drains to the same structure', () => {
		const model = new Model(nodeMetamodel());
		for (let i = 0; i < 3000; i++) {
			model.setProperty(model.createElement('Node', `e${i}`), 'name', `N${i % 1500}`);
		}
		for (let i = 1; i < 2600; i++) model.connect('Contains', `e${i - 1}`, `e${i}`, `r${i}`);
		let visits = 0;
		const counted = <T>(iterate: () => IterableIterator<T>) =>
			function* (): Generator<T, undefined, undefined> {
				for (const item of iterate()) {
					visits++;
					yield item;
				}
			};
		model.elements = counted(model.elements.bind(model));
		model.relationships = counted(model.relationships.bind(model));

		const steps = candidateStructureSteps(model, model.metamodel);
		const progress: Progress[] = [];
		const perStep: number[] = [];
		let last = 0;
		let next = steps.next();
		for (; next.done !== true; next = steps.next()) {
			progress.push(next.value);
			perStep.push(visits - last);
			last = visits;
		}
		perStep.push(visits - last);
		const total = model.elementCount + model.relationshipCount + 1;
		expect(visits).toBe(total - 1);
		expect(Math.max(...perStep)).toBeLessThanOrEqual(2048);
		expect(progress.length).toBeGreaterThanOrEqual(2);
		expect(progress.every((p) => p.total === total)).toBe(true);
		expect(progress.every((p, i) => i === 0 || progress[i - 1]!.done < p.done)).toBe(true);
		expect(progress.at(-1)!.done).toBe(total);

		expectSameStructure(model, next.value, candidateOf(model));
		expectSameStructure(model, liveStructure(model), next.value);
	});

	it('writes no record', () => {
		const { model, doc } = smartCity();
		withDuplicate(model);
		const candidateDoc = structuredClone(doc);
		for (const type of candidateDoc.relationships) type.containment = !type.containment;
		const before = [...model.elements()].map(
			(el) => [el, el.parents, [...el.parents], el.uniq, el.out.length, el.in.length] as const
		);
		const keyTexts = new Map(model.indexes.keyText);
		drain(candidateStructureSteps(model, Metamodel.fromJSON(candidateDoc)));
		for (const [el, parents, contents, uniq, out, into] of before) {
			expect(el.parents).toBe(parents);
			expect(el.parents).toEqual(contents);
			expect(el.uniq).toBe(uniq);
			expect([el.out.length, el.in.length]).toEqual([out, into]);
		}
		expect(model.indexes.keyText).toEqual(keyTexts);
	});
});

describe('validators through a structure that is not the live one', () => {
	const run = (model: Model, structure: Structure) => {
		const mm = model.metamodel;
		return validateScoped(
			model,
			allIds(model),
			new Validators(mm),
			new FacetPatterns(mm),
			null,
			structure
		);
	};
	const stub = (model: Model, over: Partial<Omit<Structure, 'metamodel'>>): Structure => {
		const live = liveStructure(model);
		return {
			metamodel: model.metamodel,
			parentsOf: over.parentsOf ?? ((el) => live.parentsOf(el)),
			groupOf: over.groupOf ?? ((el) => live.groupOf(el)),
			keyOf: over.keyOf ?? ((el) => live.keyOf(el))
		};
	};
	const ofCheck = <T extends { check: string }>(check: string, issues: readonly T[]) =>
		issues.filter((i) => i.check === check);

	it('report no containment issue where the parents are gone', () => {
		const model = family();
		model.connect('Contains', 'd', 'a', 'd-a');
		const live = ofCheck('containment', run(model, liveStructure(model)));
		expect(live.length).toBeGreaterThan(0);
		const cycle = new Set(['a', 'b', 'd'].map((id) => model.getElement(id)));
		const cut = stub(model, {
			parentsOf: (el) => (cycle.has(el) ? [] : el.parents)
		});
		expect(ofCheck('containment', run(model, cut))).toEqual([]);
	});

	it('report a group the structure makes, against its lower-ord member', () => {
		const model = family();
		const [b, c] = [model.getElement('b'), model.getElement('c')];
		expect(ofCheck('uniqueness', run(model, liveStructure(model)))).toEqual([]);
		const paired = stub(model, {
			groupOf: (el) => (el === b || el === c ? [c, b] : null)
		});
		const issues = ofCheck('uniqueness', run(model, paired));
		expect(issues).toHaveLength(1);
		expect(issues[0]!.targetIds).toEqual(['c', 'b']);
	});

	it('report no duplicate the structure does not group', () => {
		const { model } = withDuplicate();
		expect(ofCheck('uniqueness', run(model, liveStructure(model)))).toHaveLength(1);
		expect(ofCheck('uniqueness', run(model, stub(model, { groupOf: () => null })))).toEqual([]);
	});
});
