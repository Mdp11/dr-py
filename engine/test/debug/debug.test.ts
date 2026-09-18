import { describe, expect, it } from 'vitest';
import { dumpIndexes, Model, shuffleAdjacency, verifyConsistent } from '../../src/index.ts';
import { seededRandom } from '../golden/model-steps.ts';
import { nodeMetamodel } from '../model/fixtures.ts';

function star(): Model {
	const model = new Model(nodeMetamodel());
	model.createElement('Node', 'hub');
	for (let i = 0; i < 8; i++) {
		model.createElement('Node', `n${i}`);
		model.connect(i % 2 ? 'Contains' : 'Refers', 'hub', `n${i}`, `out${i}`);
		model.connect('Refers', `n${i}`, 'hub', `in${i}`);
	}
	return model;
}

describe('shuffleAdjacency', () => {
	it('reorders adjacency without changing anything observable', () => {
		const model = star();
		const before = dumpIndexes(model);
		const order = model.getElement('hub').out.map((rel) => rel.id);
		shuffleAdjacency(model, seededRandom(7));
		expect(model.getElement('hub').out.map((rel) => rel.id)).not.toEqual(order);
		expect(dumpIndexes(model)).toEqual(before);
		verifyConsistent(model);
		// Positions stay right, so removal still finds every edge.
		model.deleteElement('hub');
		expect(model.relationshipCount).toBe(0);
		verifyConsistent(model);
	});
});

describe('verifyConsistent', () => {
	it('accepts a model the boundary maintained', () => {
		expect(() => verifyConsistent(star())).not.toThrow();
	});

	it('names the index a write behind the boundary left stale', () => {
		const model = star();
		model.getElement('n0').props['name'] = 'renamed behind the boundary';
		expect(() => verifyConsistent(model)).toThrow(/differ from a fresh rebuild in: .*roots/);
	});

	it('notices an adjacency array edited by hand', () => {
		const model = star();
		model.getElement('hub').out.reverse();
		expect(() => verifyConsistent(model)).toThrow(/out position of/);
	});
});
