import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
	Metamodel,
	Model,
	parseJson,
	verifyConsistent,
	type MetamodelDoc,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe } from '../golden/model-steps.ts';

type Fixture = {
	metamodel: MetamodelDoc;
	model_file: string;
	elements: number;
	relationships: number;
	digest: string;
	fingerprint: string;
	indexes: string;
};

it('loads the smart-city example into the state and indexes the oracle holds', () => {
	const fixture = loadFixture<Fixture>('smart_city');
	const file = new URL(`../../../${fixture.model_file}`, import.meta.url);
	const doc = parseJson(readFileSync(file, 'utf-8')) as { [key: string]: Value[] };

	const model = new Model(Metamodel.fromJSON(fixture.metamodel));
	for (const element of doc['elements']!) model.loadElement(element);
	for (const rel of doc['relationships']!) model.loadRelationship(rel);
	model.rebuildIndexes();

	expect(model.elementCount).toBe(fixture.elements);
	expect(model.relationshipCount).toBe(fixture.relationships);
	const seen = observe(model);
	expect(JSON.parse(seen.indexes)).toEqual(JSON.parse(fixture.indexes));
	expect(seen.digest).toBe(fixture.digest);
	expect(seen.fingerprint).toBe(fixture.fingerprint);
	verifyConsistent(model);
});
