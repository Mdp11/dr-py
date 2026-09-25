import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	cmpCodePoint,
	Metamodel,
	Model,
	OpError,
	verifyConsistent,
	type ModelOptions
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { workingCopy } from '../working/helpers.ts';
import { RandomOps } from '../working/random-ops.ts';
import { nodeMetamodel } from './fixtures.ts';

/** `Part` keyless; `Slot` keyed by `code` and its `Feeds` both ways; `Owns` a containment. */
const metamodel = Metamodel.fromJSON(loadFixture<StepsFixture>('ops_churn').metamodel);

/** The cached key texts by element id, sorted. */
const cachedTexts = (model: Model) =>
	[...model.indexes.keyText]
		.map(([element, text]) => [element.id, text] as const)
		.sort(([a], [b]) => cmpCodePoint(a, b));

/** The key texts a rebuild from the entities computes, in place: none is carried over. */
function freshTexts(model: Model) {
	model.rebuildIndexes();
	return cachedTexts(model);
}

/**
 * Random batches over a model, then staged and unstaged over it, so that
 * entities come back at their old places: after each, every cached text is
 * what a rebuild computes. `shared` is the most texts cached at once.
 */
function churn(seed: number, options: ModelOptions, checked: 'checked' | 'uncached' = 'checked') {
	const random = seededRandom(seed);
	const model = new Model(metamodel, options);
	const ops = new RandomOps(random);
	let shared = 0;
	const check = (i: number) => {
		shared = Math.max(shared, model.indexes.keyText.size);
		if (checked === 'uncached') return;
		expect(cachedTexts(model), `batch ${i}`).toEqual(freshTexts(model));
		verifyConsistent(model);
	};
	const attempt = (run: () => unknown) => {
		try {
			run();
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
		}
	};
	for (let i = 0; i < 40; i++) {
		attempt(() => applyBatch(model, ops.batch(model)));
		check(i);
	}
	const wc = workingCopy(model);
	for (let i = 40; i < 80; i++) {
		attempt(() => (i % 4 < 3 ? wc.stage(ops.batch(model)) : wc.unstage('all')));
		check(i);
	}
	return { model, shared };
}

describe('cached key texts', () => {
	it.each([1, 2, 3])('seed %i: equal a fresh key after random churn', (seed) => {
		expect(churn(seed, {}).shared).toBeGreaterThan(1);
	});

	it.each([1, 2, 3])(
		'seed %i: stay fresh when every key hashes alike, so every rekey keeps its bucket',
		(seed) => {
			const { model } = churn(seed, { hashKey: () => 0 });
			// One bucket: every element is cached.
			expect(model.indexes.keyText.size).toBe(model.elementCount);
		}
	);

	it('follow a property edit, a re-parenting and a key relationship under one hash', () => {
		const model = new Model(metamodel, { hashKey: () => 0 });
		const [p1, p2, s1] = [
			model.createElement('Part', 'p1'),
			model.createElement('Part', 'p2'),
			model.createElement('Slot', 's1')
		];
		model.createElement('Slot', 's2');
		const texts = () => cachedTexts(model);
		const fresh = () => freshTexts(model);
		model.setProperty(s1, 'code', 1);
		expect(texts()).toEqual(fresh());
		model.connect('Owns', 'p1', 'p2', 'o1');
		expect(texts()).toEqual(fresh());
		model.connect('Owns', 'p1', 's2', 'o2');
		model.connect('Feeds', 's1', 's2', 'f1');
		expect(texts()).toEqual(fresh());
		model.disconnect('o1');
		model.deleteProperty(s1, 'code');
		expect(texts()).toEqual(fresh());
		expect(model.indexes.uniqGroupOf(p1)).toEqual([p1, p2]);
		model.deleteElement('s2');
		expect(texts()).toEqual(fresh());
		verifyConsistent(model);
	});

	it('are dropped when a bucket is back to one member', () => {
		const model = new Model(nodeMetamodel());
		const a = model.createElement('Node', 'a');
		const b = model.createElement('Node', 'b');
		const c = model.createElement('Node', 'c');
		model.setProperty(c, 'name', 'c');
		expect(model.indexes.keyText.size).toBe(2);
		expect(model.indexes.uniqGroupOf(a)).toEqual([a, b]);
		model.setProperty(b, 'name', 'b');
		expect(model.indexes.keyText.size).toBe(0);
		model.setProperty(b, 'name', 'c');
		expect(cachedTexts(model).map(([id]) => id)).toEqual(['b', 'c']);
		model.deleteElement('c');
		expect(model.indexes.keyText.size).toBe(0);
		expect(model.indexes.uniqGroupOf(b)).toEqual([b]);
		verifyConsistent(model);
	});

	it.each([1, 2])('seed %i: give uniqGroupOf the groups the uncached texts give', (seed) => {
		const { model } = churn(seed, { hashKey: () => 0 }, 'uncached');
		const ids = (elements: Iterable<{ id: string }>) =>
			[...elements].map((element) => element.id).sort(cmpCodePoint);
		const elements = [...model.elements()];
		const groups = elements.map((element) => ids(model.indexes.uniqGroupOf(element)));
		const fresh = new Map(freshTexts(model));
		elements.forEach((element, i) => {
			const text = fresh.get(element.id);
			const uncached = elements.filter((other) => fresh.get(other.id) === text);
			expect(groups[i], element.id).toEqual(ids(uncached));
		});
	});
});
