import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	Model,
	parseJson,
	rewind,
	shuffleAdjacency,
	verifyConsistent,
	type ModelOp
} from '../../src/index.ts';
import { observe, seededRandom } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';

/** Lands `ops`, rewinds them, and expects the model to stand exactly where it stood. */
function landAndRewind(model: Model, ops: ModelOp[]): void {
	const random = seededRandom(11);
	const before = observe(model);
	const result = applyBatch(model, ops);
	expect(observe(model)).not.toEqual(before);
	verifyConsistent(model);
	shuffleAdjacency(model, random);
	rewind(model, result);
	expect(observe(model)).toEqual(before);
	verifyConsistent(model);
}

describe('rewinding a landed batch', () => {
	it('undoes property writes where the records are, revs included', () => {
		const model = family();
		const a = model.getElement('a');
		landAndRewind(model, [
			{ kind: 'update_element', id: 'a', properties_patch: { name: null, peer: 'c' } },
			{ kind: 'update_element', id: 'a', properties_patch: { name: 'again' } }
		]);
		expect(model.getElement('a')).toBe(a);
		expect(a.rev).toBe(1);
	});

	it('puts a cascade back in its place: elements, relationships, owners', () => {
		const model = family();
		landAndRewind(model, [{ kind: 'delete_element', id: 'a' }]);
		expect([...model.elements()].map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
		expect([...model.relationships()].map((r) => r.id)).toEqual(['a-b', 'b-d', 'a-c']);
		expect(model.containerOf('d')).toBe('b');
	});

	it('removes what the batch created, entities created over a deleted id included', () => {
		const model = family();
		landAndRewind(model, [
			{ kind: 'delete_relationship', id: 'a-c' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Refers',
				source_id: 'c',
				target_id: 'a',
				id: 'a-c'
			},
			{ kind: 'delete_element', id: 'd' },
			{ kind: 'create_element', temp_id: 'tmp_d', type_name: 'Node', id: 'd' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_s',
				type_name: 'Contains',
				source_id: 'tmp_d',
				target_id: 'c'
			}
		]);
		expect(model.getRelationship('a-c').source.id).toBe('a');
	});

	it('brings back an element whose type the metamodel does not have', () => {
		const model = new Model(nodeMetamodel());
		model.loadElement(parseJson('{"id":"old","type_name":"Gone","properties":{"k":1},"rev":5}'));
		model.loadElement(parseJson('{"id":"n","type_name":"Node","properties":{},"rev":0}'));
		model.loadRelationship(
			parseJson(
				'{"id":"r","type_name":"AlsoGone","source_id":"old","target_id":"n","properties":{},"rev":2}'
			)
		);
		model.rebuildIndexes();
		landAndRewind(model, [{ kind: 'delete_element', id: 'old' }]);
	});

	it('rewinds batch after batch, newest first', () => {
		const model = family();
		const before = observe(model);
		const first = applyBatch(model, [
			{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: { name: 'E' } },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Contains',
				source_id: 'd',
				target_id: 'tmp_e'
			}
		]);
		const second = applyBatch(model, [
			{ kind: 'update_element', id: 'tmp_e', properties_patch: { peer: 'a' } },
			{ kind: 'delete_element', id: 'b' }
		]);
		expect(model.findElement('tmp_e')).toBeUndefined();
		rewind(model, second);
		expect(model.containerOf('tmp_e')).toBe('d');
		rewind(model, first);
		expect(observe(model)).toEqual(before);
		verifyConsistent(model);
	});
});
