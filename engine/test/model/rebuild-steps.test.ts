import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	dumpIndexes,
	Metamodel,
	Model,
	OpError,
	parseJson,
	shuffleAdjacency,
	verifyConsistent,
	type MetamodelDoc,
	type Progress,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { clone } from '../working/helpers.ts';
import { RandomOps } from '../working/random-ops.ts';
import { family } from './fixtures.ts';

function smartCity(): Model {
	const fixture = loadFixture<{ metamodel: MetamodelDoc; model_file: string }>('smart_city');
	const file = new URL(`../../../${fixture.model_file}`, import.meta.url);
	const doc = parseJson(readFileSync(file, 'utf-8')) as { [key: string]: Value[] };
	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	for (const element of doc['elements']!) model.loadElement(element);
	for (const rel of doc['relationships']!) model.loadRelationship(rel);
	model.rebuildIndexes();
	return model;
}

/** A model grown by random batches until it holds `size` entities. */
function grown(seed: number, size: number): Model {
	const model = new Model(Metamodel.fromJSON(loadFixture<StepsFixture>('ops_churn').metamodel));
	const random = seededRandom(seed);
	const ops = new RandomOps(random, 'tmp_grow');
	let minted = 0;
	while (model.elementCount + model.relationshipCount < size) {
		try {
			applyBatch(model, ops.batch(model), { idFor: () => `g-${++minted}` });
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
		}
	}
	return model;
}

let big: Model | undefined;
const thousands = () => (big ??= grown(11, 3000));

const MODELS: [string, () => Model][] = [
	['family', family],
	['smart-city', smartCity],
	['a grown model', thousands]
];

describe('the index build in steps', () => {
	// Growing the model of thousands takes seconds alone, more beside the rest of the suite.
	it.each(MODELS)('%s: builds what the one-shot build builds', { timeout: 20_000 }, (_, make) => {
		const model = make();
		shuffleAdjacency(model, seededRandom(3));
		const reference = clone(model);
		const reports: Progress[] = [];
		const steps = model.rebuildIndexSteps();
		for (let next = steps.next(); next.done !== true; next = steps.next()) reports.push(next.value);

		expect(dumpIndexes(model)).toEqual(dumpIndexes(reference));
		verifyConsistent(model);

		const total = 2 * model.elementCount + model.relationshipCount + 1;
		expect(reports.at(-1)).toEqual({ done: total, total });
		let last = 0;
		for (const report of reports) {
			expect(report.total).toBe(total);
			expect(report.done).toBeGreaterThanOrEqual(last);
			if (report.done < total - 1) expect(report.done - last).toBeLessThanOrEqual(1024);
			last = report.done;
		}
	});

	it('spans several steps on a model of thousands', () => {
		let count = 0;
		const steps = thousands().rebuildIndexSteps();
		while (steps.next().done !== true) count++;
		expect(count).toBeGreaterThan(5);
	});
});
