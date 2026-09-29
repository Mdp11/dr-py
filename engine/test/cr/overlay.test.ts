import { describe, expect, it } from 'vitest';
import { CrOverlay, Model, modelLines, type CrElement, type ElementRec } from '../../src/index.ts';
import { nodeMetamodel } from '../model/fixtures.ts';

/** A 32-bit linear congruential generator: the same sequence on every run. */
function lcg(seed: number): (n: number) => number {
	let state = seed >>> 0;
	return (n) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return Math.floor((state / 2 ** 32) * n);
	};
}

const image = (rec: ElementRec): CrElement => ({
	id: rec.id,
	type_name: rec.typeName,
	properties: rec.props,
	rev: rec.rev
});

/** Eight elements whose state order is not their ids' order: `w2` was deleted and made again, `w5` is gone. */
function working(): Model {
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < 8; i++) {
		model.setProperty(model.createElement('Node', `w${i}`), 'name', `W${i}`);
	}
	model.deleteElement('w2');
	model.deleteElement('w5');
	model.setProperty(model.createElement('Node', 'w2'), 'name', 'W2 again');
	return model;
}

describe('CrOverlay', () => {
	it('iterates as a Python dict after the same sets and pops, at every step', () => {
		for (const seed of [1, 7, 42, 2026, 90210]) {
			const random = lcg(seed);
			const model = working();
			const before = modelLines(model);
			const order = [...model.elements()].map((rec) => rec.id);
			expect(order).toEqual(['w0', 'w1', 'w3', 'w4', 'w6', 'w7', 'w2']);
			const ids = [...order, 'w5', 'n0', 'n1', 'n2', 'n3'];

			const overlay = CrOverlay.elements(model);
			// A Python dict: a set keeps a present key's place, a delete then a set appends.
			const reference = new Map<string, CrElement>();
			for (const rec of model.elements()) reference.set(rec.id, image(rec));
			const everSet = new Set<string>();

			for (let step = 0; step < 400; step++) {
				const id = ids[random(ids.length)]!;
				const label = `seed ${seed}, step ${step}`;
				if (random(5) < 3) {
					const entity: CrElement = {
						id,
						type_name: 'Node',
						properties: { name: `${id} at ${step}` },
						rev: step
					};
					overlay.set(id, entity);
					reference.set(id, entity);
					everSet.add(id);
				} else {
					overlay.delete(id);
					reference.delete(id);
				}

				for (const each of ids) {
					expect(overlay.has(each), `${label}: has ${each}`).toBe(reference.has(each));
					expect(overlay.get(each), `${label}: get ${each}`).toEqual(reference.get(each));
				}
				expect(overlay.touched(), label).toEqual(
					[...reference.keys()].filter((each) => everSet.has(each))
				);
				expect(overlay.deleted(), label).toEqual(order.filter((each) => !reference.has(each)));
			}
			expect(modelLines(model), `seed ${seed}: the working model`).toEqual(before);
		}
	});

	it('answers the working record where nothing is overlaid, and its image under an overlaid entity', () => {
		const model = working();
		const overlay = CrOverlay.elements(model);
		const entity: CrElement = { id: 'w1', type_name: 'Node', properties: {}, rev: 9 };
		overlay.set('w1', entity);
		expect(overlay.get('w1')).toBe(entity);
		expect(overlay.base('w1')).toEqual(image(model.getElement('w1')));
		expect(overlay.get('w3')).toEqual(image(model.getElement('w3')));
		expect(overlay.touched()).toEqual(['w1']);
		// A pop of an id nowhere is nothing, twice over.
		overlay.delete('n9');
		overlay.delete('w3');
		overlay.delete('w3');
		expect(overlay.has('w3')).toBe(false);
		expect(overlay.deleted()).toEqual(['w3']);
		expect(overlay.touched()).toEqual(['w1']);
	});
});
