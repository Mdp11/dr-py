import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	Model,
	OpError,
	PyFloat,
	shuffleAdjacency,
	verifyConsistent,
	type ModelOp
} from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { observe, seededRandom } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';

const node = (temp_id: string, properties?: ModelOp & object): ModelOp =>
	({ kind: 'create_element', temp_id, type_name: 'Node', ...properties }) as ModelOp;

describe('ids', () => {
	it('keeps a created entity under its temp id when no idFor is given', () => {
		const model = new Model(nodeMetamodel());
		const res = applyBatch(model, [
			node('tmp_a'),
			node('tmp_b'),
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Refers',
				source_id: 'tmp_a',
				target_id: 'tmp_b'
			},
			{ kind: 'update_element', id: 'tmp_a', properties_patch: { peer: 'tmp_b' } }
		]);
		expect([...res.idMap]).toEqual([
			['tmp_a', 'tmp_a'],
			['tmp_b', 'tmp_b'],
			['tmp_r', 'tmp_r']
		]);
		expect(model.getRelationship('tmp_r').source.id).toBe('tmp_a');
		expect(model.getElement('tmp_a').props).toEqual({ peer: 'tmp_b' });
		verifyConsistent(model);
	});

	it('asks idFor once per minted entity, in op order, and never for a hinted or reinstated one', () => {
		const model = new Model(nodeMetamodel());
		const asked: string[] = [];
		const idFor = (tempId: string) => (asked.push(tempId), `real-${asked.length}`);
		applyBatch(
			model,
			[node('tmp_a'), { ...node('tmp_b'), id: 'given' } as ModelOp, node('exact'), node('tmp_c')],
			{ restore: true, idFor }
		);
		expect(asked).toEqual(['tmp_a', 'tmp_c']);
		expect([...model.elements()].map((e) => e.id)).toEqual(['real-1', 'given', 'exact', 'real-2']);
	});
});

describe('property bags', () => {
	it('takes a create op without properties', () => {
		const model = new Model(nodeMetamodel());
		applyBatch(model, [node('tmp_a')]);
		expect(model.getElement('tmp_a').props).toEqual({});
	});

	it('carries __proto__ and constructor as plain keys through create, patch and inverse', () => {
		const model = new Model(nodeMetamodel());
		const properties = JSON.parse('{"__proto__": "p", "constructor": "c"}');
		const created = applyBatch(model, [
			{ kind: 'create_element', temp_id: 'tmp_a', type_name: 'Node', properties }
		]);
		const element = model.getElement('tmp_a');
		expect(Object.keys(element.props)).toEqual(['__proto__', 'constructor']);
		expect(Object.getPrototypeOf(element.props)).toBe(Object.prototype);
		const patch = JSON.parse('{"__proto__": null, "constructor": "d"}');
		const patched = applyBatch(model, [
			{ kind: 'update_element', id: 'tmp_a', properties_patch: patch }
		]);
		expect(Object.keys(element.props)).toEqual(['constructor']);
		applyBatch(model, patched.inverseOps(), { restore: true });
		expect(Object.entries(element.props)).toEqual([
			['constructor', 'c'],
			['__proto__', 'p']
		]);
		applyBatch(model, created.inverseOps(), { restore: true });
		expect(model.elementCount).toBe(0);
	});

	it.each([
		['a property name', { '0': 'x' }],
		['a key inside a value', { name: { deep: [{ '42': 1 }] } }]
	])('refuses an array-index key: %s', (_, properties) => {
		const model = new Model(nodeMetamodel());
		applyBatch(model, [node('tmp_a')]);
		const before = observe(model);
		const key = Object.keys(properties)[0] === '0' ? '0' : '42';
		const detail = `Property key '${key}' is an array index, which cannot keep its place in insertion order`;
		for (const op of [
			{ kind: 'create_element', temp_id: 'tmp_b', type_name: 'Node', properties },
			{ kind: 'update_element', id: 'tmp_a', properties_patch: properties },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Refers',
				source_id: 'tmp_a',
				target_id: 'tmp_a',
				properties
			}
		] as ModelOp[]) {
			const error = thrown(() => applyBatch(model, [node('tmp_c'), op]));
			expect(error).toBeInstanceOf(OpError);
			expect(error).toMatchObject({ status: 422, detail });
		}
		expect(observe(model)).toEqual(before);
	});

	it('keeps a float a float and leaves a value holding a temp id inside a dict alone', () => {
		const model = new Model(nodeMetamodel());
		applyBatch(model, [
			node('tmp_a'),
			{
				kind: 'update_element',
				id: 'tmp_a',
				properties_patch: { name: [new PyFloat(1), { at: 'tmp_a' }, ['tmp_a']] }
			}
		]);
		expect(model.getElement('tmp_a').props['name']).toEqual([
			new PyFloat(1),
			{ at: 'tmp_a' },
			['tmp_a']
		]);
	});
});

describe('a refused batch leaves no trace', () => {
	it('puts back revs and the place of every entity a cascade took', () => {
		const model = family();
		const random = seededRandom(7);
		const before = observe(model);
		const error = thrown(() =>
			applyBatch(model, [
				{ kind: 'update_element', id: 'c', properties_patch: { name: 'changed', peer: 'a' } },
				{ kind: 'delete_element', id: 'a' },
				node('tmp_new'),
				{ kind: 'delete_element', id: 'ghost' }
			])
		);
		expect(error).toMatchObject({ status: 422, detail: "No element with id 'ghost" });
		shuffleAdjacency(model, random);
		expect(observe(model)).toEqual(before);
		expect(model.containerOf('d')).toBe('b');
		verifyConsistent(model);
	});

	it('also when something other than the model refuses', () => {
		const model = family();
		const before = observe(model);
		const boom = new Error('boom');
		const idFor = () => {
			throw boom;
		};
		expect(
			thrown(() =>
				applyBatch(model, [{ kind: 'delete_element', id: 'b' }, node('tmp_x')], { idFor })
			)
		).toBe(boom);
		expect(observe(model)).toEqual(before);
		verifyConsistent(model);
	});
});
