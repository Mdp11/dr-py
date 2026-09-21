import { describe, expect, it } from 'vitest';
import {
	cmpCodePoint,
	drain,
	dumpIndexes,
	Model,
	modelLines,
	nameScore,
	searchScore,
	searchSteps,
	wireElement,
	type Progress
} from '../../src/index.ts';
import { seededRandom } from '../golden/model-steps.ts';
import { nodeMetamodel } from '../model/fixtures.ts';

describe('nameScore', () => {
	it('ranks exact, prefix, word boundary and substring apart', () => {
		expect(nameScore('ab', 'ab')).toBe(1000);
		expect(nameScore('abc', 'ab')).toBe(100);
		expect(nameScore('x ab', 'ab')).toBe(30);
		expect(nameScore('x_ab-y', 'ab')).toBe(30);
		expect(nameScore('xab', 'ab')).toBe(10);
		expect(nameScore('xyz', 'ab')).toBe(0);
	});

	it('finds overlapping occurrences', () => {
		expect(nameScore('baaa', 'aa')).toBe(10);
		expect(nameScore('x aaa', 'aa')).toBe(10);
		expect(nameScore('x aa', 'aa')).toBe(30);
		// The first occurrence fails the boundary; one overlapping it passes.
		expect(nameScore('ba-a-a', 'a-a')).toBe(30);
	});

	it('takes a query that holds non-alphanumerics', () => {
		expect(nameScore('x a.a y', 'a.a')).toBe(30);
		expect(nameScore('xa.a', 'a.a')).toBe(10);
		expect(nameScore('a.ax', 'a.a')).toBe(100);
		expect(nameScore('- a.a\n', 'a.a')).toBe(30);
	});
});

const LETTERS = ['a', 'b', 'c', ' ', '-'];

function randomModel(size: number, seed: number): Model {
	const random = seededRandom(seed);
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < size; i++) {
		const element = model.createElement('Node', `n${Math.floor(random() * 100_000)}-${i}`);
		let name = '';
		for (let n = 1 + Math.floor(random() * 6); n > 0; n--) {
			name += LETTERS[Math.floor(random() * LETTERS.length)];
		}
		model.setProperty(element, 'name', name);
		if (random() < 0.2) model.setProperty(element, 'constructor', 'ab here');
	}
	return model;
}

describe('searchSteps', () => {
	const model = randomModel(3000, 17);

	it('ends a step at least every 512 elements, and its result is a one-shot scoring', () => {
		const reports: Progress[] = [];
		const steps = searchSteps(model, { type: null, query: 'ab', limit: 50, offset: 7 });
		let next = steps.next();
		for (; next.done !== true; next = steps.next()) reports.push(next.value);
		let last = 0;
		for (const { done, total } of reports) {
			if (done < total - 1) expect(done - last).toBeLessThanOrEqual(512);
			last = done;
		}
		expect(reports.length).toBeGreaterThan(5);

		const hits = [...model.elements()]
			.map((element) => ({ element, score: searchScore(element, 'ab', false) }))
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score || cmpCodePoint(a.element.id, b.element.id));
		expect(next.value).toEqual({
			items: hits.slice(7, 57).map(({ element }) => wireElement(element)),
			total: hits.length
		});
	});

	it('drained, it gives the same page', () => {
		const page = drain(searchSteps(model, { type: 'Node', query: 'a', limit: 10, offset: 0 }));
		expect(page.items).toHaveLength(10);
		expect(page.total).toBeGreaterThan(1000);
	});

	it('abandoned midway, it has touched nothing', () => {
		const [lines, dump] = [modelLines(model), dumpIndexes(model)];
		const steps = searchSteps(model, { type: null, query: 'a', limit: 10, offset: 0 });
		steps.next();
		steps.next();
		expect(modelLines(model)).toEqual(lines);
		expect(dumpIndexes(model)).toEqual(dump);
	});
});
